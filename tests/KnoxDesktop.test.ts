// tests/KnoxDesktop.test.ts
// v2 - 26-09-2026 - Cover startup failures, retry, per-connection logs, and idempotent stop

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConnectionStore, type SecretVault } from "../src/desktop/ConnectionStore.js";
import { parseConnectionImport } from "../src/desktop/ConnectionTypes.js";
import { BridgeRuntimeManager } from "../src/desktop/BridgeRuntimeManager.js";
import { KnoxLogger, sanitizeLogValue } from "../src/logging/KnoxLogger.js";

const valid = { telemetryEndpoint: "https://example.test/telemetry", missionSyncEndpoint: "https://example.test/missions", networkId: "network-1", connectorToken: "token-secret" };
const vault: SecretVault = { async encrypt(value) { return Buffer.from(`encrypted:${value}`).toString("base64"); }, async decrypt(value) { return Buffer.from(value, "base64").toString().replace(/^encrypted:/, ""); } };

test("connection import accepts webapp JSON and rejects malformed or incomplete input", () => {
  assert.equal(parseConnectionImport(JSON.stringify(valid)).networkId, "network-1");
  assert.throws(() => parseConnectionImport("{"), /malformed/);
  assert.throws(() => parseConnectionImport({ ...valid, connectorToken: "" }), /connectorToken is required/);
  assert.throws(() => parseConnectionImport({ ...valid, telemetryEndpoint: "nope" }), /valid URL/);
});

test("multiple connections persist without plaintext tokens in metadata", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "knox-desktop-"));
  try {
    const store = new ConnectionStore(directory, vault); await store.add(parseConnectionImport(valid), "Primary"); await store.add(parseConnectionImport({ ...valid, networkId: "network-2", connectorToken: "other-secret" }), "Secondary");
    assert.equal((await store.list()).length, 2);
    const metadata = await readFile(path.join(directory, "connections.json"), "utf8"); const secrets = await readFile(path.join(directory, "secrets.json"), "utf8");
    assert.equal(metadata.includes("token-secret"), false); assert.equal(metadata.includes("connectorToken"), false); assert.equal(secrets.includes("token-secret"), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("central logger redacts token fields, embedded secrets, and captures events", () => {
  const events: unknown[] = []; const logger = new KnoxLogger(["abc-secret"], false); logger.subscribe((event) => events.push(event));
  logger.info("request abc-secret", { connectorToken: "abc-secret", nested: { Authorization: "Bearer abc-secret" } });
  const output = JSON.stringify(events); assert.equal(output.includes("abc-secret"), false); assert.match(output, /REDACTED/);
  assert.deepEqual(sanitizeLogValue({ password: "x" }), { password: "[REDACTED]" });
});

test("runtime starts, blocks duplicate start, reuses doctor, and stops", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "knox-runtime-"));
  try {
    const store = new ConnectionStore(directory, vault); const connection = await store.add(parseConnectionImport({ ...valid, exchangeRoot: directory } as unknown as Record<string, unknown>), "Runtime");
    const events: unknown[] = []; const manager = new BridgeRuntimeManager(store, (_id, event) => events.push(event));
    assert.equal((await manager.start(connection)).state, "running"); await assert.rejects(manager.start(connection), /already running/);
    assert.ok((await manager.doctor(connection)).some((line) => line.includes("Network ID configured"))); assert.equal(manager.stop(connection.id).state, "offline"); assert.ok(events.length > 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("preflight failure preserves lastError, reaches the selected connection log, and permits retry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "knox-preflight-"));
  try {
    const store = new ConnectionStore(directory, vault); const connection = await store.add(parseConnectionImport({ ...valid, exchangeRoot: directory } as unknown as Record<string, unknown>), "Missing PZ");
    const events: Array<{ id: string; message: string }> = []; let fail = true;
    const manager = new BridgeRuntimeManager(store, (id, event) => events.push({ id, message: event.message }), async () => { if (fail) throw new Error("Project Zomboid user-data folder not found.\n\nExpected:\n  C:\\Users\\Test\\Zomboid"); });
    const failed = await manager.start(connection);
    assert.equal(failed.state, "error"); assert.match(failed.lastError ?? "", /C:\\Users\\Test\\Zomboid/);
    assert.ok(events.some((event) => event.id === connection.id && event.message.includes("Cannot start Bridge connection")));
    fail = false; const retried = await manager.start(connection); assert.equal(retried.state, "running");
    assert.equal(manager.stop(connection.id).state, "offline"); assert.equal(manager.stop(connection.id).state, "offline"); manager.stopAll(); manager.stopAll();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
