<!-- IMPLEMENTATION_PLAN.md -->
<!-- v6 - 24-09-2026 - Split Phase 5 display and gameplay-authority proofs -->

# Knox Relay bridge implementation plan

## Delivery gates

Work advances one tested phase at a time. Each phase ends with changed files grouped by workspace root, static/build results, and a short manual runtime test. Do not begin the next phase until Tim reports the runtime result.

1. Phase 0: inspect B42.20 file APIs and document the exchange constraints.
2. Phase 1: prove the offline PZ-to-Bridge-to-PZ local message round trip.
3. Phase 2: after explicit deployment approval, prove the HTTPS ping round trip.
4. Phase 3: minimal coalesced live telemetry, dedicated backend ingest, and verified-data web panel.
5. Phase 4: fixed test-mission web-to-PZ transport proof.
6. Phase 5A: PZ-owned durable mission cache and read-only native client panel.
7. Phase 5B: explicit-recipient, server-authoritative, idempotent vanilla-item grant proof.
8. Later phases: real mission mechanics, Drop Box, and rewards.

Phases 1–4 passed in real B42.20.4 multiplayer. Phase 5A is implemented only to its
deployment/install gate and still requires real runtime confirmation. Phase 5B must not
begin before that confirmation. No mission mechanics or rewards are included.

Phase 5B will use an explicit stable B42.20.4 recipient identity from the first one-player
test, never "the only connected player." Offline recipients remain pending and must never
fall back to another player. `test_reward_001` and `test_reward_002` remain separate,
immutable idempotency tests. Exact identity/item APIs will be verified before implementation.

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
