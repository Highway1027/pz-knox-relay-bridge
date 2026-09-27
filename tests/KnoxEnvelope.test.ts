// tests/KnoxEnvelope.test.ts
// v1 - 27-09-2026 - Telemetry snapshot and open knox_ mission envelope checks

import assert from "node:assert/strict";
import test from "node:test";
import { validateGameTelemetry, validateMissionCompleted, validateMissionDeclined, validateMissionPullResponse, validateMissionReceivedAcknowledgement, validateTestMission } from "../src/protocol/KnoxValidators.js";

const telemetry = (payloadExtra: Record<string, unknown> = {}) => ({
  protocolVersion: 1, messageId: "evt_123", type: "game_telemetry", createdAt: "2026-09-27T12:00:00Z",
  payload: { gameTime: { year: 1993, month: 7, day: 9, hour: 12, minute: 0 }, players: [{ username: "tim", characterName: "Bob", x: 1, y: 2, z: 0 }], ...payloadExtra },
});

const snapshot = {
  schemaVersion: 1,
  world: { season: "Autumn", nightsSurvived: 7, rain: 0.4, electricityShutoffDay: 14 },
  players: [{ username: "tim", skills: { Woodwork: 5 }, traits: ["base:strong"], moodles: { HUNGRY: 2 }, infected: false, inventory: { items: 6, categories: { Food: 3 } } }],
  capabilities: { connectorVersion: "0.13.0", singleplayer: true, objectiveTypes: ["visit_area"], features: ["missions"] },
};

test("accepts telemetry without a snapshot (older Connectors)", () => {
  assert.doesNotThrow(() => validateGameTelemetry(telemetry()));
});

test("accepts telemetry with a bounded snapshot and keeps it intact", () => {
  const message = validateGameTelemetry(telemetry({ snapshot }));
  assert.deepEqual(message.payload.snapshot, snapshot);
});

test("rejects unknown payload fields next to the snapshot", () => {
  assert.throws(() => validateGameTelemetry(telemetry({ snapshot, extra: 1 })), /invalid payload/);
});

test("rejects a snapshot without a schema version, too deep, too large or with bad keys", () => {
  assert.throws(() => validateGameTelemetry(telemetry({ snapshot: { world: {} } })), /schemaVersion/);
  let deep: Record<string, unknown> = { leaf: 1 };
  for (let i = 0; i < 10; i += 1) deep = { inner: deep };
  assert.throws(() => validateGameTelemetry(telemetry({ snapshot: { schemaVersion: 1, deep } })), /nested too deeply/);
  const big = { schemaVersion: 1, players: Array.from({ length: 200 }, (_, i) => ({ note: "x".repeat(900), i })) };
  assert.throws(() => validateGameTelemetry(telemetry({ snapshot: big })), /too large/);
  assert.throws(() => validateGameTelemetry(telemetry({ snapshot: { schemaVersion: 1, "bad key!": 1 } })), /invalid key/);
  assert.throws(() => validateGameTelemetry(telemetry({ snapshot: { schemaVersion: 1, list: new Array(300).fill(0) } })), /too long/);
});

const openMission = {
  protocolVersion: 1, missionId: "knox_op_silent_tower_1", missionVersion: 2, title: "The Silent Tower",
  summary: "Dale thinks the old radio mast still works.", objectives: [{ type: "kill_count", count: 25, area: { x: 100, y: 200, z: 0, radius: 40 } }],
  rewards: [{ type: "xp", skill: "Electricity", amount: 80 }], arc: { id: "op_silent_tower", step: 1 },
};

test("accepts an open knox_ mission by envelope and leaves its content alone", () => {
  assert.deepEqual(validateTestMission(openMission), openMission);
  assert.doesNotThrow(() => validateMissionPullResponse({ ok: true, protocolVersion: 1, mission: openMission }));
});

test("rejects open missions with a bad envelope", () => {
  assert.throws(() => validateTestMission({ ...openMission, missionId: "knox_BAD" }));
  assert.throws(() => validateTestMission({ ...openMission, missionVersion: 0 }), /missionVersion/);
  assert.throws(() => validateTestMission({ ...openMission, title: "" }), /title/);
  assert.throws(() => validateTestMission({ ...openMission, protocolVersion: 2 }), /protocolVersion/);
  assert.throws(() => validateTestMission({ ...openMission, summary: "x".repeat(40000) }), /too (long|large)/);
});

test("still rejects unknown non-knox mission ids and changed curated missions", () => {
  assert.throws(() => validateTestMission({ ...openMission, missionId: "other_mod_1" }));
  assert.throws(() => validateTestMission({ protocolVersion: 1, missionId: "test_001", missionVersion: 1, title: "Changed", status: "active", objective: { type: "test", text: "x" }, reward: null, testFixture: null }), /invalid test mission/);
});

const event = (type: string, payload: Record<string, unknown>) => ({ protocolVersion: 1, messageId: "evt_9", type, createdAt: "2026-09-27T12:00:00Z", payload });

test("relays completion, decline and receipt events for open missions", () => {
  assert.doesNotThrow(() => validateMissionCompleted(event("mission_completed", { missionId: "knox_op_1", missionVersion: 3, objectiveType: "kill_count", completedBy: "tim" })));
  assert.doesNotThrow(() => validateMissionDeclined(event("mission_declined", { missionId: "knox_op_1", missionVersion: 3, declinedBy: "tim" })));
  assert.doesNotThrow(() => validateMissionReceivedAcknowledgement(event("mission_received_ack", { missionId: "knox_op_1" })));
});

test("keeps curated mission events strict", () => {
  assert.throws(() => validateMissionCompleted(event("mission_completed", { missionId: "mission_v02_recon_x", missionVersion: 2, objectiveType: "visit_area", completedBy: "tim" })));
  assert.throws(() => validateMissionCompleted(event("mission_completed", { missionId: "mission_v02_recon_x", missionVersion: 1, objectiveType: "kill_count", completedBy: "tim" })));
  assert.throws(() => validateMissionCompleted(event("mission_completed", { missionId: "knox_op_1", missionVersion: 1, objectiveType: "Kill Count!", completedBy: "tim" })));
});
