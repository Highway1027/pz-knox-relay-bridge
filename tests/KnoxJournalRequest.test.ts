// tests/KnoxJournalRequest.test.ts
// "Write journal entry now" pressed in game (Mission Board 0.36.0, Bridge 0.2.12): the request reaches the
// backend, its quick answer is written to knox_journal_status.json, and after an accepted press the history
// is fetched again within seconds instead of minutes.

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config/KnoxBridgeConfig.js";
import { ensureQueueDirectories, queuePaths } from "../src/files/KnoxQueue.js";
import type { KnoxApiTransport } from "../src/http/KnoxApiClient.js";
import { KnoxLogger } from "../src/logging/KnoxLogger.js";
import type { AudioId, AudioPullResponse, AudioQueuedResponse, GameTelemetryMessage, HistoryPullResponse, MissionId, MissionPullResponse, MissionQueuedResponse, MissionRequestResponse, KnoxPingResponse, KnoxTelemetryResponse } from "../src/protocol/KnoxProtocol.js";
import { validateJournalRequest, validateMissionRequestResponse } from "../src/protocol/KnoxValidators.js";
import { KNOX_HISTORY_FAST_POLL_MS, KNOX_HISTORY_FAST_POLLS, KNOX_HISTORY_POLL_MS, KNOX_JOURNAL_STATUS_FILE, KNOX_REQUEST_STATUS_FILE, KnoxSyncEngine } from "../src/sync/KnoxSyncEngine.js";

class FakeApi implements KnoxApiTransport {
  requests: { requestId: string; requestedBy: string; saveId: string }[] = [];
  historyAsked = 0;
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
  async pullHistory(saveId: string): Promise<HistoryPullResponse> {
    this.historyAsked += 1;
    return { ok: true, protocolVersion: 1, saveId, journalEnabled: true, journal: [], recaps: [] };
  }
  async requestJournal(requestId: string, requestedBy: string, saveId: string): Promise<MissionRequestResponse> {
    if (this.shouldFail) throw new Error("simulated backend outage");
    this.requests.push({ requestId, requestedBy, saveId });
    return { ...this.answer, requestId };
  }
}

function request(payload: Record<string, unknown> = {}) {
  return { protocolVersion: 1, messageId: "evt_1790000000001", type: "journal_request", createdAt: new Date().toISOString(),
    payload: { requestId: "jrq_1790000000001_42", requestedBy: "HighKool1062", saveId: "save_abc123", ...payload } };
}

async function fixture() {
  const exchangeDirectory = await mkdtemp(path.join(os.tmpdir(), "knox-journal-"));
  const paths = queuePaths(exchangeDirectory);
  await ensureQueueDirectories(paths);
  const api = new FakeApi();
  const config = { ...DEFAULT_CONFIG, exchangeDirectory, stableFileAgeMs: 1, missionSyncEndpoint: "https://example.invalid/sync", networkId: "network-1",
    retryInitialMs: 1, retryMaxMs: 1, missionPollIntervalMs: 0 };
  return { exchangeDirectory, paths, api, engine: new KnoxSyncEngine(config, new KnoxLogger(), api) };
}

async function writeTelemetry(directory: string, saveId: string) {
  await writeFile(path.join(directory, "current.json"), JSON.stringify({
    protocolVersion: 1, messageId: "evt_tel_1", type: "game_telemetry", createdAt: new Date().toISOString(),
    payload: { gameTime: { year: 1993, month: 7, day: 9, hour: 12, minute: 30 }, players: [{ username: "tim", characterName: "Tim Knox", x: 1, y: 2, z: 0 }],
      snapshot: { schemaVersion: 1, saveId } },
  }));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const statusFile = async (paths: ReturnType<typeof queuePaths>) =>
  JSON.parse(await readFile(path.join(paths.bridgePending, KNOX_JOURNAL_STATUS_FILE), "utf8"));
const nextHistoryPollAt = (engine: KnoxSyncEngine) => (engine as unknown as { nextHistoryPollAt: number }).nextHistoryPollAt;
const pressFile = (paths: ReturnType<typeof queuePaths>) => path.join(paths.gamePending, "journal_request_jrq_1790000000001_42.json");

test("a journal request validates with exactly its fields", () => {
  assert.equal(validateJournalRequest(request()).payload.saveId, "save_abc123");
  for (const bad of [{ requestId: "req_1" }, { requestId: "jrq_UPPER" }, { requestedBy: "" }, { requestedBy: "x".repeat(65) }, { saveId: "BAD" }, { extra: 1 }]) {
    assert.throws(() => validateJournalRequest(request(bad)), /invalid journal request/);
  }
  const { saveId: _saveId, ...withoutSave } = request().payload;
  assert.throws(() => validateJournalRequest({ ...request(), payload: withoutSave }), /invalid journal request/, "the save is required");
  assert.throws(() => validateJournalRequest({ ...request(), type: "mission_request" }), /invalid journal request/);
});

test("the backend answer must match the request", () => {
  const ok = { ok: true, protocolVersion: 1, requestId: "jrq_1", status: "refused", reason: "nothing_new", message: "Nothing new since your last entry today." };
  assert.equal(validateMissionRequestResponse(ok, "jrq_1", "journal request").status, "refused");
  assert.throws(() => validateMissionRequestResponse(ok, "jrq_2", "journal request"), /did not answer the journal request/);
});

test("an accepted press is forwarded, its status written, and the history fetched again soon", async () => {
  const { exchangeDirectory, paths, api, engine } = await fixture();
  try {
    await writeTelemetry(paths.gameTelemetry, "save_abc123");
    await settle();
    await engine.pollOnce();
    assert.equal(api.historyAsked, 1);
    assert.ok(nextHistoryPollAt(engine) > Date.now() + KNOX_HISTORY_POLL_MS - 5000, "normally the next fetch is minutes away");

    await writeFile(pressFile(paths), JSON.stringify(request()));
    await settle();
    const pressedAt = Date.now();
    await engine.pollOnce();
    assert.deepEqual(api.requests, [{ requestId: "jrq_1790000000001_42", requestedBy: "HighKool1062", saveId: "save_abc123" }]);
    assert.deepEqual(await statusFile(paths), { protocolVersion: 1, requestId: "jrq_1790000000001_42", status: "accepted" });
    assert.equal((await readdir(paths.bridgePending)).includes(KNOX_REQUEST_STATUS_FILE), false, "the mission status file is left alone");
    assert.equal((await readdir(paths.gamePending)).length, 0);
    assert.ok(nextHistoryPollAt(engine) <= pressedAt + KNOX_HISTORY_FAST_POLL_MS + 1000, "the next fetch comes within seconds");

    // The fast fetches run out, then the normal pace returns.
    for (let i = 0; i < KNOX_HISTORY_FAST_POLLS; i += 1) {
      (engine as unknown as { nextHistoryPollAt: number }).nextHistoryPollAt = 0;
      await engine.pollOnce();
      assert.ok(nextHistoryPollAt(engine) <= Date.now() + KNOX_HISTORY_FAST_POLL_MS, `fast fetch ${i + 1}`);
    }
    (engine as unknown as { nextHistoryPollAt: number }).nextHistoryPollAt = 0;
    await engine.pollOnce();
    assert.ok(nextHistoryPollAt(engine) > Date.now() + KNOX_HISTORY_POLL_MS - 5000);
  } finally { await rm(exchangeDirectory, { recursive: true, force: true }); }
});

test("a refusal carries its message to the game and keeps the normal history pace", async () => {
  const { exchangeDirectory, paths, api, engine } = await fixture();
  try {
    await writeTelemetry(paths.gameTelemetry, "save_abc123");
    await settle();
    await engine.pollOnce();
    api.answer = { ok: true, protocolVersion: 1, status: "refused", reason: "nothing_new", message: "Nothing new since your last entry today." };
    await writeFile(pressFile(paths), JSON.stringify(request()));
    await settle();
    await engine.pollOnce();
    const status = await statusFile(paths);
    assert.equal(status.reason, "nothing_new");
    assert.match(status.message, /Nothing new/);
    assert.ok(nextHistoryPollAt(engine) > Date.now() + KNOX_HISTORY_POLL_MS - 5000);
  } finally { await rm(exchangeDirectory, { recursive: true, force: true }); }
});

test("a press is kept for retry while the backend is down", async () => {
  const { exchangeDirectory, paths, api, engine } = await fixture();
  try {
    api.shouldFail = true;
    await writeFile(pressFile(paths), JSON.stringify(request()));
    await settle();
    await engine.pollOnce();
    assert.equal((await readdir(paths.gamePending)).length, 1);
    assert.equal((await readdir(paths.bridgePending)).includes(KNOX_JOURNAL_STATUS_FILE), false);
    api.shouldFail = false;
    await settle();
    await engine.pollOnce();
    assert.equal(api.requests.length, 1);
    assert.equal((await readdir(paths.gamePending)).length, 0);
  } finally { await rm(exchangeDirectory, { recursive: true, force: true }); }
});
