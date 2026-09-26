<!-- README.md -->
<!-- v14 - 26-09-2026 - Add ready-to-share Mac source ZIP and one-time native builder -->

# Knox Relay Bridge

Transport-only companion between the local Knox Relay Connector exchange and the Knox backend. Gameplay, mission, inventory, completion, and reward authority remain in Project Zomboid and the backend—not in this Bridge.

## Desktop Application

The normal end-user experience is the Electron desktop app: saved connections, pasted webapp setup JSON, in-app start/stop, live Debug logs, Doctor, and per-connection settings.

Packaged users double-click `Knox Relay Bridge.exe` on Windows or `Knox Relay Bridge.app` on macOS. Packaged applications bundle Electron/Node and do not require npm, Node, a batch file, or Terminal.

On Windows, open `release/win-unpacked/Knox Relay Bridge.exe`. Keep the entire `win-unpacked` directory together; the EXE uses the bundled resources beside it. Development commands:

```bash
npm install
npm run desktop
```

Desktop state lives in Electron's OS-specific `userData` directory, outside this repository. `connections.json` contains non-secret metadata. Connector tokens are encrypted with Electron `safeStorage` before being written separately to `secrets.json`. If OS encryption is unavailable, saving or reading a token fails explicitly; there is no plaintext fallback.

Accepted setup JSON:

```json
{
  "telemetryEndpoint": "https://...",
  "missionSyncEndpoint": "https://...",
  "networkId": "...",
  "connectorToken": "..."
}
```

Optional compatible fields are `name`, `syncEndpoint`, `exchangeRoot`, and legacy `exchangeDirectory`. The desktop Settings screen can detect and explicitly import an existing project-local `config.json`; the source file is never modified or deleted.

## Quick Start

```bash
git clone <bridge-repository-url>
cd pz-knox-relay-bridge
npm install
npm start
```

Follow the first-run setup to enter the Network ID and connector token supplied by the Knox Network manager. The token is masked and stored only in ignored `config.json`. Later runs use `npm start`; its `prestart` lifecycle builds TypeScript automatically.

Project Zomboid must have been started once for the current OS user. The Bridge will not create a fake `Zomboid` root. If that root exists, it safely creates the `Lua/KnoxRelay` queue structure.

## Windows

The normal exchange folder is detected as `<home>\Zomboid\Lua\KnoxRelay`. No username, drive letter, PowerShell, or manual path is required at runtime.

```powershell
npm install
npm start
```

## macOS

For the one-time Mac build, send **`release/Knox Relay Bridge Source.zip` unchanged**. Rodi extracts it with macOS Archive Utility and double-clicks `BUILD KNOX RELAY BRIDGE.command`. The helper checks Node/npm, opens the official Node installer page if needed, installs dependencies, builds the native Intel or Apple Silicon app, and reveals it in Finder. Node/npm are only required to build; afterward open `Knox Relay Bridge.app` directly. See `MAC START HERE.txt`.

Create this shareable archive on Windows with `node scripts/package-mac-source.mjs`. It explicitly preserves Unix executable mode 0755 and LF line endings for the helper. Do not re-ZIP the folder with Explorer. Local configuration, credentials, dependencies, and build output are excluded.

The actual unsigned Windows cross-build attempt (`electron-builder --mac dir --x64 --arm64`) was rejected by Electron Builder 26.15.3: "Build for macOS is supported only on macOS". No Mac `.app` was produced on Windows. The helper instead builds x64 on Intel or arm64 on Apple Silicon (including under Rosetta), without a DMG. Mac runtime verification remains pending.

The normal exchange folder is detected as `<home>/Zomboid/Lua/KnoxRelay`.

```bash
npm install
npm start
```

## Linux

The Bridge supports Node.js and filesystem behavior on Linux and detects `<home>/Zomboid/Lua/KnoxRelay`. Project Zomboid itself must create/use that home-relative user-data folder for the automatic path to apply.

## Diagnostics

```bash
npm run doctor
```

Doctor checks Node, credentials, the PZ folder, exchange readability/writability, and backend configuration. It never prints the connector token. It is diagnostic only and does not contact the backend; credential acceptance is therefore confirmed by normal authenticated Bridge traffic.

## Advanced Configuration

Normal users need only `networkId` and `connectorToken`. Resolution precedence is environment, local config, then automatic detection:

1. `KNOX_EXCHANGE_ROOT`
2. `exchangeRoot` in ignored `config.json` (legacy `exchangeDirectory` is also accepted)
3. the current user's home plus `Zomboid/Lua/KnoxRelay`

Credentials support `KNOX_NETWORK_ID` and `KNOX_CONNECTOR_TOKEN`, which override local config. The backend consists of separate ping, telemetry, and mission endpoints, so there is intentionally no misleading single `KNOX_API_BASE_URL` setting. Existing endpoint fields remain available in advanced local config.

Safe template:

```json
{
  "networkId": "YOUR_NETWORK_ID",
  "connectorToken": "YOUR_CONNECTOR_TOKEN"
}
```

`config.json`, build output, logs, and temporary data are Git-ignored. Never commit a real connector token.

## Reliability

- asynchronous Node `fetch` with a five-second default timeout;
- capped exponential retry from two to sixty seconds;
- failed sends remain pending;
- input archives only after a valid backend response;
- temporary-file-plus-rename writes for local acknowledgements;
- coalesced telemetry retains the newest snapshot during outages;
- queue construction and enumeration use Node `path` and `fs` APIs only.

## Development

```bash
npm test
npm run build
```

CLI mode remains available as `npm start` or `npm run bridge`. Desktop development uses `npm run desktop`.

Unsigned packaging commands:

```bash
npm run desktop:pack
npm run desktop:win
npm run desktop:mac
```

Electron Builder produces output under ignored `release/`. Windows installers should be built on Windows and macOS DMGs on macOS. Public distribution still requires production icons, application signing, Windows reputation handling, Apple Developer ID signing, hardened runtime, and notarization.

After every meaningful desktop change, rebuild with `npm run desktop:pack` and leave the fresh `release/win-unpacked/Knox Relay Bridge.exe` ready to double-click. On Windows PowerShell with script execution disabled, use `npm.cmd` instead of `npm`.

For a repeatable Windows packaged UI check on a machine with an existing, idle PZ user folder:

```bash
node scripts/smoke-packaged.mjs --real-pz
```

This developer-only test launches the packaged EXE three times with an isolated encrypted profile, removes Node/npm from the child PATH, and exercises Add Connection, persistence, navigation, settings, automatic exchange detection, Start/Stop/restart, Debug, Doctor, and close while Running. It uses a local HTTP outage fixture, refuses nonempty live pending/telemetry folders, and verifies existing exchange files are unchanged. Close PZ, Java servers, and other Bridge instances first. Reports are saved under ignored `temp/packaged-smoke-*/`. It never starts PZ and does not prove production authentication or gameplay.

See `docs/DESKTOP.md` for lifecycle, security, pairing, and manual-test details.

The PowerShell helpers under `scripts/` are optional developer conveniences. Normal users open the packaged application directly; no helper scripts are needed.
