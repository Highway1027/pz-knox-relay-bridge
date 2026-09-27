// tests/KnoxSecurity.test.ts
// v1 - 27-09-2026 - Security review fixes: HTTPS-only tokens, unknown backend, ZIP limits, navigation, release pipeline

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import test from "node:test";
import { assertSecureEndpoint, parseConnectionImport, unknownEndpointHosts } from "../src/desktop/ConnectionTypes.js";
import { checkZipBuffer } from "../src/desktop/ZipGuard.js";
import { AutoUpdater } from "../src/desktop/AutoUpdater.js";

const require = createRequire(import.meta.url);
const core = require(path.resolve("desktop", "updater-core.cjs"));
const KNOX = "https://europe-west1-wildshape-tracker.cloudfunctions.net";

function setup(overrides: Record<string, string> = {}) {
  return JSON.stringify({ networkId: "n", connectorToken: "t", telemetryEndpoint: `${KNOX}/knoxTelemetryIngest`, missionSyncEndpoint: `${KNOX}/knoxMissionSync`, ...overrides });
}

// A minimal deflated ZIP built by hand, so tests control sizes and names exactly.
function zipOf(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name); const packed = deflateRawSync(entry.data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(entry.data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed); centrals.push(central, name); offset += 30 + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test("connector tokens only travel over HTTPS (plain HTTP only to this computer)", () => {
  assert.doesNotThrow(() => assertSecureEndpoint(`${KNOX}/x`, "e"));
  assert.doesNotThrow(() => assertSecureEndpoint("http://127.0.0.1:8080/x", "e"));
  assert.doesNotThrow(() => assertSecureEndpoint("http://localhost/x", "e"));
  assert.throws(() => assertSecureEndpoint("http://example.com/x", "telemetryEndpoint"), /telemetryEndpoint must use HTTPS/);
  assert.throws(() => assertSecureEndpoint("ftp://example.com/x", "e"), /HTTPS/);
  assert.throws(() => parseConnectionImport(setup({ telemetryEndpoint: "http://europe-west1-wildshape-tracker.cloudfunctions.net/knoxTelemetryIngest" })), /HTTPS/);
});

test("setup text for a non-Knox backend is detected for confirmation", () => {
  assert.deepEqual(unknownEndpointHosts(parseConnectionImport(setup())), []);
  assert.deepEqual(unknownEndpointHosts(parseConnectionImport(setup({ missionSyncEndpoint: "https://evil.example/steal" }))), ["evil.example"]);
  assert.deepEqual(unknownEndpointHosts(parseConnectionImport(setup({ telemetryEndpoint: "http://127.0.0.1:9/x", missionSyncEndpoint: "http://127.0.0.1:9/y" }))), []);
});

test("ZIP guard: accepts a normal update, rejects bombs, floods and unsafe paths", () => {
  assert.doesNotThrow(() => checkZipBuffer(zipOf([{ name: "dist/src/desktop/main.js", data: Buffer.from("export {};\n") }])));
  const bomb = zipOf([{ name: "big.bin", data: Buffer.alloc(70 * 1024 * 1024) }]);
  assert.ok(bomb.length < 1024 * 1024, "the bomb is small on disk");
  assert.throws(() => checkZipBuffer(bomb), /allowed size/);
  const flood = zipOf(Array.from({ length: 501 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from("x") })));
  assert.throws(() => checkZipBuffer(flood), /more than 500 files/);
  assert.throws(() => checkZipBuffer(zipOf([{ name: "../escape.js", data: Buffer.from("x") }])), /unsafe path/);
  assert.throws(() => checkZipBuffer(Buffer.from("not a zip at all, clearly not a zip")), /not a ZIP/);
});

test("launcher ZIP reader (future builds) has the same limits", () => {
  assert.throws(() => core.readZip(zipOf([{ name: "big.bin", data: Buffer.alloc(70 * 1024 * 1024) }])), /allowed size|buffer/i);
  assert.equal(core.readZip(zipOf([{ name: "a.txt", data: Buffer.from("hi") }]))[0].data.toString(), "hi");
});

test("auto-updater stops a download that is bigger than announced", async () => {
  const announced = Buffer.alloc(1000);
  const server = createServer((request, response) => {
    if ((request.url ?? "").endsWith("latest.json")) {
      response.end(JSON.stringify({ version: "9.9.9", file: "knox-relay-bridge-update-9.9.9.zip", sha256: "0".repeat(64), size: announced.length }));
    } else { response.end(Buffer.alloc(5 * 1024 * 1024)); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = mkdtempSync(path.join(tmpdir(), "knox-sec-"));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/releases/latest/download/latest.json`;
    const result = await new AutoUpdater({ feedUrl: url, currentVersion: () => "0.2.2", downloadDir: root, install: () => ({ ok: true, version: "9.9.9" }) }).check();
    assert.equal(result.status, "error");
    assert.match((result as { reason: string }).reason, /larger than the announced/);
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

test("window cannot open new windows or navigate away", () => {
  const main = readFileSync(path.join("src", "desktop", "main.ts"), "utf8");
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(main, /on\("will-navigate", \(event\) => \{ event\.preventDefault\(\); \}\)/);
  assert.match(main, /checkZipFile\(file\)/, "manual installs pass the ZIP guard");
});

test("release pipeline: pinned actions, no install scripts, key only in the release job", () => {
  const workflow = readFileSync(path.join(".github", "workflows", "release.yml"), "utf8");
  for (const line of workflow.split(/\r?\n/).filter((item) => item.includes("uses:"))) {
    assert.match(line, /@[0-9a-f]{40}\b/, `action not pinned to a commit: ${line.trim()}`);
  }
  assert.doesNotMatch(workflow, /npm ci(?! --ignore-scripts)/, "every npm ci uses --ignore-scripts");
  const testJob = workflow.slice(workflow.indexOf("  test:"), workflow.indexOf("  release:"));
  assert.doesNotMatch(testJob, /secrets\./, "the test job never sees a secret");
  assert.equal((workflow.match(/secrets\.KNOX_UPDATE_PRIVATE_KEY_PEM/g) ?? []).length, 1, "the key appears in exactly one step");
});

test("Mac build installs exactly the locked dependencies", () => {
  const helper = readFileSync("BUILD KNOX RELAY BRIDGE.command", "utf8");
  assert.match(helper, /npm ci /);
  assert.doesNotMatch(helper, /npm install /);
});
