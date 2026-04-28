const cron = require("node-cron");

module.exports = class SyncCleanup {
    constructor(config) {
        this.config = config;
        this.keepDeletedMs = config.cleanup.keep_deleted_files_time * 1000;
        this.setup();
    }

    // https://crontab.guru/
    setup() {
        cron.schedule(this.config.cleanup.schedule, async () => {
            await this.run();
        });
        this.run();
    }

    async run() {
        let allDevicesLastOnline = this.findMinLastOnline();
        let items = await XStorage.iterate();

        // make sure all devices are synced before deleting
        let now = (new Date()).getTime();
        for(let item of items) {
            try {
                let metadata = await XStorage.readMetadata(item);
                switch (metadata.action) {
                    case "created":
                        let versions = await XStorage.iterateVersions(item);
                        let deleteableVersions = versions.slice(this.config.cleanup.versions_per_file);
                        for (let item of deleteableVersions) {
                            await XStorage.delete(item.path);
                        }
                        break;
                    case "deleted":
                        if (metadata.mtime + this.keepDeletedMs < now && allDevicesLastOnline > metadata.mtime) {
                            await XStorage.delete(item);
                        }
                        break;
                }
            }
            catch(e) {
                console.log("[Error SyncCleanup]", e);
            }
        }
    }

    findMinLastOnline() {
        const devices = XDB.devices.list();
        if (devices.length === 0) {
            return Infinity;
        }

        let minLastOnline = Infinity;
        for (let id of devices) {
            const lastOnline = XDB.devices.get(id, "last_online") || 0;
            if (lastOnline < minLastOnline) {
                minLastOnline = lastOnline;
            }
        }
        return minLastOnline;
    }
}