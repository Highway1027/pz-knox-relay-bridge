// tests/KnoxHistory.test.ts
// World history for the game's Journal window (Bridge 0.2.11): the save named by the telemetry snapshot,
// pulled from knoxMissionSync action "history" and written as knox_history.json only when it changed.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config/KnoxBridgeConfig.js";
import { ensureQueueDirectories, queuePaths } from "../src/files/KnoxQueue.js";
import type { KnoxApiTransport } from "../src/http/KnoxApiClient.js";
import { KnoxLogger } from "../src/logging/KnoxLogger.js";
import type { AudioId, AudioPullResponse, AudioQueuedResponse, GameTelemetryMessage, HistoryPullResponse, KnoxPingResponse, KnoxTelemetryResponse, MissionId, MissionPullResponse, MissionQueuedResponse } from "../src/protocol/KnoxProtocol.js";
import { validateHistoryPullResponse } from "../src/protocol/KnoxValidators.js";
import { KNOX_HISTORY_FILE, KnoxSyncEngine } from "../src/sync/KnoxSyncEngine.js";

const JOURNAL = { id: "1993-07-09_tim", dayKey: "1993-07-09", username: "tim", characterName: "Tim Knox", title: "A rough morning", text: "We woke up cold." };
const RECAP = { id: "ses_1759000000000", startDay: "1993-07-09", endDay: "1993-07-10", endedAtMs: 1759000000000, title: "Back in Rosewood", text: "Last time..." };
const feed = (saveId: string, extra: Partial<HistoryPullResponse> = {}): HistoryPullResponse =>
  ({ ok: true, protocolVersion: 1, saveId, journalEnabled: true, journal: [JOURNAL], recaps: [RECAP], ...extra });

class FakeApi implements KnoxApiTransport {
  asked: string[] = [];
  answer: (saveId: string) => HistoryPullResponse = (saveId) => feed(saveId);
  async sendConnectorTest(): Promise<KnoxPingResponse> { return { ok: true, protocolVersion: 1, message: "hello from Knox Relay" }; }
  async sendTelemetry(message: GameTelemetryMessage): Promise<KnoxTelemetryResponse> { return { ok: true, protocolVersion: 1, messageId: message.messageId }; }
  async pullMission(): Promise<MissionPullResponse> { return { ok: true, protocolVersion: 1, mission: null }; }
  async pullAudio(): Promise<AudioPullResponse> { return { ok: true, protocolVersion: 1, audio: null }; }
  async acknowledgeAudioQueued(audioId: AudioId): Promise<AudioQueuedResponse> { return { ok: true, protocolVersion: 1, audioId }; }
  async acknowledgeMissionQueued(missionId: MissionId): Promise<MissionQueuedResponse> { return { ok: true, protocolVersion: 1, missionId }; }
  async acknowledgeMissionCompleted(missionId: MissionId): Promise<MissionQueuedResponse> { return { ok: true, protocolVersion: 1, missionId }; }
  async acknowledgeMissionDeclined(missionId: MissionId): Promise<MissionQueuedResponse> { return { ok: true, protocolVersion: 1, missionId }; }
  async reportMissionState(_kind: string, missionId: MissionId): Promise<MissionQueuedResponse> { return { ok: true, protocolVersion: 1, missionId }; }
  async pullHistory(saveId: string): Promise<HistoryPullResponse> { this.asked.push(saveId); return this.answer(saveId); }
}

async function fixture() {
  const exchangeDirectory = await mkdtemp(path.join(os.tmpdir(), "knox-history-"));
  const paths = queuePaths(exchangeDirectory);
  await ensureQueueDirectories(paths);
  const api = new FakeApi();
  const config = { ...DEFAULT_CONFIG, exchangeDirectory, stableFileAgeMs: 1, missionSyncEndpoint: "https://example.invalid/sync", networkId: "network-1",
    retryInitialMs: 1, retryMaxMs: 1, missionPollIntervalMs: 0 };
  return { exchangeDirectory, paths, api, engine: new KnoxSyncEngine(config, new KnoxLogger(), api) };
}

async function writeTelemetry(directory: string, messageId: string, saveId?: string) {
  const snapshot = saveId === undefined ? {} : { snapshot: { schemaVersion: 1, saveId } };
  await writeFile(path.join(directory, "current.json"), JSON.stringify({
    protocolVersion: 1, messageId, type: "game_telemetry", createdAt: new Date().toISOString(),
    payload: { gameTime: { year: 1993, month: 7, day: 9, hour: 12, minute: 30 }, players: [{ username: "tim", characterName: "Tim Knox", x: 1, y: 2, z: 0 }], ...snapshot },
  }));
  await new Promise((resolve) => setTimeout(resolve, 5));
}

const readJson = async (filePath: string) => JSON.parse(await readFile(filePath, "utf8"));

test("a history response validates with exactly its fields and limits", () => {
  assert.equal(validateHistoryPullResponse(feed("save_abc"), "save_abc").journal[0]?.title, "A rough morning");
  assert.equal(validateHistoryPullResponse(feed("save_abc", { journal: [{ ...JOURNAL, title: "" }], recaps: [{ ...RECAP, title: "", startDay: "" }] }), "save_abc").recaps.length, 1);
  assert.throws(() => validateHistoryPullResponse(feed("save_other"), "save_abc"), /invalid history response/, "another save's feed is refused");
  assert.throws(() => validateHistoryPullResponse({ ...feed("save_abc"), extra: 1 }, "save_abc"), /invalid history response/);
  for (const bad of [{ id: "../x" }, { dayKey: "9-7-1993" }, { username: "" }, { text: "" }, { text: "x".repeat(1601) }, { title: "x".repeat(81) }, { extra: 1 }]) {
    assert.throws(() => validateHistoryPullResponse(feed("save_abc", { journal: [{ ...JOURNAL, ...bad } as typeof JOURNAL] }), "save_abc"), /invalid history journal entry/);
  }
  for (const bad of [{ endedAtMs: -1 }, { endDay: "soon" }, { text: "x".repeat(1201) }]) {
    assert.throws(() => validateHistoryPullResponse(feed("save_abc", { recaps: [{ ...RECAP, ...bad } as typeof RECAP] }), "save_abc"), /invalid history recap/);
  }
  assert.throws(() => validateHistoryPullResponse(feed("save_abc", { recaps: Array(11).fill(RECAP) }), "save_abc"), /invalid history response/);
});

test("no history is pulled before a snapshot names the save", async () => {
  const { exchangeDirectory, paths, api, engine } = await fixture();
  try {
    await writeTelemetry(paths.gameTelemetry, "evt_no_save");
    await engine.pollOnce();
    assert.deepEqual(api.asked, []);
  } finally { await rm(exchangeDirectory, { recursive: true, force: true }); }
});

test("the save's history is written once, rewritten when it changes or goes missing, and pulled at once for a new save", async () => {
  const { exchangeDirectory, paths, api, engine } = await fixture();
  const filePath = path.join(paths.bridgePending, KNOX_HISTORY_FILE);
  try {
    await writeTelemetry(paths.gameTelemetry, "evt_a1", "save_abc");
    await engine.pollOnce();
    assert.deepEqual(api.asked, ["save_abc"]);
    assert.deepEqual(await readJson(filePath), { protocolVersion: 1, saveId: "save_abc", journalEnabled: true, journal: [JOURNAL], recaps: [RECAP] });

    // Not again within the poll interval, even with new telemetry of the same save.
    await writeTelemetry(paths.gameTelemetry, "evt_a2", "save_abc");
    await engine.pollOnce();
    assert.deepEqual(api.asked, ["save_abc"]);

    // Another save: pulled at once and the file replaced.
    api.answer = (saveId) => feed(saveId, { journal: [], journalEnabled: false });
    await writeTelemetry(paths.gameTelemetry, "evt_b1", "save_def");
    await engine.pollOnce();
    assert.deepEqual(api.asked, ["save_abc", "save_def"]);
    const written = await readJson(filePath);
    assert.equal(written.saveId, "save_def");
    assert.equal(written.journalEnabled, false);

    // The file went missing (the game cleaned up): written again on the next pull even when unchanged.
    await unlink(filePath);
    await writeTelemetry(paths.gameTelemetry, "evt_a3", "save_abc");
    await writeTelemetry(paths.gameTelemetry, "evt_b2", "save_def");
    (engine as unknown as { nextHistoryPollAt: number }).nextHistoryPollAt = 0;
    await engine.pollOnce();
    assert.equal((await readJson(filePath)).saveId, "save_def");
  } finally { await rm(exchangeDirectory, { recursive: true, force: true }); }
});

test("a failed pull is retried and keeps the old file", async () => {
  const { exchangeDirectory, paths, api, engine } = await fixture();
  const filePath = path.join(paths.bridgePending, KNOX_HISTORY_FILE);
  try {
    await writeTelemetry(paths.gameTelemetry, "evt_a1", "save_abc");
    await engine.pollOnce();
    api.answer = () => { throw new Error("backend down"); };
    (engine as unknown as { nextHistoryPollAt: number }).nextHistoryPollAt = 0;
    await engine.pollOnce();
    assert.equal((await readJson(filePath)).journal.length, 1);
    api.answer = (saveId) => feed(saveId, { journal: [] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await engine.pollOnce();
    assert.equal(api.asked.length, 3, "retried after the short retry delay");
    assert.equal((await readJson(filePath)).journal.length, 0);
  } finally { await rm(exchangeDirectory, { recursive: true, force: true }); }
});
