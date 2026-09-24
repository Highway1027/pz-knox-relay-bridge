<!-- docs/ARCHITECTURE.md -->
<!-- v4 - 24-09-2026 - Add Phase 4 mission pull and local acknowledgement -->

# Architecture

```text
Project Zomboid server Lua
        <-> local files
Knox Relay Bridge
        <-> HTTPS
Knox Relay backend/webapp
```

The Bridge owns transport only. Project Zomboid owns physical truth and gameplay authority; the webapp owns narrative. The Bridge never evaluates objectives, consumes items, grants rewards, changes sandbox settings, or invents telemetry.

## Local boundary

The exchange root is `%USERPROFILE%/Zomboid/Lua/KnoxRelay`. PZ writes and closes a known-name JSON document. The Bridge waits for file stability, validates it, and uses temporary-file-plus-rename for atomic responses. Malformed local input moves to `failed`.

## HTTPS delivery

The Bridge maps `connector_test` to the versioned backend ping. Requests are asynchronous and abort after `httpTimeoutMs`. A timeout, network error, non-2xx status, or invalid response leaves the source event in `pending`. Retries use exponential delay capped by `retryMaxMs`.

Only a validated response permits the Bridge to atomically write the PZ acknowledgement and archive the source event. This is at-least-once HTTP delivery; this ping is stateless, while later mutating endpoints must deduplicate by stable message ID.

## Failure isolation

PZ never waits for either the Bridge or HTTP. Backend failure affects only Bridge retry state. Expected outages use concise logs without stack traces.

Mission polling uses the same bounded HTTP timeout and capped retry backoff. A mission is acknowledged to the backend only after its local file exists. PZ never contacts the backend; its local acknowledgement lets the Bridge archive the file.

## Telemetry coalescing

Telemetry is current state rather than an immutable event. PZ atomically replaces one logical snapshot file. A failed Bridge send is retried with capped backoff, but a newer PZ snapshot supersedes it immediately. Successful message IDs are suppressed for the life of the Bridge process; a restart may harmlessly resend the latest snapshot because the backend replaces `gameTelemetry/current`. Durable mission/event messages will continue to use the separate pending/processed queue.
