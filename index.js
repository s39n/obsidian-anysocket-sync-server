// TODO: - IDEA: Backups/Snapshots every X time
// TODO: - IDEA: Server settings in Obsidian
// TODO: - IDEA: Server commands in Obsidian (cleanup)

const fs = require("fs");
const path = require("path");
if(!fs.existsSync("./config.js")) {
    console.log("Required \"./config.js\" is missing!\n");

    console.log("If you are running docker, you should mount the config.js")
    console.log("docker command: docker run \
-v ${PWD}/config.js:/app/config.js \
-v ${PWD}/data:/app/data \
-p 3000:3000 \
--rm \
lynxaegon/obsidian-anysocket-sync-server\n");

    console.log("\n\"./config.js\" example:\n", fs.readFileSync("./config.example.js", "utf8"));
    return process.exit(-1);
}
const config = require("./config");
config.app_dir = __dirname;
config.data_dir = "data";

const Helpers = require("./libs/helpers");
const util = require("util");

// In-memory log ring buffer — captured before any other require that might log
const logBuffer = [];
function formatArgs(args) {
    return args.map(a => typeof a === 'string' ? a : util.inspect(a, { depth: 3, breakLength: Infinity })).join(' ');
}
function pushLog(prefix, args) {
    logBuffer.push(`[${new Date().toISOString()}]${prefix} ${formatArgs(args)}`);
    if (logBuffer.length > 200) logBuffer.shift();
}
const _origLog = console.log;
console.log = (...args) => { _origLog(...args); pushLog('', args); };
const _origError = console.error;
console.error = (...args) => { _origError(...args); pushLog(' [ERROR]', args); };
const _origWarn = console.warn;
console.warn = (...args) => { _origWarn(...args); pushLog(' [WARN]', args); };

global.XStorage = new (require("./libs/fs/Storage"))(config.app_dir + "/" + config.data_dir + "/files/");
global.XDB = new (require("./libs/DB"))(config.app_dir + "/" + config.data_dir + "/db");
const SyncServer = require("./libs/server");
const SyncCleanup = require("./libs/SyncCleanup");
const AnySocket = require("anysocket");

(async () => {
    await XStorage.init();
    const syncServer = new SyncServer(config);
    const cleanup = new SyncCleanup(config);

    const DASHBOARD_TOKEN = Helpers.getSHA(config.password + "-dashboard");
    const FILES_BASE = path.resolve(config.app_dir, "data", "files");

    // Read the dash_token cookie from request headers without using peer.cookies,
    // which has a side-effect that overwrites _cookies and leaks request cookies
    // back as Set-Cookie headers on every response.
    function getDashCookie(peer) {
        const cookieStr = peer.query.headers['cookie'] || '';
        const result = {};
        cookieStr.split(';').forEach(part => {
            const [k, ...v] = part.trim().split('=');
            if (k) result[k.trim()] = decodeURIComponent(v.join('='));
        });
        return result['dash_token'];
    }

    function checkAuth(peer) {
        if (getDashCookie(peer) !== DASHBOARD_TOKEN) {
            peer.status(401).header("Content-Type", "application/json")
                .body(JSON.stringify({ error: "Unauthorized" })).end();
            return false;
        }
        return true;
    }

    syncServer.server.http.get("/dashboard", (peer) => {
        peer.serveFile(config.app_dir + "/client/dashboard.html", "text/html");
    });

    // Password is sent as a request header to avoid it appearing in server logs / browser history.
    syncServer.server.http.get("/api/login", (peer) => {
        const password = peer.query.headers['x-dashboard-password'];
        if (password === config.password) {
            const expires = Date.now() + 7 * 24 * 60 * 60 * 1000;
            peer.setCookie('dash_token', DASHBOARD_TOKEN, expires)
                .status(200).header("Content-Type", "application/json")
                .body(JSON.stringify({ ok: true })).end();
        } else {
            peer.status(401).header("Content-Type", "application/json")
                .body(JSON.stringify({ error: "Invalid password" })).end();
        }
    });

    syncServer.server.http.get("/api/logs", (peer) => {
        if (!checkAuth(peer)) return;
        peer.status(200).header("Content-Type", "text/plain")
            .body(logBuffer.join('\n') || 'No logs yet').end();
    });

    syncServer.server.http.get("/api/devices", (peer) => {
        if (!checkAuth(peer)) return;
        const connectedIds = new Set(
            syncServer.getPeerList().map(p => p.data?.id).filter(Boolean)
        );
        const devices = XDB.devices.list().map(id => ({
            id,
            lastOnline: XDB.devices.get(id, "last_online"),
            connected: connectedIds.has(id)
        }));
        peer.status(200).header("Content-Type", "application/json")
            .body(JSON.stringify(devices)).end();
    });

    syncServer.server.http.get("/api/peers", async (peer) => {
        if (!checkAuth(peer)) return;
        const peers = await Promise.all(syncServer.getPeerList().map(async p => {
            const lastOnline = p.data.id ? await XDB.devices.get(p.data.id, "last_online") : null;
            return {
                id: p.id,
                data: p.data,
                lastOnline: lastOnline
            };
        }));
        peer.status(200).header("Content-Type", "application/json").body(JSON.stringify(peers)).end();
    });

    syncServer.server.http.get(new RegExp("/api/action/(.*)/(.*)"), (peer) => {
        if (!checkAuth(peer)) return;
        const parts = peer.url.split('/');
        const action = parts[3];
        const peerId = parts[4];

        const targetPeer = syncServer.getPeerList().find(p => p.id === peerId);
        if (!targetPeer) {
            peer.status(404).body(JSON.stringify({ error: "Peer not found" })).end();
            return;
        }

        if (action === 'disconnect') {
            targetPeer.disconnect("Disconnected by admin");
        } else if (action === 'trigger-sync') {
            targetPeer.send({ type: "sync" });
        }
        peer.status(200).body(JSON.stringify({ success: true })).end();
    });

    syncServer.server.http.get("/api/files", (peer) => {
        if (!checkAuth(peer)) return;
        const walkDir = config.app_dir + "/data/files/";
        const walk = (dir) => {
            let files = [];
            fs.readdirSync(dir).forEach(file => {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    files = files.concat(walk(fullPath));
                } else {
                    files.push({
                        path: fullPath.replace(walkDir, ""),
                        size: stat.size,
                        mtime: stat.mtime
                    });
                }
            });
            return files;
        };
        const files = walk(walkDir);
        peer.status(200).header("Content-Type", "application/json").body(JSON.stringify(files)).end();
    });

    // DELETE method prevents accidental deletion via browser link prefetch / GET caching.
    syncServer.server.http.delete(new RegExp("/api/delete-file/(.*)"), (peer) => {
        if (!checkAuth(peer)) return;
        const relativePath = decodeURIComponent(peer.url.replace('/api/delete-file/', ''));
        const fullPath = path.resolve(FILES_BASE, relativePath);
        const rel = path.normalize(path.relative(FILES_BASE, fullPath));
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            peer.status(400).header("Content-Type", "application/json")
                .body(JSON.stringify({ error: "Invalid path" })).end();
            return;
        }
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
            peer.status(200).header("Content-Type", "application/json")
                .body(JSON.stringify({ ok: true })).end();
        } else {
            peer.status(404).header("Content-Type", "application/json")
                .body(JSON.stringify({ error: "File not found" })).end();
        }
    });
})();
