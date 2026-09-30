<!-- docs/PROTOCOL.md -->
<!-- v6 - 27-09-2026 - Telemetry snapshot and open knox_ missions (envelope) -->

# Protocol version 1

PZ writes `game-to-bridge/pending/<messageId>.json` containing `connector_test` and `hello from Project Zomboid`.

The Bridge posts:

```json
{
  "protocolVersion": 1,
  "connectorVersion": "0.1.0",
  "message": "hello from Project Zomboid"
}
```

It accepts only:

```json
{
  "ok": true,
  "protocolVersion": 1,
  "message": "hello from Knox Relay"
}
```

It then writes `bridge-to-game/pending/ack_<messageId>.json`:

```json
{
  "protocolVersion": 1,
  "messageId": "ack_evt_...",
  "replyTo": "evt_...",
  "type": "connector_test_ack",
  "createdAt": "2026-09-23T12:00:01.000Z",
  "payload": { "ok": true, "message": "hello from Knox Relay" }
}
```

## Latest game telemetry

PZ overwrites `game-to-bridge/telemetry/current.json` about every ten seconds while at least one player is connected. The local message contains `protocolVersion`, `messageId`, `type: game_telemetry`, `createdAt`, and a payload with structured game time plus 1–32 player identity/coordinate records.

Connector 0.13.0+ adds an optional `payload.snapshot` about once a minute: a world/player summary for the mission engine (`schemaVersion`, `world`, `players`, `capabilities`). The Bridge checks it as a bounded envelope only (plain JSON, at most 64 KB, depth 8, strings up to 1,000 characters, lists up to 256 entries, simple keys; `src/protocol/KnoxEnvelope.ts`) and forwards it unchanged. The backend validates the content.

The Bridge validates exact fields, adds configured `networkId` and `connectorVersion`, and POSTs with `Content-Type: application/json` and `X-Knox-Connector-Token`. The backend response must be `{ "ok": true, "protocolVersion": 1, "messageId": "evt_..." }` for the same message ID.

Unknown fields, versions/types, malformed dates, empty player arrays, invalid names, and non-finite/out-of-range coordinates fail closed.

## Mission delivery

The Bridge posts authenticated `pull` requests to `knoxMissionSync`. The backend answers with one pending mission or `null`. After validation, the Bridge atomically writes `bridge-to-game/pending/mission_<missionId>.json` and tells the backend it is locally queued. Existing pending or processed files suppress recreation. PZ writes a strict `mission_received_ack` into `game-to-bridge/pending`; the Bridge then archives both files.

Accepted mission ids:

- `mission_v0_*` (curated) and `mission_v02_recon_*` (dynamic recon): `visit_area` missions with exact-key checks (`validateMission` in `src/protocol/KnoxValidators.ts`). Always `missionVersion` 1.
- `knox_*` (open missions): envelope checks only, see below.

The Phase 4–6B test missions `test_001`–`test_007` were retired in Bridge 0.2.5 and are rejected like any unknown id.

`missionId` identifies the logical mission and `missionVersion` identifies its payload revision, so a newer revision can be told apart from a duplicate.

## Open missions (`knox_` ids, Bridge 0.2.4+)

Missions whose id matches `knox_[a-z0-9_]{1,96}` come from the mission engine and use the open mission format. The Bridge checks the envelope only: `protocolVersion` 1, the id, an integer `missionVersion` (1–100,000), a `title` of 1–120 characters, and plain bounded JSON (at most 32 KB, depth 10). The Connector validates and interprets the content. Their `mission_completed` and `mission_declined` events may carry any `missionVersion` from 1 and an `objectiveType` of lowercase letters and underscores. All older mission ids keep their exact checks.

**Index (Bridge 0.2.5+).** PZ Lua cannot list a folder, so the Bridge keeps `bridge-to-game/pending/knox_missions.json` up to date: `{ "protocolVersion": 1, "missionIds": ["knox_...", ...] }`, sorted, at most 64 ids, one per `mission_knox_*.json` file waiting in that folder. It is rewritten atomically after each poll when the list changed or the file is missing. The Connector (builds after 0.14.1) reads the index, then each listed mission file.
