<!-- docs/TESTING.md -->
<!-- v7 - 26-09-2026 - Document first-run configuration workflow -->

# Testing

`npm test` verifies the Phase 2 transport plus telemetry POST association/authentication, retry recovery, and stale-snapshot coalescing.

## Manual B42.20.4 telemetry gate

1. After deployment approval, run `npm start` and enter the selected Network ID and token in the first-run wizard, or supply the documented environment variables.
2. Install the current Connector, start the Bridge, then start the B42.20.4 coop server.
3. Join and move; confirm Bridge logs `game_telemetry` and `telemetry accepted`.
4. Confirm `knoxRelayFiles/{networkId}/gameTelemetry/current` changes and the web panel shows the same character and coordinates.
5. Move again and confirm the one current document updates; connect the second player and confirm both appear.
6. Briefly make `telemetryEndpoint` unreachable. Confirm gameplay continues and retry logs remain concise; restore it and confirm the newest snapshot succeeds.

## Phase 4 gate

Start Bridge and B42.20.4, then use Network Settings → Connector Setup → Send Test Mission to PZ. Confirm the Bridge logs mission receipt/queue and PZ logs `Mission received: test_001 - Connector Test Mission`. Confirm PZ's acknowledgement moves both local files to processed. Restart Bridge/PZ and confirm the mission is not recreated or logged forever.

Do not begin native mission UI or gameplay until Tim confirms this gate.

Runtime result: passed on B42.20.4, including full Bridge/PZ restart and repeated web-action deduplication. Phase 4 is complete.

## Phase 5A preparation

`npm test` must confirm that mission version 1 and the fixed objective text are required
before any mission file is written. Rebuild and restart the Bridge after this schema change.
The real native-panel/reconnect/restart gate is documented in the Connector repository.
