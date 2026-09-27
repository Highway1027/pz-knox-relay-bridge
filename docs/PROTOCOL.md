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

## Test mission delivery

The Bridge posts authenticated `pull` requests to `knoxMissionSync`. A pending `missions/test_001` document is mapped to exactly:

```json
{"protocolVersion":1,"missionId":"test_001","missionVersion":1,"title":"Connector Test Mission","status":"active","objective":{"type":"test","text":"Verify Web to Project Zomboid mission transport."}}
```

After strict validation, the Bridge atomically writes `bridge-to-game/pending/mission_test_001.json` and tells the backend it is locally queued. Existing pending or processed files suppress recreation. PZ writes a strict `mission_received_ack` into `game-to-bridge/pending`; the Bridge then archives both files. This phase supports only `test_001`.

`missionId` identifies the logical mission and `missionVersion` identifies its payload
revision. Phase 5A accepts version 1 only; later update delivery can therefore distinguish
a newer revision from a duplicate without changing Phase 4 deduplication.

## Open missions (`knox_` ids, Bridge 0.2.4+)

Missions whose id matches `knox_[a-z0-9_]{1,96}` come from the mission engine and use the open mission format. The Bridge checks the envelope only: `protocolVersion` 1, the id, an integer `missionVersion` (1–100,000), a `title` of 1–120 characters, and plain bounded JSON (at most 32 KB, depth 10). The Connector validates and interprets the content. Their `mission_completed` and `mission_declined` events may carry any `missionVersion` from 1 and an `objectiveType` of lowercase letters and underscores. All older mission ids keep their exact checks.
