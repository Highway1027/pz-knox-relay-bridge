<!-- docs/ARCHITECTURE.md -->
<!-- v6 - 26-09-2026 - Add Electron shell around shared transport runtime -->

# Architecture

The Electron desktop shell is an orchestration layer, not a second transport implementation. Its main process creates existing `KnoxSyncEngine` instances from securely stored connection profiles, forwards structured sanitized logs over context-isolated IPC, and reuses the same Doctor functions as CLI mode. The renderer has no Node integration or gameplay authority. Closing the app stops all engine timers.

```text
Project Zomboid server Lua
        <-> local files
Knox Relay Bridge
        <-> HTTPS
Knox Relay backend/webapp
```

The Bridge owns transport only. Project Zomboid owns physical truth and gameplay authority; the webapp owns narrative. The Bridge never evaluates objectives, consumes items, grants rewards, changes sandbox settings, or invents telemetry.

## Local boundary

The automatic exchange root is `path.join(os.homedir(), "Zomboid", "Lua", "KnoxRelay")`, using the platform path implementation. `KNOX_EXCHANGE_ROOT`, then the local `exchangeRoot` (or legacy `exchangeDirectory`) field, can override it. PZ writes and closes a known-name JSON document. The Bridge waits for file stability, validates it, and uses temporary-file-plus-rename for atomic responses. Malformed local input moves to `failed`.

## HTTPS delivery

The Bridge maps `connector_test` to the versioned backend ping. Requests are asynchronous and abort after `httpTimeoutMs`. A timeout, network error, non-2xx status, or invalid response leaves the source event in `pending`. Retries use exponential delay capped by `retryMaxMs`.

Only a validated response permits the Bridge to atomically write the PZ acknowledgement and archive the source event. This is at-least-once HTTP delivery; this ping is stateless, while later mutating endpoints must deduplicate by stable message ID.

## Failure isolation

PZ never waits for either the Bridge or HTTP. Backend failure affects only Bridge retry state. Expected outages use concise logs without stack traces.

Mission polling uses the same bounded HTTP timeout and capped retry backoff. A mission is acknowledged to the backend only after its local file exists. PZ never contacts the backend; its local acknowledgement lets the Bridge archive the file.

## Telemetry coalescing

Telemetry is current state rather than an immutable event. PZ atomically replaces one logical snapshot file. A failed Bridge send is retried with capped backoff, but a newer PZ snapshot supersedes it immediately. Successful message IDs are suppressed for the life of the Bridge process; a restart may harmlessly resend the latest snapshot because the backend replaces `gameTelemetry/current`. Durable mission/event messages will continue to use the separate pending/processed queue.
