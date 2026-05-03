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

global.XStorage = new (require("./libs/fs/Storage"))(config.app_dir + "/" + config.data_dir + "/files/");
global.XDB = new (require("./libs/DB"))(config.app_dir + "/" + config.data_dir + "/db");
const SyncServer = require("./libs/server");
const SyncCleanup = require("./libs/SyncCleanup");
const AnySocket = require("anysocket");

(async () => {
    await XStorage.init();
    const syncServer = new SyncServer(config);
    const cleanup = new SyncCleanup(config);

    // Add dashboard route for the server
    syncServer.server.http.get("/dashboard", (peer) => {
        peer.serveFile(config.app_dir + "/client/dashboard.html", "text/html");
    });
    syncServer.server.http.get("/api/peers", async (peer) => {
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
        const path = peer.url;
        const parts = path.split('/');
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
        const walk = (dir) => {
            let files = [];
            fs.readdirSync(dir).forEach(file => {
                const fullPath = path.join(dir, file);
                if (fs.statSync(fullPath).isDirectory()) {
                    files = files.concat(walk(fullPath));
                } else {
                    files.push(fullPath.replace(config.app_dir + "/data/files/", ""));
                }
            });
            return files;
        };
        const files = walk(config.app_dir + "/data/files/");
        peer.status(200).header("Content-Type", "application/json").body(JSON.stringify(files)).end();
    });

    syncServer.server.http.get(new RegExp("/api/delete-file/(.*)"), (peer) => {
        const path = decodeURIComponent(peer.url.split('/api/delete-file/')[1]);
        const fullPath = config.app_dir + "/data/files/" + path;
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
            peer.status(200).body("Deleted").end();
        } else {
            peer.status(404).body("File not found").end();
        }
    });
})();