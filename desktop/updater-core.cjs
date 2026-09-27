// desktop/updater-core.cjs
// v1 - 27-09-2026 - Signed drop-in code updates: verify, install, select, crash guard (Node built-ins only)

// Part of the launcher: ships inside the app and is never replaced by an update, so a broken
// update can always be replaced by a fixed one. No Electron imports; unit-tested under Node.

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// Raised only when the launcher contract changes; an update declares the lowest it needs.
const LAUNCHER_API_VERSION = 1;
const MANIFEST_FORMAT = 1;
const PRODUCT = "knox-relay-bridge";
const KEEP_VERSIONS = 2;

function compareVersions(left, right) {
  const a = String(left).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = String(right).split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

// Stable bytes for signing: keys sorted at every level.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function signManifest(manifest, privateKeyPem) {
  return crypto.sign(null, Buffer.from(canonicalJson(manifest)), privateKeyPem).toString("base64");
}

function safeRelativePath(name) {
  const normalised = String(name).replace(/\\/g, "/");
  if (normalised === "" || normalised.startsWith("/") || /^[a-zA-Z]:/.test(normalised)) return null;
  if (normalised.split("/").some((part) => part === ".." || part === "")) return null;
  return normalised;
}

// Checks a code folder: signed manifest, supported format and launcher, every listed file intact.
function verifyCodeFolder(directory, publicKeyPem) {
  try {
    const manifestText = fs.readFileSync(path.join(directory, "manifest.json"), "utf8");
    const signature = fs.readFileSync(path.join(directory, "manifest.sig"), "utf8").trim();
    const manifest = JSON.parse(manifestText);
    const signed = crypto.verify(null, Buffer.from(canonicalJson(manifest)), publicKeyPem, Buffer.from(signature, "base64"));
    if (!signed) return { ok: false, reason: "signature does not match the Knox Relay publisher key" };
    if (manifest.format !== MANIFEST_FORMAT || manifest.product !== PRODUCT) return { ok: false, reason: "not a Knox Relay Bridge update" };
    if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) return { ok: false, reason: "invalid version" };
    if (!Number.isInteger(manifest.minLauncher) || manifest.minLauncher > LAUNCHER_API_VERSION) {
      return { ok: false, reason: `needs a newer app (launcher ${manifest.minLauncher}); rebuild the Bridge once` };
    }
    const files = manifest.files && typeof manifest.files === "object" ? manifest.files : null;
    if (!files || !files["dist/src/desktop/main.js"]) return { ok: false, reason: "manifest has no desktop entry point" };
    for (const [name, hash] of Object.entries(files)) {
      const relative = safeRelativePath(name);
      if (!relative) return { ok: false, reason: `unsafe path ${name}` };
      const content = fs.readFileSync(path.join(directory, relative));
      if (sha256(content) !== hash) return { ok: false, reason: `file changed: ${relative}` };
    }
    return { ok: true, manifest };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

// Minimal ZIP reader (stored and deflated entries), enough for update packages.
function readZip(buffer) {
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw new Error("not a ZIP file");
  const count = buffer.readUInt16LE(end + 10);
  let pointer = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error("corrupt ZIP directory");
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString("utf8", pointer + 46, pointer + 46 + nameLength);
    pointer += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("corrupt ZIP entry");
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`unsupported ZIP compression ${method}`);
    entries.push({ name, data });
  }
  return entries;
}

function readJsonOr(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// Removes old installed versions, keeping the active one and the newest KEEP_VERSIONS.
function pruneVersions(codeRoot, activeVersion) {
  const versions = fs.readdirSync(codeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => compareVersions(b, a));
  let kept = 0;
  for (const version of versions) {
    if (version === activeVersion || kept < KEEP_VERSIONS) { kept += 1; continue; }
    fs.rmSync(path.join(codeRoot, version), { recursive: true, force: true });
  }
}

// Installs an update ZIP (or an already-unpacked update folder) into codeRoot/<version>.
function installUpdate(source, { codeRoot, publicKeyPem, activeVersion }) {
  const staging = path.join(codeRoot, `.staging-${crypto.randomBytes(6).toString("hex")}`);
  try {
    fs.mkdirSync(staging, { recursive: true });
    if (fs.statSync(source).isDirectory()) {
      fs.cpSync(source, staging, { recursive: true });
    } else {
      for (const entry of readZip(fs.readFileSync(source))) {
        const relative = safeRelativePath(entry.name);
        if (!relative) throw new Error(`unsafe path in ZIP: ${entry.name}`);
        const target = path.join(staging, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.data);
      }
    }
    // Accept a ZIP that wraps everything in one top-level folder.
    let root = staging;
    if (!fs.existsSync(path.join(root, "manifest.json"))) {
      const children = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
      if (children.length === 1 && fs.existsSync(path.join(root, children[0].name, "manifest.json"))) root = path.join(root, children[0].name);
    }
    const checked = verifyCodeFolder(root, publicKeyPem);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    const version = checked.manifest.version;
    if (activeVersion && compareVersions(version, activeVersion) <= 0) {
      return { ok: false, reason: `version ${version} is not newer than the running ${activeVersion}` };
    }
    const destination = path.join(codeRoot, version);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(root, destination);
    writeJson(path.join(codeRoot, "current.json"), { version });
    const state = readJsonOr(path.join(codeRoot, "launch-state.json"), {});
    if (state.blocked === version) { delete state.blocked; writeJson(path.join(codeRoot, "launch-state.json"), state); }
    pruneVersions(codeRoot, version);
    return { ok: true, version };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// Chooses which code to run: a verified, newer, not-blocked update, or the built-in code.
// Records the attempt; if the previous attempt of that version never reported healthy, it is
// blocked and the built-in code runs instead (crash guard).
function selectCodeRoot({ codeRoot, builtInRoot, builtInVersion, publicKeyPem, log = () => {} }) {
  const builtIn = { root: builtInRoot, version: builtInVersion, source: "built-in" };
  try {
    if (!fs.existsSync(codeRoot)) return builtIn;
    const statePath = path.join(codeRoot, "launch-state.json");
    const state = readJsonOr(statePath, {});
    const current = readJsonOr(path.join(codeRoot, "current.json"), null);
    const version = current && current.version;
    if (!version || compareVersions(version, builtInVersion) <= 0) return builtIn;
    if (state.blocked === version) { log(`Update ${version} is blocked after a failed start; running built-in ${builtInVersion}.`); return builtIn; }
    if (state.attempt === version && state.healthy !== version) {
      writeJson(statePath, { ...state, blocked: version, attempt: undefined });
      log(`Update ${version} did not start correctly last time; running built-in ${builtInVersion}.`);
      return builtIn;
    }
    const directory = path.join(codeRoot, version);
    const checked = verifyCodeFolder(directory, publicKeyPem);
    if (!checked.ok) { log(`Update ${version} rejected: ${checked.reason}; running built-in ${builtInVersion}.`); return builtIn; }
    // Every start must report healthy again, so a version that later breaks still falls back.
    writeJson(statePath, { ...state, attempt: version, healthy: undefined });
    return { root: directory, version, source: "update" };
  } catch (error) {
    log(`Update selection failed (${error instanceof Error ? error.message : String(error)}); running built-in ${builtInVersion}.`);
    return builtIn;
  }
}

function markHealthy(codeRoot, version) {
  try {
    const statePath = path.join(codeRoot, "launch-state.json");
    const state = readJsonOr(statePath, {});
    writeJson(statePath, { ...state, healthy: version });
  } catch { /* nothing to record before the first update */ }
}

function blockVersion(codeRoot, version) {
  try {
    const statePath = path.join(codeRoot, "launch-state.json");
    writeJson(statePath, { ...readJsonOr(statePath, {}), blocked: version });
  } catch { /* best effort */ }
}

// Removes the installed update pointer so the built-in code runs from the next start.
function revertToBuiltIn(codeRoot) {
  fs.rmSync(path.join(codeRoot, "current.json"), { force: true });
}

module.exports = {
  LAUNCHER_API_VERSION, MANIFEST_FORMAT, PRODUCT, compareVersions, canonicalJson, sha256, signManifest,
  safeRelativePath, verifyCodeFolder, readZip, installUpdate, selectCodeRoot, markHealthy, blockVersion, revertToBuiltIn,
};
