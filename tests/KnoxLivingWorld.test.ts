// tests/KnoxLivingWorld.test.ts
// Living world people and found requests (Bridge 0.3.4, Mission Board 0.49.0, HOLDOUTS_DESIGN.md 19): knoxMissionSync
// action "people" written as knox_people.json per save, and "found" / "found_queued" written as found_<id>.json with
// the knox_found.json index, moved to processed on the game's found_received_ack.

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config/KnoxBridgeConfig.js";
import { ensureQueueDirectories, queuePaths } from "../src/files/KnoxQueue.js";
import type { KnoxApiTransport } from "../src/http/KnoxApiClient.js";
import { KnoxLogger } from "../src/logging/KnoxLogger.js";
import type { AudioId, AudioPullResponse, AudioQueuedResponse, FoundPullResponse, FoundQueuedResponse, FoundRequestId, GameTelemetryMessage, KnoxFoundRequest, KnoxPingResponse, KnoxTelemetryResponse, MissionId, MissionPullResponse, MissionQueuedResponse, PeoplePullResponse } from "../src/protocol/KnoxProtocol.js";
import { validateFoundPullResponse, validateFoundReceivedAcknowledgement, validateFoundRequest, validatePeoplePullResponse } from "../src/protocol/KnoxValidators.js";
import { KNOX_FOUND_INDEX_FILE, KNOX_PEOPLE_FILE, KnoxSyncEngine, foundFile } from "../src/sync/KnoxSyncEngine.js";

const PERSON = { holdout: "h03", resident: "r1", about: "A nurse who lost her husband in July.", lines: { first: ["Hello, {name}."], mourn: ["{dead} was a good man."] } };
const VOICE = { voice: "god", name: "God", lines: { again: ["I see you."] } };
const people = (saveId: string, extra: Partial<PeoplePullResponse> = {}): PeoplePullResponse =>
  ({ ok: true, protocolVersion: 1, saveId, version: 3, people: [PERSON], voices: [VOICE], ...extra });
const REQUEST: KnoxFoundRequest = { requestId: "fr_abc123", saveId: "save_abc123", place: { x: 10600, y: 9400 }, radius: 150, building: "church",
  founding: "settled", name: "Father Brennan", female: false, profession: "pastor", reason: "The radio voice who prays every evening." };

class FakeApi implements KnoxApiTransport {
  peopleAsked: string[] = [];
  peopleAnswer: (saveId: string) => PeoplePullResponse = (saveId) => people(saveId);
  foundAsked = 0;
  request: KnoxFoundRequest | null = REQUEST;
  queued: string[] = [];
  fail?: Error;
  async sendConnectorTest(): Promise<KnoxPingResponse> { return { ok: true, protocolVersion: 1, message: "hello from Knox Relay" }; }
  async sendTelemetry(message: GameTelemetryMessage): Promise<KnoxTelemetryResponse> { return { ok: true, protocolVersion: 1, messageId: message.messageId }; }
  async pullMission(): Promise<MissionPullResponse> { return { ok: true, protocolVersion: 1, mission: null }; }
  async pullAudio(): Promise<AudioPullResponse> { return { ok: true, protocolVersion: 1, audio: null }; }
  async acknowledgeAudioQueued(audioId: AudioId): Promise<AudioQueuedResponse> { return { ok: true, protocolVersion: 1, audioId }; }
  async acknowledgeMissionQueued(missionId: MissionId): Promise<MissionQueuedResponse> { return { ok: true, protocolVersion: 1, missionId }; }
  async acknowledgeMissionCompleted(missionId: MissionId): Promise<MissionQueuedResponse> { return { ok: true, protocolVersion: 1, missionId }; }
  async acknowledgeMissionDeclined(missionId: MissionId): Promise<MissionQueuedResponse> { return { ok: true, protocolVersion: 1, missionId }; }
  async reportMissionState(_kind: string, missionId: MissionId): Promise<MissionQueuedResponse> { return { ok: true, protocolVersion: 1, missionId }; }
  async pullPeople(saveId: string): Promise<PeoplePullResponse> {
    this.peopleAsked.push(saveId);
    if (this.fail) throw this.fail;
    return this.peopleAnswer(saveId);
  }
  async pullFound(): Promise<FoundPullResponse> {
    this.foundAsked += 1;
    if (this.fail) throw this.fail;
    return { ok: true, protocolVersion: 1, request: this.request };
  }
  async acknowledgeFoundQueued(requestId: FoundRequestId): Promise<FoundQueuedResponse> {
    this.queued.push(requestId);
    this.request = null;
    return { ok: true, protocolVersion: 1, requestId };
  }
}

class QuietLogger extends KnoxLogger {
  lines: string[] = [];
  override info(message: string): void { this.lines.push(`info ${message}`); }
  override error(message: string): void { this.lines.push(`error ${message}`); }
  override log(_channel: string, message: string): void { this.lines.push(message); }
}

async function fixture() {
  const exchangeDirectory = await mkdtemp(path.join(os.tmpdir(), "knox-living-"));
  const paths = queuePaths(exchangeDirectory);
  await ensureQueueDirectories(paths);
  const api = new FakeApi();
  const logger = new QuietLogger();
  const config = { ...DEFAULT_CONFIG, exchangeDirectory, stableFileAgeMs: 1, missionSyncEndpoint: "https://example.invalid/sync", networkId: "network-1",
    connectionName: "Test relay", retryInitialMs: 1, retryMaxMs: 1, missionPollIntervalMs: 0 };
  return { exchangeDirectory, paths, api, logger, engine: new KnoxSyncEngine(config, logger, api) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const readJson = async (filePath: string) => JSON.parse(await readFile(filePath, "utf8"));

test("a people response validates with exactly its fields and the game's limits", () => {
  assert.equal(validatePeoplePullResponse(people("save_abc"), "save_abc").people[0]?.resident, "r1");
  assert.equal(validatePeoplePullResponse(people("save_abc", { version: 0, people: [], voices: [] }), "save_abc").version, 0);
  assert.equal(validatePeoplePullResponse(people("save_abc", { people: [{ ...PERSON, about: "", lines: { brandnew: ["x"] } }] }), "save_abc").people.length, 1,
    "an empty about and a new kind pass: the game checks kinds");
  const bad: Partial<Record<string, unknown>>[] = [{ saveId: "save_other" }, { version: -1 }, { version: 1.5 }, { extra: 1 },
    { people: [{ ...PERSON, holdout: "h-03" }] }, { people: [{ ...PERSON, about: "x".repeat(161) }] }, { people: [{ ...PERSON, lines: { first: ["a", "b", "c", "d"] } }] },
    { people: [{ ...PERSON, lines: { first: ["x".repeat(101)] } }] }, { people: [{ ...PERSON, lines: { First: ["x"] } }] }, { people: [{ ...PERSON, lines: { first: [""] } }] },
    { people: [{ ...PERSON, extra: 1 }] }, { voices: [{ ...VOICE, voice: "God" }] }, { voices: [{ ...VOICE, name: "" }] },
    { people: Array.from({ length: 201 }, () => PERSON) }, { voices: Array.from({ length: 21 }, () => VOICE) }];
  for (const change of bad) assert.throws(() => validatePeoplePullResponse({ ...people("save_abc"), ...change }, "save_abc"), /invalid people|too large/);
  // Within every per-field limit but over 256 KB as a whole.
  const lines = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`k${String.fromCharCode(97 + index)}`, ["x".repeat(100), "x".repeat(100), "x".repeat(100)]]));
  assert.throws(() => validatePeoplePullResponse(people("save_abc", { people: Array.from({ length: 200 }, () => ({ ...PERSON, lines })) }), "save_abc"), /too large/);
});

test("a found request validates with exactly the game's rules", () => {
  assert.equal(validateFoundRequest(REQUEST).building, "church");
  assert.equal(validateFoundRequest({ ...REQUEST, name: null, female: null, profession: null, founding: "arc", building: "any" }).name, null);
  for (const change of [{ requestId: "req_abc" }, { requestId: `fr_${"a".repeat(62)}` }, { saveId: "BAD" }, { place: { x: 1, y: 2, z: 0 } }, { place: { x: -1, y: 2 } },
    { place: { x: 30001, y: 2 } }, { place: { x: 1.5, y: 2 } }, { radius: 29 }, { radius: 601 }, { building: "castle" }, { founding: "now" },
    { name: "" }, { name: "x".repeat(41) }, { female: "yes" }, { profession: "soldier" }, { reason: "" }, { reason: "x".repeat(201) }, { extra: 1 }]) {
    assert.throws(() => validateFoundRequest({ ...REQUEST, ...change }), /invalid found request/);
  }
  const { name: _name, ...withoutName } = REQUEST;
  assert.throws(() => validateFoundRequest(withoutName), /invalid found request/, "unset fields are null, never missing");
  assert.equal(validateFoundPullResponse({ ok: true, protocolVersion: 1, request: null }).request, null);
  assert.throws(() => validateFoundPullResponse({ ok: true, protocolVersion: 1, request: null, mission: null }), /invalid found pull response/);
});

test("the people of the current save are written once, at once for a new save, without a file for version 0", async () => {
  const { exchangeDirectory, paths, api, engine } = await fixture();
  try {
    await engine.pollOnce();
    assert.deepEqual(api.peopleAsked, [], "no save known yet");

    engine.followSave("save_abc123");
    await engine.pollOnce();
    const filePath = path.join(paths.bridgePending, KNOX_PEOPLE_FILE);
    assert.deepEqual(await readJson(filePath), { protocolVersion: 1, saveId: "save_abc123", version: 3, people: [PERSON], voices: [VOICE] });

    // Not asked again within five minutes; a new save is asked at once.
    await engine.pollOnce();
    assert.deepEqual(api.peopleAsked, ["save_abc123"]);
    api.peopleAnswer = (saveId) => people(saveId, { version: 0, people: [], voices: [] });
    engine.followSave("save_def456");
    await engine.pollOnce();
    assert.deepEqual(api.peopleAsked, ["save_abc123", "save_def456"]);
    assert.equal((await readJson(filePath)).saveId, "save_abc123", "version 0: the file is left alone (the game checks its saveId)");
  } finally {
    await rm(exchangeDirectory, { recursive: true, force: true });
  }
});

test("an unchanged people file is not rewritten, a missing one is", async () => {
  const { exchangeDirectory, paths, engine, logger } = await fixture();
  try {
    engine.followSave("save_abc123");
    await engine.pollOnce();
    const writes = () => logger.lines.filter((line) => line.startsWith("people for")).length;
    assert.equal(writes(), 1);
    (engine as unknown as { nextPeoplePollAt: number }).nextPeoplePollAt = 0;
    await engine.pollOnce();
    assert.equal(writes(), 1, "same answer: no write");
    await unlink(path.join(paths.bridgePending, KNOX_PEOPLE_FILE));
    (engine as unknown as { nextPeoplePollAt: number }).nextPeoplePollAt = 0;
    await engine.pollOnce();
    assert.equal(writes(), 2);
  } finally {
    await rm(exchangeDirectory, { recursive: true, force: true });
  }
});

test("a pulled found request is written once without its null fields, listed in the index and confirmed", async () => {
  const { exchangeDirectory, paths, api, engine } = await fixture();
  try {
    api.request = { ...REQUEST, name: null, female: null };
    await engine.pollOnce();
    const written = await readJson(path.join(paths.bridgePending, `found_${REQUEST.requestId}.json`));
    const { name: _name, female: _female, ...rest } = REQUEST;
    assert.deepEqual(written, { protocolVersion: 1, ...rest, networkId: "network-1", connectionName: "Test relay" });
    assert.ok(!("name" in written) && !("female" in written));
    assert.deepEqual(api.queued, [REQUEST.requestId]);
    assert.deepEqual(await readJson(path.join(paths.bridgePending, KNOX_FOUND_INDEX_FILE)), { protocolVersion: 1, requestIds: [REQUEST.requestId] });

    // Delivered again (the backend missed the confirmation): not rewritten, confirmed again.
    api.request = REQUEST;
    await engine.pollOnce();
    assert.deepEqual(api.queued, [REQUEST.requestId, REQUEST.requestId]);
    assert.ok(!("name" in await readJson(path.join(paths.bridgePending, `found_${REQUEST.requestId}.json`))));
  } finally {
    await rm(exchangeDirectory, { recursive: true, force: true });
  }
});

test("foundFile keeps false and leaves out only null", () => {
  const file = foundFile({ ...REQUEST, female: false, profession: null }, { networkId: "n1", connectionName: "  " });
  assert.equal(file.female, false);
  assert.ok(!("profession" in file) && !("connectionName" in file));
  assert.equal(file.networkId, "n1");
});

test("the game's found_received_ack moves the request to processed and empties the index", async () => {
  const { exchangeDirectory, paths, engine } = await fixture();
  try {
    await engine.pollOnce();
    // As KnoxPeopleServer.ackFound writes it: messageId evt_<ms>_f<n>, saveId left out while the save is not linked.
    const ack = { protocolVersion: 1, messageId: "evt_1790000000000_f4821", type: "found_received_ack", createdAt: new Date().toISOString(),
      payload: { requestId: REQUEST.requestId, saveId: "save_abc123" } };
    assert.equal(validateFoundReceivedAcknowledgement(ack).payload.requestId, REQUEST.requestId);
    assert.equal(validateFoundReceivedAcknowledgement({ ...ack, payload: { requestId: REQUEST.requestId } }).payload.saveId, undefined);
    for (const payload of [{ requestId: "fr_X" }, { requestId: REQUEST.requestId, saveId: "BAD" }, { requestId: REQUEST.requestId, extra: 1 }]) {
      assert.throws(() => validateFoundReceivedAcknowledgement({ ...ack, payload }), /invalid found acknowledgement/);
    }
    await writeFile(path.join(paths.gamePending, "evt_1790000000000_f4821.json"), JSON.stringify(ack));
    await settle();
    await engine.pollOnce();
    assert.ok(!(await readdir(paths.bridgePending)).includes(`found_${REQUEST.requestId}.json`));
    assert.ok((await readdir(paths.bridgeProcessed)).includes(`found_${REQUEST.requestId}.json`));
    assert.deepEqual((await readJson(path.join(paths.bridgePending, KNOX_FOUND_INDEX_FILE))).requestIds, []);
    assert.ok((await readdir(paths.gameProcessed)).includes("evt_1790000000000_f4821.json"));

    // A processed request delivered again is only confirmed, never written back to pending.
    const api = (engine as unknown as { api: FakeApi }).api;
    api.request = REQUEST;
    await engine.pollOnce();
    assert.ok(!(await readdir(paths.bridgePending)).includes(`found_${REQUEST.requestId}.json`));
  } finally {
    await rm(exchangeDirectory, { recursive: true, force: true });
  }
});

test("a backend without these actions (HTTP 400) is reported once and asked again after five minutes", async () => {
  const { exchangeDirectory, api, engine, logger } = await fixture();
  try {
    api.fail = new Error("backend returned HTTP 400");
    engine.followSave("save_abc123");
    await engine.pollOnce();
    await engine.pollOnce();
    await engine.pollOnce();
    assert.deepEqual(api.peopleAsked, ["save_abc123"], "not asked again right away");
    assert.equal(api.foundAsked, 1);
    assert.equal(logger.lines.filter((line) => line.startsWith("error")).length, 0, "no errors in the log");
    assert.equal(logger.lines.filter((line) => line.includes("does not offer")).length, 2, "said once per action");
    const state = engine as unknown as { nextPeoplePollAt: number; nextFoundPollAt: number };
    assert.ok(state.nextPeoplePollAt > Date.now() + 4 * 60 * 1000 && state.nextFoundPollAt > Date.now() + 4 * 60 * 1000);

    // Other failures retry with the normal backoff and are logged.
    api.fail = new Error("backend returned HTTP 500");
    state.nextPeoplePollAt = 0;
    state.nextFoundPollAt = 0;
    await engine.pollOnce();
    assert.equal(logger.lines.filter((line) => line.startsWith("error")).length, 2);
  } finally {
    await rm(exchangeDirectory, { recursive: true, force: true });
  }
});
