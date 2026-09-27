// desktop/launcher.cjs
// v1 - 27-09-2026 - Stable entry point: loads the newest verified drop-in code, else the built-in code

// This file, updater-core.cjs and update-public-key.pem are the only parts that need an app
// rebuild to change. Everything else (dist/, desktop/preload.cjs, desktop/renderer/) can arrive
// as a signed update ZIP installed from Settings.

"use strict";

const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const core = require("./updater-core.cjs");

// Same override main.js honours, applied before any path is resolved.
if (process.env.KNOX_SMOKE_USER_DATA) app.setPath("userData", process.env.KNOX_SMOKE_USER_DATA);

const builtInRoot = app.getAppPath();
const builtInVersion = JSON.parse(fs.readFileSync(path.join(builtInRoot, "package.json"), "utf8")).version;
const codeRoot = path.join(app.getPath("userData"), "app-code");
const publicKeyPem = fs.readFileSync(path.join(__dirname, "update-public-key.pem"), "utf8");
const notes = [];
const log = (message) => { notes.push(message); console.log(`[Knox Relay Bridge] ${message}`); };

const selected = core.selectCodeRoot({ codeRoot, builtInRoot, builtInVersion, publicKeyPem, log });

// Read by main.js (the updatable code) for paths, the Settings version line and update install.
globalThis.knoxLauncher = {
  apiVersion: core.LAUNCHER_API_VERSION,
  codeRoot: selected.root,
  version: selected.version,
  source: selected.source,
  builtInVersion,
  notes,
  markHealthy() { if (selected.source === "update") core.markHealthy(codeRoot, selected.version); },
  installUpdate(file) {
    fs.mkdirSync(codeRoot, { recursive: true });
    return core.installUpdate(file, { codeRoot, publicKeyPem, activeVersion: selected.version });
  },
  revertToBuiltIn() { core.revertToBuiltIn(codeRoot); },
};

async function load(root) {
  await import(pathToFileURL(path.join(root, "dist", "src", "desktop", "main.js")).href);
}

load(selected.root).catch(async (error) => {
  console.error("[Knox Relay Bridge] Failed to load code:", error);
  if (selected.source !== "update") { app.quit(); return; }
  // A broken update never locks the player out: block it and run the built-in code.
  core.blockVersion(codeRoot, selected.version);
  log(`Update ${selected.version} failed to load; running built-in ${builtInVersion}.`);
  Object.assign(globalThis.knoxLauncher, { codeRoot: builtInRoot, version: builtInVersion, source: "built-in" });
  try { await load(builtInRoot); } catch (fallbackError) { console.error(fallbackError); app.quit(); }
});
