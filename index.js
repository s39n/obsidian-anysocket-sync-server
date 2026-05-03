// TODO: - IDEA: Backups/Snapshots every X time
// TODO: - IDEA: Server settings in Obsidian
// TODO: - IDEA: Server commands in Obsidian (cleanup)

const fs = require("fs");
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
    syncServer.server.http.get("/api/peers", (peer) => {
        const peers = syncServer.getPeerList().map(p => ({
            id: p.id,
            data: p.data
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
            // Note: Triggers sync via internal RPC call or message
            targetPeer.send({ type: "sync" });
        }
        peer.status(200).body(JSON.stringify({ success: true })).end();
    });
})();