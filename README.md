<!-- README.md -->
<!-- v3 - 23-09-2026 - Document Phase 3 coalesced game telemetry -->

# Knox Relay Bridge

Transport-only companion for the private Knox Relay Project Zomboid server. It retains the proven connector ping and posts the latest validated Project Zomboid telemetry snapshot to one configured Knox Network. It contains no gameplay authority.

## Setup

```powershell
npm install
Copy-Item config.example.json config.json
npm test
npm run dev
```

The default exchange root is `%USERPROFILE%\Zomboid\Lua\KnoxRelay`.

## Reliability

- asynchronous Node `fetch` with a five-second default timeout;
- capped exponential retry from two to sixty seconds;
- failed sends stay in `game-to-bridge/pending`;
- input moves to `processed` only after a valid backend response and atomic PZ acknowledgement;
- expected outages produce concise offline/retry logs.
- telemetry uses one overwriteable `game-to-bridge/telemetry/current.json` slot, so an outage retains the newest snapshot without accumulating stale positions.

## Phase 3 configuration

Set `telemetryEndpoint`, `networkId`, and `connectorToken` in ignored `config.json`. `networkId` is the selected `knoxRelayFiles` document ID. The plaintext token remains local; only its SHA-256 hash belongs in that Network's `connectorTokenHash` field.

## Current stop point

The Phase 2 manual gate expects:

```text
[PZ->BRIDGE] connector_test evt_...
[HTTP] Knox Relay ONLINE
[BRIDGE->PZ] connector_test_ack evt_...
[Knox Relay] Backend replied: hello from Knox Relay
```

Phase 3 is prepared but `knoxTelemetryIngest` must not be deployed without explicit approval. Do not begin missions until the real B42.20.4 telemetry gate passes.
