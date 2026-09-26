<!-- walkthrough.md -->
<!-- v2 - 26-09-2026 - Add fast Mac handoff evidence and explicit runtime limits -->

# Ally desktop verification

The existing transport runtime, automatic home-relative path resolution, CommonJS preload, sandbox/context isolation, encrypted multiple-connection store, shared logger/Doctor, start error states, and pre-teardown shutdown protection were already present. No production runtime or gameplay code was changed.

## Differences from the handoff

- Actual Bridge repository: `C:\Game mods\Zomboid\Knox Relay Bridge`.
- Actual Connector repository: `C:\Game mods\Zomboid\Knox Relay Connector`.
- There was no `release/win-unpacked` application in this checkout initially.
- The built-in smoke test assumes a missing PZ user folder. Added a separate repeatable packaged test for the real, idle filesystem.
- Bridge documentation still described hash-only web credentials; corrected it to match the existing encrypted recovery implementation.
- The local installed Connector is already 0.10.0 and every source file matches the installed copy. This is installation evidence, not a gameplay pass.

## Paths detected on this machine

- PZ user data: `C:\Users\timho\Zomboid`.
- Automatically resolved exchange: `C:\Users\timho\Zomboid\Lua\KnoxRelay`.
- Ready-to-open package: `C:\Game mods\Zomboid\Knox Relay Bridge\release\win-unpacked\Knox Relay Bridge.exe`.

These paths are observations only. Production path resolution still uses the current user's home and existing override precedence.

## Verification

- `npm.cmd test`: 32/32 pass, including TypeScript compilation, portability, encrypted-store abstraction, redaction, retry, startup failure, preload, and shutdown guards.
- `npm.cmd run desktop:pack`: Windows x64 unpacked Electron package built successfully.
- `node scripts/smoke-packaged.mjs --real-pz`: three packaged launches pass with an isolated profile and Windows-only child PATH (no external Node/npm).
- Real UI actions: add two connections; navigate Overview/Debug/Settings; rename; close/reopen; verify persistence; Start; Debug; Doctor; Stop; Start again; close while Running; reopen with both connections Offline.
- The real OS encryption service stores the test token without plaintext in either metadata or secret files; successful Start after restart proves decryption works.
- Doctor reports all checks OK, including PZ root and exchange read/write access. Runtime reaches Running on the automatic path.
- Debug records start, resolved root, automatic source, watched queue, initialization, intentional local HTTP 503/retry, and stop. Running represents the active local engine, not production connectivity.
- All seven queue directories exist after initialization. Existing exchange files are byte-for-byte unchanged; no gameplay/telemetry fixtures are written there.
- No uncaught renderer exception, destroyed-object shutdown error, or leftover Bridge process was observed.

The test server intentionally returns HTTP 503 to verify offline/retry visibility without production traffic. Logs and JSON results are retained under ignored `temp/packaged-smoke-*/`.

## Next manual check

No local Bridge filesystem or packaging blocker was found. Tim can double-click the packaged EXE, use the intended saved/imported Network connection, and start PZ when ready. Actual backend authentication, live telemetry, mission behavior, and the pending Mission Pack v0.2/Phase 6B gates remain unverified in this task. PZ was never launched; nothing was deployed, committed, or pushed.

No `.bat` or `.command` launcher was added: the standalone package already supplies the one-click normal-user workflow. Keep the complete `win-unpacked` directory together. macOS DMG/app verification still requires macOS.

## Subsequent Mac handoff

- Tried `electron-builder --mac dir --x64 --arm64` using installed 26.15.3. It explicitly rejects Windows-to-macOS packaging. Installed `@electron/universal` also rejects non-Darwin hosts, so no universal artifact was attempted or claimed.
- Added `BUILD KNOX RELAY BRIDGE.command` as a one-time builder, not a launcher. It detects Intel/Apple Silicon hardware, including Rosetta, checks Node/npm, offers the official Node LTS installer page, runs dependency installation and native unpacked packaging, checks the resulting executable/ASAR, reveals the app, and retains readable failure output.
- Added `scripts/package-mac-source.mjs` and development-only `yazl` dependency. Generated `release/Knox Relay Bridge Source.zip` with a strict source allowlist and Unix mode 0755/LF for the helper. Central-directory assertions and independent `tar -tvf` both verify executable metadata. Send this ZIP unchanged.
- Shell syntax passed. Eight mocked shell cases passed: missing Node, missing npm, old Node, install failure, packaging failure, missing app, Intel success, and Apple Silicon/Rosetta success. These simulate branches and do not substitute for a Mac build.
- Existing Bridge tests still pass 32/32. Production transport/security code is unchanged. Mac build, Archive Utility extraction, Gatekeeper, Keychain/safeStorage, and launch remain for Rodi to verify on macOS.
- Expected Mac output is `release/mac/Knox Relay Bridge.app` (x64) or `release/mac-arm64/Knox Relay Bridge.app` (arm64), relative to the extracted source folder. No Mac architecture artifact has yet been produced here.
