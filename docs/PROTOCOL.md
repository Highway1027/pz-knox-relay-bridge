<!-- docs/PROTOCOL.md -->
<!-- v3 - 23-09-2026 - Add strict Phase 3 game telemetry -->

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
