<!-- IMPLEMENTATION_PLAN.md -->
<!-- v3 - 23-09-2026 - Mark Phase 2 passed and Phase 3 prepared -->

# Knox Relay bridge implementation plan

## Delivery gates

Work advances one tested phase at a time. Each phase ends with changed files grouped by workspace root, static/build results, and a short manual runtime test. Do not begin the next phase until Tim reports the runtime result.

1. Phase 0: inspect B42.20 file APIs and document the exchange constraints.
2. Phase 1: prove the offline PZ-to-Bridge-to-PZ local message round trip.
3. Phase 2: after explicit deployment approval, prove the HTTPS ping round trip.
4. Phase 3: minimal coalesced live telemetry, dedicated backend ingest, and verified-data web panel.
5. Later phases: test mission, mission panel, `deliver_items`, then rewards.

Phases 1 and 2 passed in B42.20. Phase 3 implementation is prepared and stops before deployment/runtime approval. No mission gameplay or rewards are included.

## Strict workspace ownership

### `wildshape-tracker`

Only Knox Relay webapp/backend files belong here: Cloud Functions, Firestore integration, frontend components/services, backend protocol validation, and connector-status UI.

Never place PZ Lua, Bridge source/config/logs/build output, extracted game classes, mod probes, or PZ research artifacts in this root. Web/backend scratch work may use `wildshape-tracker/temp/` only when it genuinely concerns that root.

### `Knox Relay Connector`

Only PZ mod-side files belong here: Lua server/client/shared code, manifests, gameplay/UI, local PZ protocol code, PZ install/test helpers, PZ documentation, and PZ/JAR/mod scratch work under `temp/`.

Never place Node/TypeScript Bridge code or Firebase/webapp code in this root.

### `Knox Relay Bridge`

Only the external transport application belongs here: Node/TypeScript source, queue I/O, HTTPS transport, retry/offline behavior, config, logs, tests, packaging scripts, Bridge documentation, and Bridge experiments under `temp/`.

Never place PZ Lua/gameplay code or Firebase/webapp code in this root.

## Temporary files

Scratch files follow the same ownership boundaries. Remove obsolete probes before closing each phase. Runtime queue files and logs are generated data, are gitignored, and live outside source trees where configured.

## Cross-project protocol

Each participating root documents protocol version 1 independently and remains understandable/buildable alone. Small protocol constants and validators may be duplicated. Source files are never shared by placing one project's implementation inside another root.
