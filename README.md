<!-- README.md -->
<!-- v8 - 25-09-2026 - Document strict Phase 6B area mission transport -->

# Knox Relay Bridge

Transport-only companion for the private Knox Relay Project Zomboid server. It retains the proven ping/telemetry paths and polls one authenticated Network for five fixed versioned test missions. It strictly validates the test_005 deliver_items requirements, reward, and explicit test-fixture metadata, but contains no acceptance, completion, inventory, or reward authority.

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

Phase 4 also requires `missionSyncEndpoint`; the example points to `knoxMissionSync`.

## Runtime status

The Phase 2 manual gate expects:

```text
[PZ->BRIDGE] connector_test evt_...
[HTTP] Knox Relay ONLINE
[BRIDGE->PZ] connector_test_ack evt_...
[Knox Relay] Backend replied: hello from Knox Relay
```

Phase 4 passed in real B42.20.4: delivery, PZ acknowledgement, restart deduplication, and repeated-action deduplication were verified. Phase 5B generalizes that same transport only enough for fixed test_001 through test_004; PZ server Lua remains the sole completion and reward authority.
## Phase 6B area fixtures

Mission transport accepts the fixed `test_006` and `test_007` schemas, including a strict radius-20 `deliveryArea` snapshot. The Bridge validates bounded integer coordinates and writes the validated mission unchanged through the existing atomic local queue. It does not choose locations, teleport players, or infer map safety. The `test_007` `X + 200` target is deterministic development data only and may contain unusable terrain.
