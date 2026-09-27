// tests/KnoxAutoUpdater.test.ts
// v1 - 27-09-2026 - Auto-updater against a local release feed: install, up to date, bad checksum, bad signature, offline

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AutoUpdater, parseLatest } from "../src/desktop/AutoUpdater.js";

const require = createRequire(import.meta.url);
const core = require(path.resolve("desktop", "updater-core.cjs"));
const yazl = require("yazl");

const signer = generateKeyPairSync("ed25519");
const publicPem = signer.publicKey.export({ type: "spki", format: "pem" }).toString();
const privatePem = signer.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const stranger = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

// A signed update ZIP as scripts/package-update.mjs builds it.
async function updateZip(version: string, key = privatePem): Promise<Buffer> {
  const files: Record<string, string> = { "dist/src/desktop/main.js": `export const v = "${version}";\n`, "package.json": '{"type":"module"}\n' };
  const hashes: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) hashes[name] = core.sha256(Buffer.from(content));
  const manifest = { format: 1, product: "knox-relay-bridge", version, minLauncher: 1, createdAt: "2026-09-27T00:00:00Z", files: hashes };
  const zip = new yazl.ZipFile();
  for (const [name, content] of Object.entries(files)) zip.addBuffer(Buffer.from(content), name);
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), "manifest.json");
  zip.addBuffer(Buffer.from(core.signManifest(manifest, key)), "manifest.sig");
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function latestFor(version: string, bytes: Buffer, overrides: Record<string, unknown> = {}) {
  return { version, file: `knox-relay-bridge-update-${version}.zip`, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, ...overrides };
}

// Serves /releases/latest/download/<name> like GitHub's stable latest-release address.
async function feed(routes: Record<string, Buffer | string>): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? "").split("/").pop() ?? "");
    const body = routes[name];
    if (body === undefined) { response.writeHead(404); response.end(); return; }
    response.writeHead(200); response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}/releases/latest/download/latest.json`, server };
}

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "knox-auto-"));
  const codeRoot = path.join(root, "app-code");
  mkdirSync(codeRoot, { recursive: true });
  return { root, codeRoot, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function updater(url: string, codeRoot: string, current = "0.2.0") {
  return new AutoUpdater({
    feedUrl: url, currentVersion: () => current, downloadDir: path.join(codeRoot, "downloads"),
    install: (file) => core.installUpdate(file, { codeRoot, publicKeyPem: publicPem, activeVersion: current }),
  });
}

test("latest.json is validated", () => {
  assert.throws(() => parseLatest(null), /not an object/);
  assert.throws(() => parseLatest({ version: "abc", file: "x.zip", sha256: "0".repeat(64), size: 1 }), /version/);
  assert.throws(() => parseLatest({ version: "0.2.1", file: "../evil.zip", sha256: "0".repeat(64), size: 1 }), /file name/);
  assert.throws(() => parseLatest({ version: "0.2.1", file: "a.zip", sha256: "xyz", size: 1 }), /sha256/);
  assert.throws(() => parseLatest({ version: "0.2.1", file: "a.zip", sha256: "0".repeat(64), size: 999999999 }), /size/);
  assert.equal(parseLatest({ version: "0.2.1", file: "a.zip", sha256: "0".repeat(64), size: 10 }).version, "0.2.1");
});

test("a newer signed release is downloaded and installed once; afterwards it is up to date", async () => {
  const w = workspace();
  const bytes = await updateZip("0.2.1");
  const { url, server } = await feed({ "latest.json": JSON.stringify(latestFor("0.2.1", bytes)), "knox-relay-bridge-update-0.2.1.zip": bytes });
  try {
    const auto = updater(url, w.codeRoot);
    assert.deepEqual(await auto.check(), { status: "installed", version: "0.2.1" });
    assert.equal(JSON.parse(readFileSync(path.join(w.codeRoot, "current.json"), "utf8")).version, "0.2.1");
    assert.equal(existsSync(path.join(w.codeRoot, "downloads", "knox-relay-bridge-update-0.2.1.zip")), false, "download removed after install");
    assert.deepEqual(await auto.check(), { status: "up-to-date", version: "0.2.1" }, "not downloaded twice in one session");
  } finally { server.close(); w.cleanup(); }
});

test("same or older release: up to date, nothing downloaded", async () => {
  const w = workspace();
  const { url, server } = await feed({ "latest.json": JSON.stringify(latestFor("0.2.0", Buffer.from("x"))) });
  try {
    assert.deepEqual(await updater(url, w.codeRoot).check(), { status: "up-to-date", version: "0.2.0" });
    assert.equal(existsSync(path.join(w.codeRoot, "current.json")), false);
  } finally { server.close(); w.cleanup(); }
});

test("a corrupted download is refused before install", async () => {
  const w = workspace();
  const bytes = await updateZip("0.2.1");
  const broken = Buffer.from(bytes);
  const at = broken.length - 30;
  broken.writeUInt8(broken.readUInt8(at) ^ 0xff, at);
  const { url, server } = await feed({ "latest.json": JSON.stringify(latestFor("0.2.1", bytes)), "knox-relay-bridge-update-0.2.1.zip": broken });
  try {
    const result = await updater(url, w.codeRoot).check();
    assert.equal(result.status, "error");
    assert.match((result as { reason: string }).reason, /checksum/);
    assert.equal(existsSync(path.join(w.codeRoot, "current.json")), false);
  } finally { server.close(); w.cleanup(); }
});

test("a release not signed with the publisher key is refused by the launcher install", async () => {
  const w = workspace();
  const bytes = await updateZip("0.2.1", stranger);
  const { url, server } = await feed({ "latest.json": JSON.stringify(latestFor("0.2.1", bytes)), "knox-relay-bridge-update-0.2.1.zip": bytes });
  try {
    const result = await updater(url, w.codeRoot).check();
    assert.equal(result.status, "error");
    assert.match((result as { reason: string }).reason, /signature/);
    assert.equal(existsSync(path.join(w.codeRoot, "current.json")), false);
  } finally { server.close(); w.cleanup(); }
});

test("offline, missing feed or bad JSON: a calm error, never a crash", async () => {
  const w = workspace();
  const { url, server } = await feed({ "latest.json": "{not json" });
  try {
    assert.equal((await updater(url, w.codeRoot).check()).status, "error");
    assert.equal((await updater(url.replace("latest.json", "missing.json"), w.codeRoot).check()).status, "error");
  } finally { server.close(); }
  const offline = await updater("http://127.0.0.1:9/releases/latest/download/latest.json", w.codeRoot).check();
  assert.equal(offline.status, "error");
  w.cleanup();
});
