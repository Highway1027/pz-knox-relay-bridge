// tests/KnoxMissionRequest.test.ts
// "New mission" pressed in game (Connector 0.21.0, Bridge 0.2.9): the request reaches the backend and its
// quick answer is written to knox_request_status.json for the Connector.

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config/KnoxBridgeConfig.js";
import { ensureQueueDirectories, queuePaths } from "../src/files/KnoxQueue.js";
import type { KnoxApiTransport } from "../src/http/KnoxApiClient.js";
import { KnoxLogger } from "../src/logging/KnoxLogger.js";
import type { AudioId, AudioPullResponse, AudioQueuedResponse, GameTelemetryMessage, MissionId, MissionPullResponse, MissionQueuedResponse, MissionRequestResponse, KnoxPingResponse, KnoxTelemetryResponse } from "../src/protocol/KnoxProtocol.js";
import { validateMissionRequest, validateMissionRequestResponse } from "../src/protocol/KnoxValidators.js";
import { KNOX_REQUEST_STATUS_FILE, KnoxSyncEngine } from "../src/sync/KnoxSyncEngine.js";

class FakeApi implements KnoxApiTransport {
  requests: { requestId: string; requestedBy: string; saveId?: string }[] = [];
  answer: Omit<MissionRequestResponse, "requestId"> = { ok: true, protocolVersion: 1, status: "accepted" };
  shouldFail = false;
  async sendConnectorTest(): Promise<KnoxPingResponse> { return { ok: true, protocolVersion: 1, message: "hello from Knox Relay" }; }
  async sendTelemetry(message: GameTelemetryMessage): Promise<KnoxTelemetryResponse> { return { ok: true, protocolVersion: 1, messageId: message.messageId }; }
  async pullMission(): Promise<MissionPullResponse> { return { ok: true, protocolVersion: 1, mission: null }; }
  async pullAudio(): Promise<AudioPullResponse> { return { ok: true, protocolVersion: 1, audio: null }; }
  async acknowledgeAudioQueued(audioId: AudioId): Promise<AudioQueuedResponse> { return { ok: true, protocolVersion: 1, audioId }; }
  async acknowledgeMissionQueued(missionId: MissionId): Promise<MissionQueuedResponse> { return { ok: true, protocolVersion: 1, missionId }; }
  async acknowledgeMissionCompleted(missionId: MissionId): Promise<MissionQueuedResponse> { return { ok: true, protocolVersion: 1, missionId }; }
  async acknowledgeMissionDeclined(missionId: MissionId): Promise<MissionQueuedResponse> { return { ok: true, protocolVersion: 1, missionId }; }
  async reportMissionState(_kind: string, missionId: MissionId): Promise<MissionQueuedResponse> { return { ok: true, protocolVersion: 1, missionId }; }
  async requestMission(requestId: string, requestedBy: string, saveId?: string): Promise<MissionRequestResponse> {
    if (this.shouldFail) throw new Error("simulated backend outage");
    this.requests.push({ requestId, requestedBy, ...(saveId ? { saveId } : {}) });
    return { ...this.answer, requestId };
  }
}

function request(payload: Record<string, unknown> = {}) {
  return { protocolVersion: 1, messageId: "evt_1790000000000", type: "mission_request", createdAt: new Date().toISOString(),
    payload: { requestId: "req_1790000000000_42", requestedBy: "HighKool1062", ...payload } };
}

async function fixture() {
  const exchangeDirectory = await mkdtemp(path.join(os.tmpdir(), "knox-request-"));
  const paths = queuePaths(exchangeDirectory);
  await ensureQueueDirectories(paths);
  const api = new FakeApi();
  const config = { ...DEFAULT_CONFIG, exchangeDirectory, stableFileAgeMs: 1, missionSyncEndpoint: "", retryInitialMs: 1, retryMaxMs: 1 };
  return { exchangeDirectory, paths, api, engine: new KnoxSyncEngine(config, new KnoxLogger(), api) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const statusFile = async (paths: ReturnType<typeof queuePaths>) =>
  JSON.parse(await readFile(path.join(paths.bridgePending, KNOX_REQUEST_STATUS_FILE), "utf8"));

test("a mission request validates with exactly its fields", () => {
  assert.equal(validateMissionRequest(request()).payload.requestedBy, "HighKool1062");
  assert.equal(validateMissionRequest(request({ saveId: "save_abc123" })).payload.saveId, "save_abc123");
  assert.throws(() => validateMissionRequest(request({ requestId: "evt_1" })), /invalid mission request/);
  assert.throws(() => validateMissionRequest(request({ requestId: "req_UPPER" })), /invalid mission request/);
  assert.throws(() => validateMissionRequest(request({ requestedBy: "" })), /invalid mission request/);
  assert.throws(() => validateMissionRequest(request({ requestedBy: "x".repeat(65) })), /invalid mission request/);
  assert.throws(() => validateMissionRequest(request({ missionId: "knox_1" })), /invalid mission request/);
  assert.throws(() => validateMissionRequest(request({ saveId: "BAD" })), /invalid mission request/);
});

test("the backend answer must match the request", () => {
  const ok = { ok: true, protocolVersion: 1, requestId: "req_1", status: "refused", reason: "daily_limit", message: "Try again later." };
  assert.equal(validateMissionRequestResponse(ok, "req_1").status, "refused");
  assert.throws(() => validateMissionRequestResponse(ok, "req_2"), /did not answer/);
  assert.throws(() => validateMissionRequestResponse({ ...ok, status: "maybe" }, "req_1"), /did not answer/);
  assert.throws(() => validateMissionRequestResponse({ ...ok, message: "x".repeat(201) }, "req_1"), /did not answer/);
});

test("an accepted request is forwarded, archived and its status written for the game", async () => {
  const { exchangeDirectory, paths, api, engine } = await fixture();
  try {
    await writeFile(path.join(paths.gamePending, "mission_request_req_1790000000000_42.json"), JSON.stringify(request({ saveId: "save_abc123" })));
    await settle();
    await engine.pollOnce();
    assert.deepEqual(api.requests, [{ requestId: "req_1790000000000_42", requestedBy: "HighKool1062", saveId: "save_abc123" }]);
    assert.deepEqual(await statusFile(paths), { protocolVersion: 1, requestId: "req_1790000000000_42", status: "accepted" });
    assert.equal((await readdir(paths.gamePending)).length, 0);
    assert.equal((await readdir(paths.gameProcessed)).length, 1);
  } finally { await rm(exchangeDirectory, { recursive: true, force: true }); }
});

test("a refusal carries its reason and message to the game", async () => {
  const { exchangeDirectory, paths, api, engine } = await fixture();
  try {
    api.answer = { ok: true, protocolVersion: 1, status: "refused", reason: "busy", message: "Knox is already working on a mission for you." };
    await writeFile(path.join(paths.gamePending, "mission_request_req_1790000000000_42.json"), JSON.stringify(request()));
    await settle();
    await engine.pollOnce();
    const status = await statusFile(paths);
    assert.equal(status.status, "refused");
    assert.equal(status.reason, "busy");
    assert.match(status.message, /already working/);
  } finally { await rm(exchangeDirectory, { recursive: true, force: true }); }
});

test("a request is kept for retry while the backend is down", async () => {
  const { exchangeDirectory, paths, api, engine } = await fixture();
  try {
    api.shouldFail = true;
    await writeFile(path.join(paths.gamePending, "mission_request_req_1790000000000_42.json"), JSON.stringify(request()));
    await settle();
    await engine.pollOnce();
    assert.equal((await readdir(paths.gamePending)).length, 1);
    assert.equal((await readdir(paths.bridgePending)).includes(KNOX_REQUEST_STATUS_FILE), false);
    api.shouldFail = false;
    await settle();
    await engine.pollOnce();
    assert.equal(api.requests.length, 1);
    assert.equal((await readdir(paths.gamePending)).length, 0);
  } finally { await rm(exchangeDirectory, { recursive: true, force: true }); }
});
