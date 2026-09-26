<!-- docs/DESKTOP.md -->
<!-- v3 - 26-09-2026 - Document safe shutdown and actionable startup failures -->

# Desktop Bridge

## Architecture

Electron's main process owns connection persistence, OS-backed token encryption, Bridge engine instances, Doctor execution, and narrow IPC handlers. The sandboxed, context-isolated `desktop/preload.cjs` CommonJS preload exposes only required operations through `contextBridge`; it is copied unchanged into the packaged ASAR. The renderer is dependency-light HTML/CSS/JavaScript and has no Node access. Each active connection uses the existing `KnoxSyncEngine`, `KnoxApiClient`, queue, validators, config resolver, and Doctor functions.

The renderer checks for `window.knox` before initialization. A missing or failed preload produces a visible fatal screen instead of an apparently functional but inert interface.

Closing the application stops every active engine. There is no tray/background mode in v1. Duplicate starts are rejected. A failed start remains visible as an error state.

Runtime phases are Offline, Starting, Running, Error, and Stopping. Preflight logging is subscribed before token/path/filesystem checks, so failures remain associated with the selected connection in Debug. `lastError` is retained for actionable detail and a failed connection can be started again after correction.

Window close stops runtimes before renderer teardown. Log forwarding checks both `BrowserWindow.isDestroyed()` and `webContents.isDestroyed()` and becomes a no-op during shutdown; late in-flight transport logs may continue to stdout but never target a dead renderer. Repeated stop/close calls are idempotent.

## State and secrets

Electron `app.getPath("userData")` contains:

- `connections.json`: names, Network IDs, endpoints, optional exchange overrides, timestamps;
- `secrets.json`: only `safeStorage`-encrypted token blobs.

There is deliberately no plaintext fallback when secure storage is unavailable. The renderer receives metadata and status, never raw saved tokens. The shared logger redacts secret-named context fields and known token values before console or renderer delivery.

## Webapp integration requirement

The webapp should continue storing only the connector-token hash. Immediately after token generation or rotation it should offer the exact import object containing `telemetryEndpoint`, `missionSyncEndpoint`, `networkId`, and the one-time plaintext `connectorToken`. After refresh, the setup panel should show “Connector token: Configured” and require Rotate/Generate New Token before it can produce another complete setup JSON. It must not attempt to recover or persist the plaintext token in Firestore.

The desktop import parser is isolated from persistence and runtime startup so a future one-time pairing-code exchange can produce the same normalized imported-connection object without changing the rest of the application.

## Status semantics

“Running” means the local engine initialized and its polling lifecycle is active. Backend online/offline changes only after real transport evidence. Last telemetry, last mission sync, and player count remain “Unknown” until corresponding runtime events are observed.

## Packaging

Electron Builder is configured for NSIS on Windows, DMG on macOS, and AppImage on Linux. `npm run desktop:pack` creates an unpacked unsigned development application. Platform installers should normally be built on their target OS.

Before public distribution: add production icons and metadata, configure code-signing identities, notarize macOS output, test clean-machine installation/update/uninstall, publish privacy/support information, and establish a signed update/release process.

## Manual test checklist

1. Start with no desktop state; open the app and confirm the empty Connections screen.
2. Paste malformed JSON and verify a friendly validation error.
3. Paste the current webapp setup JSON, name it, validate, and save.
4. Restart the app and confirm metadata persists and no token is displayed.
5. Confirm `connections.json` has no token and `secrets.json` has no plaintext token.
6. Add a second connection and confirm both appear independently.
7. Start one connection with PZ's user-data root absent; verify actionable error and no fake root creation.
8. With the PZ root present, start and stop a connection; verify duplicate start is prevented.
9. Generate local telemetry/mission activity during an approved PZ test and verify only real status/timestamps/player counts appear.
10. Exercise Debug auto-scroll, pause/resume, clear, copy, and level filtering.
11. Put a known token in a forced error/context and verify it appears only as `[REDACTED]`.
12. Run Doctor from connection detail and compare it with `npm run doctor` checks.
13. Rename, set/clear an exchange override, replace a token, and restart the connection.
14. Detect and import legacy `config.json`; confirm the original file is unchanged.
15. Remove a connection and confirm both metadata and encrypted secret disappear.
16. Close the app while a connection runs and confirm no Bridge process remains.
17. Build an unpacked app and smoke-test it on clean Windows and macOS accounts.
