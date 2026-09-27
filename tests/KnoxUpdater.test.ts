// tests/KnoxUpdater.test.ts
// v1 - 27-09-2026 - Drop-in update core: signatures, tampering, ZIP safety, versions, crash guard

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const core = require(path.resolve("desktop", "updater-core.cjs"));
const yazl = require("yazl");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const other = generateKeyPairSync("ed25519");
const otherPrivatePem = other.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

type Files = Record<string, string>;
const MAIN = "dist/src/desktop/main.js";

function manifestFor(version: string, files: Files, extra: Record<string, unknown> = {}) {
  const hashes: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) hashes[name] = core.sha256(Buffer.from(content));
  return { format: 1, product: "knox-relay-bridge", version, minLauncher: 1, createdAt: "2026-09-27T00:00:00Z", files: hashes, ...extra };
}

function writeFolder(directory: string, version: string, files: Files, options: { key?: string; manifest?: Record<string, unknown> } = {}) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    writeFileSync(path.join(directory, name), content);
  }
  const manifest = options.manifest ?? manifestFor(version, files);
  writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(path.join(directory, "manifest.sig"), core.signManifest(manifest, options.key ?? privatePem));
}

async function zipOf(directory: string, target: string, prefix = ""): Promise<void> {
  const zip = new yazl.ZipFile();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else zip.addBuffer(readFileSync(full), prefix + path.relative(directory, full).split(path.sep).join("/"));
    }
  };
  walk(directory);
  zip.end();
  const { createWriteStream } = await import("node:fs");
  await new Promise<void>((resolve, reject) => zip.outputStream.pipe(createWriteStream(target)).on("close", () => resolve()).on("error", reject));
}

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "knox-updater-"));
  return { root, codeRoot: path.join(root, "app-code"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const sample: Files = { [MAIN]: "export {};\n", "desktop/preload.cjs": "// preload\n", "desktop/renderer/index.html": "<html></html>\n", "package.json": '{"type":"module"}\n' };

test("versions compare numerically", () => {
  assert.equal(core.compareVersions("0.2.10", "0.2.9"), 1);
  assert.equal(core.compareVersions("0.2.0", "0.2.0"), 0);
  assert.equal(core.compareVersions("0.1.9", "0.2.0"), -1);
});

test("a correctly signed folder verifies; tampering is caught", () => {
  const w = workspace();
  try {
    const folder = path.join(w.root, "good");
    writeFolder(folder, "0.2.1", sample);
    assert.equal(core.verifyCodeFolder(folder, publicPem).ok, true);

    writeFileSync(path.join(folder, MAIN), "export const evil = 1;\n");
    assert.match(core.verifyCodeFolder(folder, publicPem).reason, /file changed/);

    const wrongKey = path.join(w.root, "wrong-key");
    writeFolder(wrongKey, "0.2.1", sample, { key: otherPrivatePem });
    assert.match(core.verifyCodeFolder(wrongKey, publicPem).reason, /signature/);

    const edited = path.join(w.root, "edited-manifest");
    writeFolder(edited, "0.2.1", sample);
    const manifest = JSON.parse(readFileSync(path.join(edited, "manifest.json"), "utf8"));
    manifest.version = "9.9.9";
    writeFileSync(path.join(edited, "manifest.json"), JSON.stringify(manifest));
    assert.match(core.verifyCodeFolder(edited, publicPem).reason, /signature/);

    const newerLauncher = path.join(w.root, "newer-launcher");
    writeFolder(newerLauncher, "0.3.0", sample, { manifest: manifestFor("0.3.0", sample, { minLauncher: 2 }) });
    assert.match(core.verifyCodeFolder(newerLauncher, publicPem).reason, /rebuild the Bridge once/);

    const unsafe = path.join(w.root, "unsafe");
    writeFolder(unsafe, "0.2.1", sample, { manifest: manifestFor("0.2.1", { ...sample, "../outside.js": "x" }) });
    assert.match(core.verifyCodeFolder(unsafe, publicPem).reason, /unsafe path/);
  } finally { w.cleanup(); }
});

test("ZIP reader rejects path traversal and non-ZIP files", async () => {
  const w = workspace();
  try {
    assert.throws(() => core.readZip(Buffer.from("not a zip at all, definitely not")), /not a ZIP/);
    const folder = path.join(w.root, "evil");
    writeFolder(folder, "0.2.1", sample);
    const zipPath = path.join(w.root, "evil.zip");
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from("x"), "ok.txt");
    zip.addBuffer(Buffer.from("x"), "sub/../../escape.txt", { forceZip64Format: false });
    zip.end();
    const { createWriteStream } = await import("node:fs");
    await new Promise<void>((resolve) => zip.outputStream.pipe(createWriteStream(zipPath)).on("close", () => resolve()));
    mkdirSync(w.codeRoot, { recursive: true });
    const result = core.installUpdate(zipPath, { codeRoot: w.codeRoot, publicKeyPem: publicPem, activeVersion: "0.2.0" });
    assert.equal(result.ok, false);
    assert.equal(existsSync(path.join(w.root, "escape.txt")), false);
  } catch (error) {
    // yazl itself refuses ".." names on some versions; that is equally safe.
    assert.match(String(error), /\.\.|invalid|relative/i);
  } finally { w.cleanup(); }
});

test("install from ZIP, select it, crash guard falls back, fixed update recovers", async () => {
  const w = workspace();
  try {
    const builtInRoot = path.join(w.root, "built-in");
    mkdirSync(builtInRoot);
    const selectArgs = { codeRoot: w.codeRoot, builtInRoot, builtInVersion: "0.2.0", publicKeyPem: publicPem };
    assert.equal(core.selectCodeRoot(selectArgs).source, "built-in", "no updates yet");

    const folder = path.join(w.root, "u021");
    writeFolder(folder, "0.2.1", sample);
    const zipPath = path.join(w.root, "Knox Relay Bridge Update 0.2.1.zip");
    await zipOf(folder, zipPath, "Knox Relay Bridge Update 0.2.1/");   // wrapped in a top folder, like Finder zips
    mkdirSync(w.codeRoot, { recursive: true });
    const installed = core.installUpdate(zipPath, { codeRoot: w.codeRoot, publicKeyPem: publicPem, activeVersion: "0.2.0" });
    assert.deepEqual(installed, { ok: true, version: "0.2.1" });
    assert.equal(readdirSync(w.codeRoot).some((name) => name.startsWith(".staging")), false, "staging cleaned up");

    const again = core.installUpdate(zipPath, { codeRoot: w.codeRoot, publicKeyPem: publicPem, activeVersion: "0.2.1" });
    assert.match(again.reason, /not newer/);

    let selected = core.selectCodeRoot(selectArgs);
    assert.equal(selected.source, "update");
    assert.equal(selected.version, "0.2.1");
    core.markHealthy(w.codeRoot, "0.2.1");
    assert.equal(core.selectCodeRoot(selectArgs).source, "update", "healthy start keeps the update");

    // This start never reports healthy: the next start falls back and blocks 0.2.1.
    const fallback = core.selectCodeRoot(selectArgs);
    assert.equal(fallback.source, "built-in");
    assert.equal(core.selectCodeRoot(selectArgs).source, "built-in", "blocked version stays blocked");

    const fixed = path.join(w.root, "u022");
    writeFolder(fixed, "0.2.2", sample);
    const fixedZip = path.join(w.root, "fixed.zip");
    await zipOf(fixed, fixedZip);
    assert.equal(core.installUpdate(fixedZip, { codeRoot: w.codeRoot, publicKeyPem: publicPem, activeVersion: "0.2.0" }).ok, true);
    selected = core.selectCodeRoot(selectArgs);
    assert.equal(selected.version, "0.2.2", "a newer fixed update runs again");

    // Tampering with an installed update after install is caught at start.
    writeFileSync(path.join(w.codeRoot, "0.2.2", MAIN), "export const tampered = true;\n");
    assert.equal(core.selectCodeRoot(selectArgs).source, "built-in");

    core.revertToBuiltIn(w.codeRoot);
    assert.equal(core.selectCodeRoot(selectArgs).source, "built-in");
  } finally { w.cleanup(); }
});

test("an app rebuilt with a newer built-in version ignores older updates", () => {
  const w = workspace();
  try {
    const folder = path.join(w.root, "u021");
    writeFolder(folder, "0.2.1", sample);
    mkdirSync(w.codeRoot, { recursive: true });
    assert.equal(core.installUpdate(folder, { codeRoot: w.codeRoot, publicKeyPem: publicPem, activeVersion: "0.2.0" }).ok, true);
    const selected = core.selectCodeRoot({ codeRoot: w.codeRoot, builtInRoot: w.root, builtInVersion: "0.3.0", publicKeyPem: publicPem });
    assert.equal(selected.source, "built-in");
    assert.equal(selected.version, "0.3.0");
  } finally { w.cleanup(); }
});

test("launcher, package entry and main wiring", async () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.main, "desktop/launcher.cjs");
  assert.ok(pkg.build.files.includes("desktop/**/*"));
  const launcher = readFileSync(path.join("desktop", "launcher.cjs"), "utf8");
  assert.match(launcher, /selectCodeRoot/);
  assert.match(launcher, /update-public-key\.pem/);
  assert.match(launcher, /blockVersion/);
  assert.ok(existsSync(path.join("desktop", "update-public-key.pem")), "public key ships in the app");
  const main = readFileSync(path.join("src", "desktop", "main.ts"), "utf8");
  assert.match(main, /path\.join\(codeRoot, "desktop", "preload\.cjs"\)/);
  assert.match(main, /launcher\?\.markHealthy\(\)/);
});
