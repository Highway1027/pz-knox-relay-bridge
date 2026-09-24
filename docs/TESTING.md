<!-- docs/TESTING.md -->
<!-- v3 - 23-09-2026 - Define Phase 3 telemetry runtime gate -->

# Testing

`npm test` verifies the Phase 2 transport plus telemetry POST association/authentication, retry recovery, and stale-snapshot coalescing.

## Manual B42.20.4 telemetry gate

1. After deployment approval, configure the exact telemetry endpoint, selected Network ID, and token in ignored `config.json`.
2. Install the current Connector, start the Bridge, then start the B42.20.4 coop server.
3. Join and move; confirm Bridge logs `game_telemetry` and `telemetry accepted`.
4. Confirm `knoxRelayFiles/{networkId}/gameTelemetry/current` changes and the web panel shows the same character and coordinates.
5. Move again and confirm the one current document updates; connect the second player and confirm both appear.
6. Briefly make `telemetryEndpoint` unreachable. Confirm gameplay continues and retry logs remain concise; restore it and confirm the newest snapshot succeeds.

Do not begin missions until Tim confirms this gate.
