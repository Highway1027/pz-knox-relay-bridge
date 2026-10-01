// tests/KnoxSaveIdentity.test.ts
// Bridge 0.2.6: save identity (MISSION_API 13.9), atomic file writes, pruning old ack_ files.

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, loadConfig } from "../src/config/KnoxBridgeConfig.js";
import { atomicWriteJson, ensureQueueDirectories, queuePaths } from "../src/files/KnoxQueue.js";
import type { KnoxApiTransport } from "../src/http/KnoxApiClient.js";
import { KnoxLogger } from "../src/logging/KnoxLogger.js";
import type { ConnectorMission, GameTelemetryMessage, MissionId, MissionPullResponse, MissionQueuedResponse, KnoxPingResponse, KnoxTelemetryResponse } from "../src/protocol/KnoxProtocol.js";
import { validateMissionCompleted, validateMissionDeclined } from "../src/protocol/KnoxValidators.js";
import { KnoxSyncEngine, withFileIdentity } from "../src/sync/KnoxSyncEngine.js";

class FakeApi implements KnoxApiTransport {
  mission: ConnectorMission | null = null;
  outcomes: { action: string; missionId: string; saveId?: string }[] = [];
  async sendConnectorTest(): Promise<KnoxPingResponse> { return { ok: true, protocolVersion: 1, message: "hello from Knox Relay" }; }
  async sendTelemetry(message: GameTelemetryMessage): Promise<KnoxTelemetryResponse> { return { ok: true, protocolVersion: 1, messageId: message.messageId }; }
  async pullMission(): Promise<MissionPullResponse> { return { ok: true, protocolVersion: 1, mission: this.mission }; }
  async acknowledgeMissionQueued(missionId: MissionId): Promise<MissionQueuedResponse> { return { ok: true, protocolVersion: 1, missionId }; }
  async acknowledgeMissionCompleted(missionId: MissionId, saveId?: string): Promise<MissionQueuedResponse> {
    this.outcomes.push({ action: "completed", missionId, ...(saveId ? { saveId } : {}) });
    return { ok: true, protocolVersion: 1, missionId };
  }
  async acknowledgeMissionDeclined(missionId: MissionId, saveId?: string): Promise<MissionQueuedResponse> {
    this.outcomes.push({ action: "declined", missionId, ...(saveId ? { saveId } : {}) });
    return { ok: true, protocolVersion: 1, missionId };
  }
}

async function fixture(extra: Partial<typeof DEFAULT_CONFIG> = {}) {
  const exchangeDirectory = await mkdtemp(path.join(os.tmpdir(), "knox-identity-"));
  const paths = queuePaths(exchangeDirectory);
  await ensureQueueDirectories(paths);
  const api = new FakeApi();
  const config = { ...DEFAULT_CONFIG, exchangeDirectory, stableFileAgeMs: 1, networkId: "net_A", connectionName: "Tim & Rodi",
    missionSyncEndpoint: "https://example.test", missionPollIntervalMs: 1, ...extra };
  return { exchangeDirectory, paths, api, engine: new KnoxSyncEngine(config, new KnoxLogger(), api) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function completion(messageId: string, payload: Record<string, unknown>) {
  return { protocolVersion: 1, messageId, type: "mission_completed", createdAt: new Date().toISOString(),
    payload: { missionId: "knox_t_1", missionVersion: 1, objectiveType: "external", completedBy: "steam:1", ...payload } };
}

test("mission files name the network and the connection", async () => {
  const { exchangeDirectory, paths, api, engine } = await fixture();
  try {
    api.mission = { protocolVersion: 1, missionId: "knox_t_1", missionVersion: 1, title: "Test", saveId: "save_abc123" } as unknown as ConnectorMission;
    await engine.pollOnce();
    const written = JSON.parse(await readFile(path.join(paths.bridgePending, "mission_knox_t_1.json"), "utf8"));
    assert.equal(written.networkId, "net_A");
    assert.equal(written.connectionName, "Tim & Rodi");
    assert.equal(written.saveId, "save_abc123", "the backend's saveId passes through unchanged");
    assert.equal(written.title, "Test");
  } finally { await rm(exchangeDirectory, { recursive: true, force: true }); }
});

test("an unnamed connection writes only the network id; long names are cut to 80", () => {
  const mission = { protocolVersion: 1, missionId: "knox_t_1", missionVersion: 1, title: "T" } as unknown as ConnectorMission;
  assert.deepEqual(Object.keys(withFileIdentity(mission, { networkId: "net_A", connectionName: "  " })).sort(),
    ["missionId", "missionVersion", "networkId", "protocolVersion", "title"]);
  assert.equal(withFileIdentity(mission, { networkId: "net_A", connectionName: "x".repeat(200) }).connectionName?.length, 80);
});

test("the CLI config reads connectionName", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "knox-config-"));
  try {
    const configPath = path.join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({ networkId: "net_A", connectionName: " Tim & Rodi " }));
    const config = await loadConfig(configPath, {}, directory, "linux");
    assert.equal(config.connectionName, "Tim & Rodi");
    assert.equal(config.acknowledgementMaxAgeMs, 24 * 60 * 60 * 1000);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("outcome events accept an optional, well-formed saveId", () => {
  assert.equal(validateMissionCompleted(completion("evt_1", { saveId: "save_abc123" })).payload.saveId, "save_abc123");
  assert.equal(validateMissionCompleted(completion("evt_2", {})).payload.saveId, undefined);
  assert.throws(() => validateMissionCompleted(completion("evt_3", { saveId: "SAVE!" })), /invalid mission completion/);
  assert.throws(() => validateMissionCompleted(completion("evt_4", { saveId: 12 })), /invalid mission completion/);
  assert.throws(() => validateMissionCompleted(completion("evt_5", { saveId: "save_abc", extra: 1 })), /invalid mission completion/);
  const decline = { protocolVersion: 1, messageId: "evt_6", type: "mission_declined", createdAt: new Date().toISOString(),
    payload: { missionId: "knox_t_1", missionVersion: 1, declinedBy: "steam:1", saveId: "save_abc123" } };
  assert.equal(validateMissionDeclined(decline).payload.saveId, "save_abc123");
});

test("the saveId of an outcome reaches the backend; events without one still work", async () => {
  const { exchangeDirectory, paths, api, engine } = await fixture({ missionSyncEndpoint: "" });
  try {
    await writeFile(path.join(paths.gamePending, "mission_completed_knox_t_1_v1.json"), JSON.stringify(completion("evt_c1", { saveId: "save_abc123" })));
    await writeFile(path.join(paths.gamePending, "mission_completed_knox_t_2_v1.json"),
      JSON.stringify({ ...completion("evt_c2", {}), payload: { ...completion("evt_c2", {}).payload, missionId: "knox_t_2" } }));
    await writeFile(path.join(paths.gamePending, "mission_declined_knox_t_3_v1.json"), JSON.stringify({ protocolVersion: 1, messageId: "evt_d1",
      type: "mission_declined", createdAt: new Date().toISOString(), payload: { missionId: "knox_t_3", missionVersion: 1, declinedBy: "steam:1", saveId: "save_abc123" } }));
    await settle();
    await engine.pollOnce();
    assert.deepEqual(api.outcomes, [
      { action: "completed", missionId: "knox_t_1", saveId: "save_abc123" },
      { action: "completed", missionId: "knox_t_2" },
      { action: "declined", missionId: "knox_t_3", saveId: "save_abc123" },
    ]);
    assert.equal((await readdir(paths.gamePending)).length, 0);
  } finally { await rm(exchangeDirectory, { recursive: true, force: true }); }
});

test("old ack_ files are pruned, recent ones and other files stay", async () => {
  const { exchangeDirectory, paths, engine } = await fixture({ missionSyncEndpoint: "" });
  try {
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    for (const name of ["ack_evt_old1.json", "ack_evt_old2.json", "mission_knox_old.json", "knox_missions.json"]) {
      await writeFile(path.join(paths.bridgePending, name), "{}");
      await utimes(path.join(paths.bridgePending, name), old, old);
    }
    await writeFile(path.join(paths.bridgePending, "ack_evt_new.json"), "{}");
    assert.equal(await engine.pruneOldAcknowledgements(), 2);
    const left = (await readdir(paths.bridgePending)).sort();
    assert.ok(left.includes("ack_evt_new.json"));
    assert.ok(left.includes("mission_knox_old.json"));
    assert.ok(!left.includes("ack_evt_old1.json") && !left.includes("ack_evt_old2.json"));

    await writeFile(path.join(paths.bridgePending, "ack_evt_old3.json"), "{}");
    await utimes(path.join(paths.bridgePending, "ack_evt_old3.json"), old, old);
    assert.equal(await engine.pruneOldAcknowledgements(), 0, "at most every ten minutes");
    assert.equal(await engine.pruneOldAcknowledgements(Date.now() + 11 * 60 * 1000), 1);
  } finally { await rm(exchangeDirectory, { recursive: true, force: true }); }
});

test("atomic write retries a locked rename and leaves no temporary file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "knox-atomic-"));
  try {
    const target = path.join(directory, "knox_missions.json");
    let calls = 0;
    const { rename } = await import("node:fs/promises");
    const lockedTwice = async (from: string, to: string) => {
      calls += 1;
      if (calls <= 2) throw Object.assign(new Error("locked"), { code: "EPERM" });
      await rename(from, to);
    };
    await atomicWriteJson(target, { ok: 1 }, { renameFile: lockedTwice, waitMs: async () => undefined });
    assert.equal(calls, 3);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { ok: 1 });
    assert.deepEqual(await readdir(directory), ["knox_missions.json"]);

    const alwaysLocked = async () => { throw Object.assign(new Error("locked"), { code: "EBUSY" }); };
    await assert.rejects(atomicWriteJson(target, { ok: 2 }, { renameFile: alwaysLocked, waitMs: async () => undefined }), /locked/);
    assert.deepEqual(await readdir(directory), ["knox_missions.json"], "a failed write removes its temporary file");
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { ok: 1 }, "the reader still sees the old complete file");

    const otherError = async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); };
    let tries = 0;
    await assert.rejects(atomicWriteJson(target, { ok: 3 }, { renameFile: async () => { tries += 1; return otherError(); }, waitMs: async () => undefined }), /gone/);
    assert.equal(tries, 1, "only a locked file is retried");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a leftover temporary file from an older Bridge never blocks a write", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "knox-atomic-"));
  try {
    const target = path.join(directory, "knox_missions.json");
    await writeFile(`${target}.${process.pid}.tmp`, "half");
    await atomicWriteJson(target, { ok: 1 });
    await atomicWriteJson(target, { ok: 2 });
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { ok: 2 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
