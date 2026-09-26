// tests/KnoxSyncEngine.test.ts
// v6 - 26-09-2026 - Support completion and decline transport

import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config/KnoxBridgeConfig.js";
import { ensureQueueDirectories, queuePaths } from "../src/files/KnoxQueue.js";
import type { KnoxApiTransport } from "../src/http/KnoxApiClient.js";
import { KnoxLogger } from "../src/logging/KnoxLogger.js";
import type { ConnectorMission, GameTelemetryMessage, MissionId, MissionPullResponse, MissionQueuedResponse, KnoxPingResponse, KnoxTelemetryResponse } from "../src/protocol/KnoxProtocol.js";
import { KnoxSyncEngine } from "../src/sync/KnoxSyncEngine.js";

class FakeApi implements KnoxApiTransport {
  calls = 0;
  shouldFail = false;
  telemetryMessages: GameTelemetryMessage[] = [];
  mission: ConnectorMission | null = null;
  missionPulls = 0;
  missionAcks = 0;
  missionShouldFail = false;

  async sendConnectorTest(): Promise<KnoxPingResponse> {
    this.calls += 1;
    if (this.shouldFail) throw new Error("simulated backend outage");
    return { ok: true, protocolVersion: 1, message: "hello from Knox Relay" };
  }

  async sendTelemetry(message: GameTelemetryMessage): Promise<KnoxTelemetryResponse> {
    this.calls += 1;
    this.telemetryMessages.push(message);
    if (this.shouldFail) throw new Error("simulated backend outage");
    return { ok: true, protocolVersion: 1, messageId: message.messageId };
  }

  async pullMission(): Promise<MissionPullResponse> {
    this.missionPulls += 1;
    if (this.missionShouldFail) throw new Error("simulated mission backend outage");
    return { ok: true, protocolVersion: 1, mission: this.mission };
  }

  async acknowledgeMissionQueued(missionId: MissionId): Promise<MissionQueuedResponse> {
    this.missionAcks += 1;
    if (this.shouldFail) throw new Error("simulated backend outage");
    return { ok: true, protocolVersion: 1, missionId };
  }

  async acknowledgeMissionCompleted(missionId: MissionId): Promise<MissionQueuedResponse> {
    this.missionAcks += 1;
    if (this.shouldFail) throw new Error('simulated backend outage');
    return { ok: true, protocolVersion: 1, missionId };
  }
  async acknowledgeMissionDeclined(missionId: MissionId): Promise<MissionQueuedResponse> {
    return { ok: true, protocolVersion: 1, missionId };
  }
}

async function writeTelemetry(directory: string, messageId: string, x: number): Promise<void> {
  await writeFile(path.join(directory, "current.json"), JSON.stringify({
    protocolVersion: 1, messageId, type: "game_telemetry", createdAt: new Date().toISOString(),
    payload: { gameTime: { year: 1993, month: 7, day: 9, hour: 12, minute: 30 }, players: [{ username: "Tim", characterName: "Tim Knox", x, y: 2, z: 0 }] },
  }));
  await new Promise((resolve) => setTimeout(resolve, 5));
}

async function fixture(api = new FakeApi()) {
  const exchangeDirectory = await mkdtemp(path.join(os.tmpdir(), "knox-bridge-"));
  const paths = queuePaths(exchangeDirectory);
  await ensureQueueDirectories(paths);
  const config = { ...DEFAULT_CONFIG, exchangeDirectory, stableFileAgeMs: 1, retryInitialMs: 1, retryMaxMs: 4 };
  return { exchangeDirectory, paths, api, engine: new KnoxSyncEngine(config, new KnoxLogger(), api) };
}

async function writeTestMessage(pendingDirectory: string, messageId: string): Promise<string> {
  const filePath = path.join(pendingDirectory, `${messageId}.json`);
  await writeFile(filePath, JSON.stringify({
    protocolVersion: 1,
    messageId,
    type: "connector_test",
    createdAt: new Date().toISOString(),
    payload: { message: "hello from Project Zomboid" },
  }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  return filePath;
}

test("posts a valid connector test, writes the backend acknowledgement, and archives it", async () => {
  const { exchangeDirectory, paths, api, engine } = await fixture();
  try {
    const messageId = "evt_test_001";
    await writeTestMessage(paths.gamePending, messageId);
    await engine.pollOnce();

    assert.equal(api.calls, 1);
    const ack = JSON.parse(await readFile(path.join(paths.bridgePending, `ack_${messageId}.json`), "utf8"));
    assert.equal(ack.replyTo, messageId);
    assert.equal(ack.payload.message, "hello from Knox Relay");
    await readFile(path.join(paths.gameProcessed, `${messageId}.json`), "utf8");

    const restarted = new KnoxSyncEngine({ ...DEFAULT_CONFIG, exchangeDirectory, stableFileAgeMs: 1 }, new KnoxLogger(), api);
    await restarted.pollOnce();
    assert.equal(api.calls, 1);
  } finally {
    await rm(exchangeDirectory, { recursive: true, force: true });
  }
});

test("retains an event during outage and delivers it after recovery", async () => {
  const api = new FakeApi();
  api.shouldFail = true;
  const { exchangeDirectory, paths, engine } = await fixture(api);
  try {
    const messageId = "evt_retry_001";
    const pendingPath = await writeTestMessage(paths.gamePending, messageId);
    await engine.pollOnce();
    await access(pendingPath);
    assert.equal(api.calls, 1);

    api.shouldFail = false;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await engine.pollOnce();
    assert.equal(api.calls, 2);
    assert.equal(JSON.parse(await readFile(path.join(paths.bridgePending, `ack_${messageId}.json`), "utf8")).payload.message, "hello from Knox Relay");
    await readFile(path.join(paths.gameProcessed, `${messageId}.json`), "utf8");
  } finally {
    await rm(exchangeDirectory, { recursive: true, force: true });
  }
});

test("moves malformed JSON to failed without calling the backend", async () => {
  const { exchangeDirectory, paths, api, engine } = await fixture();
  try {
    await writeFile(path.join(paths.gamePending, "broken.json"), "{not-json");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await engine.pollOnce();
    assert.equal(api.calls, 0);
    assert.equal(await readFile(path.join(paths.gameFailed, "broken.json"), "utf8"), "{not-json");
  } finally {
    await rm(exchangeDirectory, { recursive: true, force: true });
  }
});

test("retries failed telemetry and succeeds after recovery", async () => {
  const api = new FakeApi(); api.shouldFail = true;
  const { exchangeDirectory, paths, engine } = await fixture(api);
  try {
    await writeTelemetry(paths.gameTelemetry, "evt_telemetry_retry", 1);
    await engine.pollOnce();
    api.shouldFail = false;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await engine.pollOnce();
    assert.equal(api.telemetryMessages.length, 2);
  } finally { await rm(exchangeDirectory, { recursive: true, force: true }); }
});

test("coalesces stale telemetry by sending only the newest overwritten snapshot", async () => {
  const api = new FakeApi(); api.shouldFail = true;
  const { exchangeDirectory, paths, engine } = await fixture(api);
  try {
    await writeTelemetry(paths.gameTelemetry, "evt_stale", 1);
    await engine.pollOnce();
    await writeTelemetry(paths.gameTelemetry, "evt_newest", 99);
    api.shouldFail = false;
    await engine.pollOnce();
    assert.equal(api.telemetryMessages.at(-1)?.messageId, "evt_newest");
    assert.equal(api.telemetryMessages.at(-1)?.payload.players[0]?.x, 99);
  } finally { await rm(exchangeDirectory, { recursive: true, force: true }); }
});

test("queues one validated mission file and does not recreate an archived mission", async () => {
  const api = new FakeApi();
  api.mission = { protocolVersion: 1, missionId: "test_001", missionVersion: 1, title: "Connector Test Mission", status: "active", objective: { type: "test", text: "Verify Web to Project Zomboid mission transport." }, reward: null, testFixture: null };
  const { exchangeDirectory, paths, engine } = await fixture(api);
  try {
    const config = { ...DEFAULT_CONFIG, exchangeDirectory, stableFileAgeMs: 1, missionSyncEndpoint: "https://example.test", missionPollIntervalMs: 1 };
    const missionEngine = new KnoxSyncEngine(config, new KnoxLogger(), api);
    await missionEngine.pollOnce();
    const pending = path.join(paths.bridgePending, "mission_test_001.json");
    assert.equal(JSON.parse(await readFile(pending, "utf8")).missionId, "test_001");
    assert.equal(api.missionAcks, 1);
    await (await import("../src/files/KnoxQueue.js")).moveQueueFile(pending, paths.bridgeProcessed);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await missionEngine.pollOnce();
    await readFile(path.join(paths.bridgeProcessed, "mission_test_001.json"), "utf8");
    assert.equal(api.missionAcks, 2);
  } finally { await rm(exchangeDirectory, { recursive: true, force: true }); }
});

test("archives a locally queued mission after the PZ acknowledgement", async () => {
  const api = new FakeApi();
  const { exchangeDirectory, paths } = await fixture(api);
  try {
    const missionPath = path.join(paths.bridgePending, "mission_test_001.json");
    await writeFile(missionPath, JSON.stringify({ protocolVersion: 1, missionId: "test_001", missionVersion: 1, title: "Connector Test Mission", status: "active", objective: { type: "test", text: "Verify Web to Project Zomboid mission transport." }, reward: null, testFixture: null }));
    const ackPath = path.join(paths.gamePending, "evt_mission_ack.json");
    await writeFile(ackPath, JSON.stringify({ protocolVersion: 1, messageId: "evt_mission_ack", type: "mission_received_ack", createdAt: new Date().toISOString(), payload: { missionId: "test_001" } }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const engine = new KnoxSyncEngine({ ...DEFAULT_CONFIG, exchangeDirectory, stableFileAgeMs: 1 }, new KnoxLogger(), api);
    await engine.pollOnce();
    await readFile(path.join(paths.bridgeProcessed, "mission_test_001.json"), "utf8");
    await readFile(path.join(paths.gameProcessed, "evt_mission_ack.json"), "utf8");
  } finally { await rm(exchangeDirectory, { recursive: true, force: true }); }
});

test("mission backend outage does not throw or disturb local queue processing", async () => {
  const api = new FakeApi(); api.missionShouldFail = true;
  const { exchangeDirectory, paths } = await fixture(api);
  try {
    await writeTestMessage(paths.gamePending, "evt_during_mission_outage");
    const engine = new KnoxSyncEngine({ ...DEFAULT_CONFIG, exchangeDirectory, stableFileAgeMs: 1, missionSyncEndpoint: "https://example.test", retryInitialMs: 1 }, new KnoxLogger(), api);
    await engine.pollOnce();
    await readFile(path.join(paths.gameProcessed, "evt_during_mission_outage.json"), "utf8");
    assert.equal(api.missionPulls, 1);
  } finally { await rm(exchangeDirectory, { recursive: true, force: true }); }
});
