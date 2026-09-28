# Knox Relay Bridge

Rules and context for every AI coding agent (Claude Code, Antigravity, Codex). This is the single source; tool-specific files only point here.

**Start of a session:** read `D:\Game mods\Zomboid\Knox Relay Connector\docs\STATUS.md`. Knox status, plan (`docs/KNOX_PROJECT_PLAN.md`) and history live in the Connector repo for all Knox parts.

## What this repo is

Electron desktop app (TypeScript) that carries messages between Project Zomboid's local exchange files (`<home>/Zomboid/Lua/KnoxRelay`) and the Knox backend over HTTPS. **Transport only**: it validates and relays, but owns no gameplay, mission, location or reward decisions (those belong to the Connector and the backend). Users: Tim (Windows) and Rodi (Mac).

Other parts: Connector (PZ Lua, gameplay authority) in `D:\Game mods\Zomboid\Knox Relay Connector`; webapp and backend in `D:\Webapps\wildshape-tracker`.

## Commands

| What | Command |
| --- | --- |
| Tests | `npm test` (unset `ELECTRON_RUN_AS_NODE` in VS Code terminals first) |
| Desktop dev | `npm run desktop` |
| Windows package | `npm run desktop:pack` → `release/win-unpacked/Knox Relay Bridge.exe` |
| Packaged smoke test | `node scripts/smoke-packaged.mjs --real-pz` (close PZ and other Bridges first) |
| Doctor | `npm run doctor` |
| Mac source zip | `node scripts/package-mac-source.mjs` → `release/Knox Relay Bridge Source.zip` |

On PowerShell with scripts disabled use `npm.cmd` instead of `npm`.

## Rules

- **Strict validation.** Protocol validators (`src/protocol/`) use exact-key checks and bounded envelopes. A new field from the Connector or backend needs a validator change and a test here first.
- **Secrets.** Never commit or print `config.json`, connector tokens or exchange files. Tokens are stored with Electron `safeStorage`; no plaintext fallback. The update signing private key exists only on Tim's PC and never enters the repo or logs.
- **HTTPS only** for backend endpoints; unknown backends need user confirmation.
- **Updates.** The launcher (`desktop/launcher.cjs`) is stable and never updates itself; it loads the newest verified, signed code. Keep `desktop/updater-core.cjs` on Node built-ins only.
- **After meaningful desktop changes** rebuild `release/win-unpacked` and leave the exe ready to double-click; run the packaged smoke test.
- **Mac**: send `release/Knox Relay Bridge Source.zip` unchanged (keeps the executable bit); never re-zip with Explorer. Later versions reach Rodi as automatic updates.
- Add or update tests in `tests/` for every behaviour change.

## Git and releases

- Work on `develop`. A release is: raise `version` in `package.json`, merge `develop` into `main`. `.github/workflows/release.yml` then tests, signs and publishes a GitHub Release when the version is new; installed apps update themselves. Only with Tim's OK. Use the `bridge-release` skill.
- Commit messages carry the details; no file version headers needed (leave existing ones alone).
- `IMPLEMENTATION_PLAN.md` and `walkthrough.md` are old, git-ignored local notes; the Connector plan supersedes them.

## Focus, skills, writing

- At session start name the top open Knox items. When a new idea comes up mid-task, ask **"Now, or park it in the backlog?"** (small same-area fixes excepted); parked ideas go to the Inbox in the Connector `docs/STATUS.md`.
- Skills: `bridge-release` (here), `pz-debug` and `knox-wrap-up` (point to the Connector's). Fix a skill as soon as it proves wrong; propose one when a routine repeats.
- Tim prefers plain English, short sentences, dates as DD-MM-YYYY.

## Docs

`README.md` (setup, config, reliability), `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md` (local file protocol and HTTPS), `docs/DESKTOP.md` (security, lifecycle, packaging), `docs/TESTING.md`.
