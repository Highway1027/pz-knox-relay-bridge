// src/protocol/KnoxValidators.ts
// v3 - 25-09-2026 - Strictly validate Phase 6B area fixtures

import { KNOX_PROTOCOL_VERSION, type ConnectorTestMessage, type GameTelemetryMessage, type KnoxPingResponse, type KnoxTelemetryResponse, type MissionPullResponse, type MissionQueuedResponse, type MissionReceivedAcknowledgement, type ConnectorMission, type MissionId } from "./KnoxProtocol.js";

const MESSAGE_ID_PATTERN = /^evt_[A-Za-z0-9_-]{1,96}$/;

export function validateConnectorTest(value: unknown): ConnectorTestMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("message root must be an object");
  }

  const candidate = value as Record<string, unknown>;
  const payload = candidate.payload;

  if (candidate.protocolVersion !== KNOX_PROTOCOL_VERSION) throw new Error("unsupported protocolVersion");
  if (candidate.type !== "connector_test") throw new Error("unsupported message type");
  if (typeof candidate.messageId !== "string" || !MESSAGE_ID_PATTERN.test(candidate.messageId)) throw new Error("invalid messageId");
  if (typeof candidate.createdAt !== "string" || Number.isNaN(Date.parse(candidate.createdAt))) throw new Error("invalid createdAt");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("payload must be an object");
  if ((payload as Record<string, unknown>).message !== "hello from Project Zomboid") throw new Error("unexpected connector test message");

  return candidate as unknown as ConnectorTestMessage;
}

export function validatePingResponse(value: unknown): KnoxPingResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response root must be an object");
  const candidate = value as Record<string, unknown>;
  if (candidate.ok !== true) throw new Error("backend did not acknowledge the request");
  if (candidate.protocolVersion !== KNOX_PROTOCOL_VERSION) throw new Error("backend returned an unsupported protocolVersion");
  if (candidate.message !== "hello from Knox Relay") throw new Error("backend returned an unexpected message");
  return candidate as unknown as KnoxPingResponse;
}

const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");

export function validateGameTelemetry(value: unknown): GameTelemetryMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("message root must be an object");
  const message = value as Record<string, unknown>;
  if (!exactKeys(message, ["protocolVersion", "messageId", "type", "createdAt", "payload"])) throw new Error("unexpected message fields");
  if (message.protocolVersion !== 1 || message.type !== "game_telemetry") throw new Error("unsupported telemetry message");
  if (typeof message.messageId !== "string" || !MESSAGE_ID_PATTERN.test(message.messageId)) throw new Error("invalid messageId");
  if (typeof message.createdAt !== "string" || Number.isNaN(Date.parse(message.createdAt))) throw new Error("invalid createdAt");
  const payload = message.payload as Record<string, unknown>;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !exactKeys(payload, ["gameTime", "players"])) throw new Error("invalid payload");
  const gameTime = payload.gameTime as Record<string, unknown>;
  if (!gameTime || typeof gameTime !== "object" || Array.isArray(gameTime) || !exactKeys(gameTime, ["year", "month", "day", "hour", "minute"])) throw new Error("invalid gameTime");
  const time = [gameTime.year, gameTime.month, gameTime.day, gameTime.hour, gameTime.minute];
  if (!time.every(Number.isInteger) || Number(gameTime.month) < 1 || Number(gameTime.month) > 12 || Number(gameTime.day) < 1 || Number(gameTime.day) > 31 || Number(gameTime.hour) < 0 || Number(gameTime.hour) > 23 || Number(gameTime.minute) < 0 || Number(gameTime.minute) > 59) throw new Error("invalid gameTime value");
  if (!Array.isArray(payload.players) || payload.players.length < 1 || payload.players.length > 32) throw new Error("players must contain 1-32 entries");
  for (const playerValue of payload.players) {
    if (!playerValue || typeof playerValue !== "object" || Array.isArray(playerValue)) throw new Error("invalid player entry");
    const player = playerValue as Record<string, unknown>;
    if (!exactKeys(player, ["username", "characterName", "x", "y", "z"])) throw new Error("unexpected player fields");
    if (typeof player.username !== "string" || player.username.length < 1 || player.username.length > 64 || typeof player.characterName !== "string" || player.characterName.length < 1 || player.characterName.length > 128) throw new Error("invalid player identity");
    if (![player.x, player.y, player.z].every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate) && Math.abs(coordinate) <= 1000000)) throw new Error("invalid player coordinates");
  }
  return message as unknown as GameTelemetryMessage;
}

export function validateTelemetryResponse(value: unknown, messageId: string): KnoxTelemetryResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response root must be an object");
  const response = value as Record<string, unknown>;
  if (response.ok !== true || response.protocolVersion !== 1 || response.messageId !== messageId) throw new Error("backend did not acknowledge telemetry");
  return response as unknown as KnoxTelemetryResponse;
}

const MISSIONS = {
  test_001: { title: "Connector Test Mission", status: "active", objective: { type: "test", text: "Verify Web to Project Zomboid mission transport." }, reward: null, testFixture: null },
  test_002: { title: "Emergency Field Dressing", status: "active", objective: { type: "test", text: "Confirm one shared item reward reaches every known survivor." }, reward: { type: "item", rewardId: "test_reward_item_001", itemFullType: "Base.Bandage", quantity: 1 }, testFixture: null },
  test_003: { title: "Carpentry Training Broadcast", status: "active", objective: { type: "test", text: "Confirm one shared mission grants each survivor 100 Woodwork XP." }, reward: { type: "xp", rewardId: "test_reward_xp_001", perk: "Woodwork", amount: 100 }, testFixture: null },
  test_004: { title: "Network Learning Doctrine", status: "active", objective: { type: "test", text: "Confirm one shared world reward increases the global XP multiplier by 0.10." }, reward: { type: "world_xp_multiplier", rewardId: "test_reward_world_xp_001", delta: 0.1 }, testFixture: null },
  test_005: { title: "Supply Requisition", status: "available", objective: { type: "deliver_items", text: "Deliver the requested medical supplies to the shared Knox Drop Box.", requirements: [{ itemType: "Base.Bandage", quantity: 3 }, { itemType: "Base.RippedSheets", quantity: 2 }], deliveryArea: null }, reward: { type: "xp", rewardId: "test_reward_xp_002", perk: "Woodwork", amount: 50 }, testFixture: { provisionRequirementsOnAccept: true } },
  test_006: { title: "Nearby Localized Supply Drop", status: "available", objective: { type: "deliver_items", text: "Deliver medical supplies inside the nearby test area.", requirements: [{ itemType: "Base.Bandage", quantity: 3 }, { itemType: "Base.RippedSheets", quantity: 2 }] }, reward: { type: "xp", rewardId: "test_reward_xp_003", perk: "Woodwork", amount: 50 }, testFixture: { provisionRequirementsOnAccept: true, kind: "nearby" } },
  test_007: { title: "Distant Localized Supply Drop", status: "available", objective: { type: "deliver_items", text: "Deliver medical supplies inside the distant test area.", requirements: [{ itemType: "Base.Bandage", quantity: 3 }, { itemType: "Base.RippedSheets", quantity: 2 }] }, reward: { type: "xp", rewardId: "test_reward_xp_004", perk: "Woodwork", amount: 50 }, testFixture: { provisionRequirementsOnAccept: true, kind: "distant" } },
} as const;

function isMissionId(value: unknown): value is MissionId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(MISSIONS, value);
}

function exactJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validAreaObjective(value: unknown, expected: (typeof MISSIONS)["test_006" | "test_007"]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const objective = value as Record<string, unknown>;
  if (!exactKeys(objective, ["type", "text", "requirements", "deliveryArea"]) ||
      objective.type !== expected.objective.type || objective.text !== expected.objective.text ||
      !exactJson(objective.requirements, expected.objective.requirements)) return false;
  const area = objective.deliveryArea as Record<string, unknown>;
  if (!area || typeof area !== "object" || Array.isArray(area) ||
      !exactKeys(area, ["type", "x", "y", "z", "radius", "name"])) return false;
  return area.type === "radius" && area.radius === 20 &&
    [area.x, area.y, area.z].every((coordinate) => typeof coordinate === "number" && Number.isInteger(coordinate) && coordinate >= 0 && coordinate <= 1000000) &&
    typeof area.name === "string" && area.name.length >= 1 && area.name.length <= 96;
}

export function validateTestMission(value: unknown): ConnectorMission {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("mission must be an object");
  const mission = value as Record<string, unknown>;
  if (!exactKeys(mission, ["protocolVersion", "missionId", "missionVersion", "title", "status", "objective", "reward", "testFixture"])) throw new Error("unexpected mission fields");
  if (!isMissionId(mission.missionId)) throw new Error("invalid test mission ID");
  const expected = MISSIONS[mission.missionId];
  const objectiveValid = mission.missionId === "test_006" || mission.missionId === "test_007"
    ? validAreaObjective(mission.objective, MISSIONS[mission.missionId])
    : exactJson(mission.objective, expected.objective);
  if (mission.protocolVersion !== 1 || mission.missionVersion !== 1 || mission.title !== expected.title || mission.status !== expected.status ||
      !objectiveValid || !exactJson(mission.reward, expected.reward) ||
      !exactJson(mission.testFixture, expected.testFixture)) {
    throw new Error("invalid test mission");
  }
  return mission as unknown as ConnectorMission;
}

export function validateMissionPullResponse(value: unknown): MissionPullResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response root must be an object");
  const response = value as Record<string, unknown>;
  if (!exactKeys(response, ["ok", "protocolVersion", "mission"]) || response.ok !== true || response.protocolVersion !== 1) throw new Error("invalid mission pull response");
  if (response.mission !== null) validateTestMission(response.mission);
  return response as unknown as MissionPullResponse;
}

export function validateMissionQueuedResponse(value: unknown): MissionQueuedResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response root must be an object");
  const response = value as Record<string, unknown>;
  if (response.ok !== true || response.protocolVersion !== 1 || !isMissionId(response.missionId)) throw new Error("backend did not acknowledge queued mission");
  return response as unknown as MissionQueuedResponse;
}

export function validateMissionReceivedAcknowledgement(value: unknown): MissionReceivedAcknowledgement {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("message root must be an object");
  const message = value as Record<string, unknown>;
  const payload = message.payload as Record<string, unknown>;
  if (!exactKeys(message, ["protocolVersion", "messageId", "type", "createdAt", "payload"]) || message.protocolVersion !== 1 ||
      message.type !== "mission_received_ack" || typeof message.messageId !== "string" || !MESSAGE_ID_PATTERN.test(message.messageId) ||
      typeof message.createdAt !== "string" || Number.isNaN(Date.parse(message.createdAt)) || !payload || typeof payload !== "object" ||
      Array.isArray(payload) || !exactKeys(payload, ["missionId"]) || !isMissionId(payload.missionId)) throw new Error("invalid mission acknowledgement");
  return message as unknown as MissionReceivedAcknowledgement;
}
