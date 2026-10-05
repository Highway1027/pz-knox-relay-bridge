// tests/KnoxRadioMessage.test.ts
// Radio messages outside missions (Bridge 0.2.10): pulled from the backend, written as message_<id>.json
// plus the knox_messages.json index, confirmed to the backend, and moved to processed on the game's ack.

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config/KnoxBridgeConfig.js";
import { ensureQueueDirectories, queuePaths } from "../src/files/KnoxQueue.js";
import type { KnoxApiTransport } from "../src/http/KnoxApiClient.js";
import { KnoxLogger } from "../src/logging/KnoxLogger.js";
import type { AudioId, AudioPullResponse, AudioQueuedResponse, GameTelemetryMessage, KnoxPingResponse, KnoxRadioMessage, KnoxTelemetryResponse, MessagePullResponse, MessageQueuedResponse, MissionId, MissionPullResponse, MissionQueuedResponse, RadioMessageId } from "../src/protocol/KnoxProtocol.js";
import { validateMessagePullResponse, validateMessageReceivedAcknowledgement, validateRadioMessage } from "../src/protocol/KnoxValidators.js";
import { KNOX_MESSAGE_INDEX_FILE, KnoxSyncEngine } from "../src/sync/KnoxSyncEngine.js";

const MESSAGE: KnoxRadioMessage = { protocolVersion: 1, messageId: "msg_arc_end_arc_abc", kind: "arc_end", saveId: "save_abc123",
  sender: "Maria", senderRole: "pharmacist", title: "The Pharmacist's Debt", text: "You did it. Thank you." };

class FakeApi implements KnoxApiTransport {
  message: KnoxRadioMessage | null = MESSAGE;
  queued: string[] = [];
  async sendConnectorTest(): Promise<KnoxPingResponse> { return { ok: true, protocolVersion: 1, message: "hello from Knox Relay" }; }
  async sendTelemetry(message: GameTelemetryMessage): Promise<KnoxTelemetryResponse> { return { ok: true, protocolVersion: 1, messageId: message.messageId }; }
  async pullMission(): Promise<MissionPullResponse> { return { ok: true, protocolVersion: 1, mission: null }; }
  async pullAudio(): Promise<AudioPullResponse> { return { ok: true, protocolVersion: 1, audio: null }; }
  async acknowledgeAudioQueued(audioId: AudioId): Promise<AudioQueuedResponse> { return { ok: true, protocolVersion: 1, audioId }; }
  async acknowledgeMissionQueued(missionId: MissionId): Promise<MissionQueuedResponse> { return { ok: true, protocolVersion: 1, missionId }; }
  async acknowledgeMissionCompleted(missionId: MissionId): Promise<MissionQueuedResponse> { return { ok: true, protocolVersion: 1, missionId }; }
  async acknowledgeMissionDeclined(missionId: MissionId): Promise<MissionQueuedResponse> { return { ok: true, protocolVersion: 1, missionId }; }
  async reportMissionState(_kind: string, missionId: MissionId): Promise<MissionQueuedResponse> { return { ok: true, protocolVersion: 1, missionId }; }
  async pullMessage(): Promise<MessagePullResponse> { return { ok: true, protocolVersion: 1, message: this.message }; }
  async acknowledgeMessageQueued(messageId: RadioMessageId): Promise<MessageQueuedResponse> {
    this.queued.push(messageId);
    this.message = null;
    return { ok: true, protocolVersion: 1, messageId };
  }
}

async function fixture() {
  const exchangeDirectory = await mkdtemp(path.join(os.tmpdir(), "knox-message-"));
  const paths = queuePaths(exchangeDirectory);
  await ensureQueueDirectories(paths);
  const api = new FakeApi();
  const config = { ...DEFAULT_CONFIG, exchangeDirectory, stableFileAgeMs: 1, missionSyncEndpoint: "https://example.invalid/sync", networkId: "network-1",
    retryInitialMs: 1, retryMaxMs: 1, missionPollIntervalMs: 0 };
  return { exchangeDirectory, paths, api, engine: new KnoxSyncEngine(config, new KnoxLogger(), api) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const readJson = async (filePath: string) => JSON.parse(await readFile(filePath, "utf8"));

test("a radio message validates with exactly its fields and limits", () => {
  assert.equal(validateRadioMessage(MESSAGE).sender, "Maria");
  assert.equal(validateRadioMessage({ ...MESSAGE, saveId: null, senderRole: null, title: null }).saveId, null);
  assert.equal(validateRadioMessage({ ...MESSAGE, kind: "contact_note" }).kind, "contact_note", "new kinds pass: the Bridge is transport only");
  for (const bad of [{ messageId: "evt_1" }, { kind: "Arc End" }, { saveId: "BAD" }, { sender: "" }, { text: "x".repeat(401) },
    { title: "x".repeat(61) }, { senderRole: "" }, { extra: 1 }]) {
    assert.throws(() => validateRadioMessage({ ...MESSAGE, ...bad }), /invalid radio message/);
  }
  assert.equal(validateMessagePullResponse({ ok: true, protocolVersion: 1, message: null }).message, null);
  assert.throws(() => validateMessagePullResponse({ ok: true, protocolVersion: 1, message: null, mission: null }), /invalid message pull response/);
});

test("a pulled message is written once with the network id, listed in the index and confirmed", async () => {
  const { exchangeDirectory, paths, api, engine } = await fixture();
  try {
    await engine.pollOnce();
    const written = await readJson(path.join(paths.bridgePending, `message_${MESSAGE.messageId}.json`));
    assert.deepEqual(written, { ...MESSAGE, networkId: "network-1" });
    assert.deepEqual(api.queued, [MESSAGE.messageId]);
    assert.deepEqual((await readJson(path.join(paths.bridgePending, KNOX_MESSAGE_INDEX_FILE))).messageIds, [MESSAGE.messageId]);

    // Delivered again (the backend missed the confirmation): not rewritten, confirmed again.
    api.message = MESSAGE;
    await engine.pollOnce();
    assert.deepEqual(api.queued, [MESSAGE.messageId, MESSAGE.messageId]);
  } finally {
    await rm(exchangeDirectory, { recursive: true, force: true });
  }
});

test("the game's ack moves the message to processed and empties the index", async () => {
  const { exchangeDirectory, paths, engine } = await fixture();
  try {
    await engine.pollOnce();
    const ack = { protocolVersion: 1, messageId: "evt_1790000000000_7", type: "message_received_ack", createdAt: new Date().toISOString(),
      payload: { messageId: MESSAGE.messageId } };
    assert.equal(validateMessageReceivedAcknowledgement(ack).payload.messageId, MESSAGE.messageId);
    await writeFile(path.join(paths.gamePending, "message_ack_evt_1790000000000_7.json"), JSON.stringify(ack));
    await settle();
    await engine.pollOnce();
    assert.ok(!(await readdir(paths.bridgePending)).includes(`message_${MESSAGE.messageId}.json`));
    assert.ok((await readdir(paths.bridgeProcessed)).includes(`message_${MESSAGE.messageId}.json`));
    assert.deepEqual((await readJson(path.join(paths.bridgePending, KNOX_MESSAGE_INDEX_FILE))).messageIds, []);
    assert.ok((await readdir(paths.gameProcessed)).includes("message_ack_evt_1790000000000_7.json"));
  } finally {
    await rm(exchangeDirectory, { recursive: true, force: true });
  }
});
