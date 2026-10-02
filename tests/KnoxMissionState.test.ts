// tests/KnoxMissionState.test.ts
// Connector state events (02-10-2026): mission_accepted, mission_abandoned, mission_failed reach the backend.

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config/KnoxBridgeConfig.js";
import { ensureQueueDirectories, queuePaths } from "../src/files/KnoxQueue.js";
import type { KnoxApiTransport } from "../src/http/KnoxApiClient.js";
import { KnoxLogger } from "../src/logging/KnoxLogger.js";
import type { GameTelemetryMessage, MissionId, MissionPullResponse, MissionQueuedResponse, MissionStateKind, KnoxPingResponse, KnoxTelemetryResponse } from "../src/protocol/KnoxProtocol.js";
import { validateMissionState } from "../src/protocol/KnoxValidators.js";
import { KnoxSyncEngine } from "../src/sync/KnoxSyncEngine.js";

class FakeApi implements KnoxApiTransport {
  reports: { kind: MissionStateKind; missionId: string; saveId?: string; reason?: string }[] = [];
  shouldFail = false;
  async sendConnectorTest(): Promise<KnoxPingResponse> { return { ok: true, protocolVersion: 1, message: "hello from Knox Relay" }; }
  async sendTelemetry(message: GameTelemetryMessage): Promise<KnoxTelemetryResponse> { return { ok: true, protocolVersion: 1, messageId: message.messageId }; }
  async pullMission(): Promise<MissionPullResponse> { return { ok: true, protocolVersion: 1, mission: null }; }
  async acknowledgeMissionQueued(missionId: MissionId): Promise<MissionQueuedResponse> { return { ok: true, protocolVersion: 1, missionId }; }
  async acknowledgeMissionCompleted(missionId: MissionId): Promise<MissionQueuedResponse> { return { ok: true, protocolVersion: 1, missionId }; }
  async acknowledgeMissionDeclined(missionId: MissionId): Promise<MissionQueuedResponse> { return { ok: true, protocolVersion: 1, missionId }; }
  async reportMissionState(kind: MissionStateKind, missionId: MissionId, saveId?: string, reason?: string): Promise<MissionQueuedResponse> {
    if (this.shouldFail) throw new Error("simulated backend outage");
    this.reports.push({ kind, missionId, ...(saveId ? { saveId } : {}), ...(reason ? { reason } : {}) });
    return { ok: true, protocolVersion: 1, missionId };
  }
}

function event(type: string, payload: Record<string, unknown>) {
  return { protocolVersion: 1, messageId: `evt_${type}`, type, createdAt: new Date().toISOString(),
    payload: { missionId: "knox_t_1", missionVersion: 1, ...payload } };
}

async function fixture() {
  const exchangeDirectory = await mkdtemp(path.join(os.tmpdir(), "knox-state-"));
  const paths = queuePaths(exchangeDirectory);
  await ensureQueueDirectories(paths);
  const api = new FakeApi();
  const config = { ...DEFAULT_CONFIG, exchangeDirectory, stableFileAgeMs: 1, missionSyncEndpoint: "", retryInitialMs: 1, retryMaxMs: 1 };
  return { exchangeDirectory, paths, api, engine: new KnoxSyncEngine(config, new KnoxLogger(), api) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("state events validate with exactly their own field", () => {
  assert.equal(validateMissionState(event("mission_accepted", { acceptedBy: "steam:1" })).payload.acceptedBy, "steam:1");
  assert.equal(validateMissionState(event("mission_abandoned", { abandonedBy: "local:player0", saveId: "save_abc123" })).payload.saveId, "save_abc123");
  assert.equal(validateMissionState(event("mission_failed", { reason: "Everyone was dead before the time was up." })).payload.reason,
    "Everyone was dead before the time was up.");
  assert.throws(() => validateMissionState(event("mission_accepted", { abandonedBy: "steam:1" })), /invalid mission state event/);
  assert.throws(() => validateMissionState(event("mission_accepted", { acceptedBy: "" })), /invalid mission state event/);
  assert.throws(() => validateMissionState(event("mission_failed", { reason: "x".repeat(201) })), /invalid mission state event/);
  assert.throws(() => validateMissionState(event("mission_accepted", { acceptedBy: "steam:1", extra: 1 })), /invalid mission state event/);
  assert.throws(() => validateMissionState(event("mission_accepted", { acceptedBy: "steam:1", saveId: "BAD" })), /invalid mission state event/);
  assert.throws(() => validateMissionState(event("mission_toString", { acceptedBy: "steam:1" })), /invalid mission state event/);
  assert.throws(() => validateMissionState(event("mission_accepted", { acceptedBy: "steam:1", missionVersion: 0 })), /invalid mission state event/);
});

test("state events are forwarded to the backend and archived", async () => {
  const { exchangeDirectory, paths, api, engine } = await fixture();
  try {
    await writeFile(path.join(paths.gamePending, "mission_accepted_knox_t_1_v1.json"),
      JSON.stringify(event("mission_accepted", { acceptedBy: "steam:1", saveId: "save_abc123" })));
    await writeFile(path.join(paths.gamePending, "mission_failed_knox_t_1_v1.json"),
      JSON.stringify(event("mission_failed", { reason: "A survivor died before the time was up." })));
    await settle();
    await engine.pollOnce();
    assert.deepEqual(api.reports, [
      { kind: "accepted", missionId: "knox_t_1", saveId: "save_abc123" },
      { kind: "failed", missionId: "knox_t_1", reason: "A survivor died before the time was up." },
    ]);
    assert.equal((await readdir(paths.gamePending)).length, 0);
    assert.equal((await readdir(paths.gameProcessed)).length, 2);
  } finally { await rm(exchangeDirectory, { recursive: true, force: true }); }
});

test("a state event stays queued while the backend is down", async () => {
  const { exchangeDirectory, paths, api, engine } = await fixture();
  try {
    api.shouldFail = true;
    await writeFile(path.join(paths.gamePending, "mission_abandoned_knox_t_1_v1.json"),
      JSON.stringify(event("mission_abandoned", { abandonedBy: "steam:2" })));
    await settle();
    await engine.pollOnce();
    assert.deepEqual(await readdir(paths.gamePending), ["mission_abandoned_knox_t_1_v1.json"]);
    api.shouldFail = false;
    await settle();
    await engine.pollOnce();
    assert.deepEqual(api.reports, [{ kind: "abandoned", missionId: "knox_t_1" }]);
    assert.equal((await readdir(paths.gamePending)).length, 0);
  } finally { await rm(exchangeDirectory, { recursive: true, force: true }); }
});
