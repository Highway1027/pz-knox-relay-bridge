<!-- docs/PROTOCOL.md -->
<!-- v5 - 24-09-2026 - Version the Phase 5A mission display payload -->

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
