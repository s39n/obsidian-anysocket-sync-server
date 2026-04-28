# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run tests
node test.js

# Start the server (requires config.js)
node index.js

# Docker build
docker build -t sync-server .
```

There is no linter configured. No build step — this is plain Node.js.

To run a specific test scenario, the test suite in `test.js` runs all tests sequentially in one pass; individual tests cannot be run in isolation without editing the file.

## Configuration

Copy `config.example.js` to `config.js` before starting the server. The config is required at startup — the server exits immediately if it's missing. Key config fields: `password`, `port`, `host`, optional `certs` (enables HTTPS-only mode; when absent, plain WS is used), `logs.level` (0–3), and `cleanup` settings.

## Architecture

### Data flow

Clients connect over WebSocket (or HTTPS if certs are configured) using the `anysocket` library. Authentication is HMAC-style: the server challenges with its UUID; the client hashes `id[0:16] + password + id[16:]` and the server validates the same formula.

After connecting, a client must call `setDeviceId` RPC within 5 seconds or gets disconnected. Once identified, sync proceeds via message types: `sync`, `file_event`, `file_data`, `file_history`.

### Sync protocol (last-write-wins via `mtime`)

- **`sync`**: client sends its full file list with metadata; server compares each entry and queues upload/download requests via `onFileEvent`. Sync completes when `peer.data.files` (a map of in-flight paths) drains to zero.
- **`file_event`**: single-file comparison. Returns `"client_newer"` (server requests upload or applies delete), `"server_newer"` (server pushes its copy), or `null` (no change).
- **`file_data`**: actual file content transfer. `type: "send"` = client requesting a file from server; `type: "apply"` = pushing content to server, which then broadcasts to all other connected peers with `autoSync: true`.
- **`file_history`**: version listing and point-in-time reads.

### Storage layout (`data/files/`)

Each file is stored as a directory:
```
data/files/<vault-path>/
  metadata          ← JSON: { path, action, sha1, mtime, type }
  <mtime>           ← file content at that version (text or binary)
  <mtime>           ← older versions kept up to cleanup.versions_per_file
```

Folders (type `"folder"`) only have metadata, no content versions. Deleted files retain their metadata with `action: "deleted"` until cleanup runs.

`Storage` (`libs/fs/Storage.js`) is the high-level interface used by the server. `FSAdapter` (`libs/fs/FSAdapter.js`) is the raw filesystem layer — all paths are validated against `basePath` to prevent traversal.

### Cleanup (`libs/SyncCleanup.js`)

Runs on a cron schedule. Trims old versions per file down to `versions_per_file`. Permanently removes deleted-file entries only when: (a) `keep_deleted_files_time` has elapsed since deletion AND (b) the oldest `last_online` timestamp across all known devices is newer than the deletion time (ensuring all devices have synced the delete).

### Global state

`XStorage` and `XDB` are set as `global.*` in `index.js` and used directly throughout. `peerList` is a module-level array in `server.js` tracking connected, identified peers.

### Client auto-update

`onVersionCheck` RPC compares the client's version/build against `client/build_info.json` (cached at server startup). If mismatched, the server responds with the full content of `main.js`, `styles.css`, and `manifest.json` for the client to self-update.
