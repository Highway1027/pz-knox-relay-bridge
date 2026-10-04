// tests/KnoxApiClient.test.ts
// v5 - 26-09-2026 - Verify hardened dynamic recon and decline validation

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config/KnoxBridgeConfig.js";
import { KnoxApiClient } from "../src/http/KnoxApiClient.js";
import { validateAudioPullResponse, validateMissionDeclined, validateMission } from "../src/protocol/KnoxValidators.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address");
  return `http://127.0.0.1:${address.port}/knoxConnectorPing`;
}

test("posts the exact ping schema and validates the response", async () => {
  let received: unknown;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received = JSON.parse(body);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, protocolVersion: 1, message: "hello from Knox Relay" }));
    });
  });
  try {
    const syncEndpoint = await listen(server);
    const client = new KnoxApiClient({ ...DEFAULT_CONFIG, syncEndpoint });
    const result = await client.sendConnectorTest("hello from Project Zomboid");
    assert.deepEqual(received, {
      protocolVersion: 1,
      connectorVersion: "0.2.8",
      message: "hello from Project Zomboid",
    });
    assert.equal(result.message, "hello from Knox Relay");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("aborts a request at the configured timeout", async () => {
  const server = createServer((_request, response) => {
    setTimeout(() => response.end("{}"), 100);
  });
  try {
    const syncEndpoint = await listen(server);
    const client = new KnoxApiClient({ ...DEFAULT_CONFIG, syncEndpoint, httpTimeoutMs: 10 });
    await assert.rejects(client.sendConnectorTest("hello from Project Zomboid"), /timed out after 10ms/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("posts telemetry with Network association and connector token", async () => {
  let received: any; let receivedToken = "";
  const server = createServer((request, response) => {
    let body = ""; request.setEncoding("utf8"); request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => { received = JSON.parse(body); receivedToken = String(request.headers["x-knox-connector-token"]); response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ ok: true, protocolVersion: 1, messageId: received.messageId })); });
  });
  try {
    const telemetryEndpoint = await listen(server);
    const client = new KnoxApiClient({ ...DEFAULT_CONFIG, telemetryEndpoint, networkId: "network-1", connectorToken: "secret" });
    await client.sendTelemetry({ protocolVersion: 1, messageId: "evt_telemetry_api", type: "game_telemetry", createdAt: new Date().toISOString(), payload: { gameTime: { year: 1993, month: 7, day: 9, hour: 12, minute: 0 }, players: [{ username: "Tim", characterName: "Tim Knox", x: 1, y: 2, z: 0 }] } });
    assert.equal(received.networkId, "network-1"); assert.equal(received.connectorVersion, "0.2.8"); assert.equal(receivedToken, "secret");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("pulls and acknowledges an open mission", async () => {
  const actions: any[] = [];
  const server = createServer((request, response) => {
    let body = ""; request.setEncoding("utf8"); request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const value = JSON.parse(body); actions.push(value);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value.action === "pull"
        ? { ok: true, protocolVersion: 1, mission: { protocolVersion: 1, missionId: "knox_transport_check_1", missionVersion: 1, title: "Transport Check", summary: "Checks transport.", objectives: [] } }
        : { ok: true, protocolVersion: 1, missionId: value.missionId }));
    });
  });
  try {
    const missionSyncEndpoint = await listen(server);
    const client = new KnoxApiClient({ ...DEFAULT_CONFIG, missionSyncEndpoint, networkId: "network-1", connectorToken: "secret" });
    assert.equal((await client.pullMission()).mission?.missionId, "knox_transport_check_1");
    await client.acknowledgeMissionQueued("knox_transport_check_1");
    assert.deepEqual(actions.map((value) => value.action), ["pull", "queued"]);
    assert.equal(actions[0].networkId, "network-1");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("pulls and acknowledges a WAV using the Bridge token", async () => {
  const wav = Buffer.alloc(44);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.write("data", 36, "ascii");
  const audioId = "audio_0123456789abcdef0123456789abcdef";
  const audio = {
    audioId, fileName: "clip.wav", fileSizeBytes: wav.length, durationSeconds: 0.01,
    sha256: createHash("sha256").update(wav).digest("hex"), audioBase64: wav.toString("base64"),
  };
  const actions: any[] = [];
  let receivedToken = "";
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const value = JSON.parse(body);
      actions.push(value);
      receivedToken = String(request.headers["x-knox-connector-token"]);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value.action === "pull"
        ? { ok: true, protocolVersion: 1, audio }
        : { ok: true, protocolVersion: 1, audioId }));
    });
  });
  try {
    const audioSyncEndpoint = await listen(server);
    const client = new KnoxApiClient({ ...DEFAULT_CONFIG, audioSyncEndpoint, networkId: "network-1", connectorToken: "secret" });
    assert.equal((await client.pullAudio()).audio?.audioId, audioId);
    await client.acknowledgeAudioQueued(audioId);
    assert.deepEqual(actions.map((value) => value.action), ["pull", "queued"]);
    assert.equal(actions[0].networkId, "network-1");
    assert.equal(receivedToken, "secret");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("rejects a WAV with a mismatched checksum", () => {
  const wav = Buffer.alloc(44);
  wav.write("RIFF", 0, "ascii");
  wav.write("WAVE", 8, "ascii");
  const audio = {
    audioId: "audio_0123456789abcdef0123456789abcdef",
    fileName: "clip.wav",
    fileSizeBytes: wav.length,
    durationSeconds: null,
    sha256: "0".repeat(64),
    audioBase64: wav.toString("base64"),
  };
  assert.throws(() => validateAudioPullResponse({ ok: true, protocolVersion: 1, audio }), /checksum/);
});

test('validates a dynamic verified-location recon without changing mechanics', () => {
  const mission = { protocolVersion: 1, missionId: 'mission_v02_recon_fallas_lake_residential_spawn', missionVersion: 1,
    title: 'Recon: Fallas Lake', status: 'available',
    objective: { type: 'visit_area', text: 'Reach the verified area and report in.', area: { type: 'radius', x: 7213, y: 8288, z: 0, radius: 60, name: 'Fallas Lake residential spawn area' } },
    reward: { type: 'xp', rewardId: 'reward_mission_v02_recon_fallas_lake_residential_spawn', perk: 'Woodwork', amount: 75 }, testFixture: null,
    location: { locationId: 'fallas_lake_residential_spawn', name: 'Fallas Lake residential spawn area', town: 'Fallas Lake', navigation: { nearestNamedPlace: 'Fallas Lake' } },
    navigationContext: { distanceTiles: 1400, direction: 'NW', reference: 'party' },
    chain: { chainId: 'knox_relay_v02', stage: 1, requiresCompleted: [] },
    narrative: { briefing: 'Conditions unknown.', shortObjective: 'Reach the area.', arrivalMessage: 'Signal acquired.', completionMessage: 'Confirmed.' } };
  assert.equal(validateMission(mission).missionId, mission.missionId);
  assert.throws(() => validateMission({ ...mission, objective: { ...mission.objective, area: { ...mission.objective.area, x: 'AI says here' } } }), /invalid curated visit mission/);
  assert.throws(() => validateMission({ ...mission, reward: { ...mission.reward, amount: 999 } }), /invalid curated visit mission/);
});

test('keeps legacy curated visit payloads compatible without navigation context', () => {
  const mission = { protocolVersion: 1, missionId: 'mission_v0_muldraugh_checkin', missionVersion: 1,
    title: 'Local Signal Check', status: 'available',
    objective: { type: 'visit_area', text: 'Reach the verified Muldraugh area and establish contact.', area: { type: 'radius', x: 10997, y: 9699, z: 0, radius: 60, name: 'Muldraugh residential spawn area' } },
    reward: { type: 'xp', rewardId: 'reward_mission_v0_muldraugh_checkin', perk: 'Woodwork', amount: 75 }, testFixture: null,
    location: { locationId: 'muldraugh_residential_spawn', name: 'Muldraugh residential spawn area', town: 'Muldraugh' },
    chain: { chainId: 'knox_relay_v0', stage: 1, requiresCompleted: [] },
    narrative: { briefing: 'Conditions unknown.', shortObjective: 'Reach the area.', arrivalMessage: 'Signal acquired.', completionMessage: 'Confirmed.' } };
  assert.equal(validateMission(mission).missionId, mission.missionId);
});

test('validates the durable shared decline event', () => {
  const event = { protocolVersion: 1, messageId: 'evt_decline_001', type: 'mission_declined', createdAt: new Date().toISOString(),
    payload: { missionId: 'mission_v02_recon_fallas_lake_residential_spawn', missionVersion: 1, declinedBy: 'steam:123' } };
  assert.equal(validateMissionDeclined(event).payload.missionId, event.payload.missionId);
  assert.throws(() => validateMissionDeclined({ ...event, payload: { ...event.payload, declinedBy: '' } }), /invalid mission decline/);
});
