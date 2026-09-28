---
name: bridge-release
description: Release a new Knox Relay Bridge version - tests, version bump, merge develop to main so GitHub signs and publishes it, rebuild the local Windows app and confirm the update arrives. Use when Tim asks to release or ship the Bridge.
---

# Bridge release

Only with Tim's OK.

1. **Checks**: `npm test` (unset `ELECTRON_RUN_AS_NODE` first). All must pass.
2. **Version**: raise `version` in `package.json` (patch for fixes, minor for features). Update the Bridge line in the Connector `docs/STATUS.md`.
3. **Commit** on `develop`: `Bridge <version>: <what changed>`, push.
4. **Release**: merge `develop` into `main` and push. `release.yml` tests, signs and publishes the GitHub Release (only when the version has no release yet). Check the run: `gh run list --workflow release.yml --limit 1`, then `gh release view v<version>`.
5. **Local app**: `npm run desktop:pack`, then `node scripts/smoke-packaged.mjs --real-pz` (PZ and other Bridges closed). Leave `release/win-unpacked/Knox Relay Bridge.exe` ready.
6. **Confirm the update**: an installed Bridge (Tim's, or Rodi's Mac) should show the new version after its update check. Ask Tim to confirm; note the result in the Connector `docs/SESSION_HISTORY.md` at wrap-up.
7. If the protocol changed, the Connector and backend must be compatible in the same order: say which goes first (usually backend, then Bridge, then Connector).
