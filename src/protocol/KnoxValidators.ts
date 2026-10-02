// src/protocol/KnoxValidators.ts
// v7 - 27-09-2026 - Optional telemetry snapshot and open knox_ missions (envelope checks)

import { ENVELOPE_MISSION_ID, validateEnvelopeMission, validateSnapshot } from "./KnoxEnvelope.js";
import { KNOX_PROTOCOL_VERSION, type ConnectorTestMessage, type GameTelemetryMessage, type KnoxPingResponse, type KnoxTelemetryResponse, type MissionPullResponse, type MissionQueuedResponse, type MissionReceivedAcknowledgement, type MissionCompletedMessage, type MissionDeclinedMessage, type MissionStateMessage, type MissionStateKind, type ConnectorMission, type MissionId } from "./KnoxProtocol.js";

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
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      !(exactKeys(payload, ["gameTime", "players"]) || exactKeys(payload, ["gameTime", "players", "snapshot"]))) throw new Error("invalid payload");
  if (payload.snapshot !== undefined) validateSnapshot(payload.snapshot);
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

function isMissionId(value: unknown): value is MissionId {
  return typeof value === "string" && (/^mission_v0[2]?_[a-z0-9_]{1,96}$/.test(value) || ENVELOPE_MISSION_ID.test(value));
}

function isEnvelopeMissionId(value: unknown): boolean {
  return typeof value === "string" && ENVELOPE_MISSION_ID.test(value);
}

export function validateMission(value: unknown): ConnectorMission {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("mission must be an object");
  const mission = value as Record<string, unknown>;
  // Open missions from the mission engine: envelope only, content is validated by the Connector.
  if (isEnvelopeMissionId(mission.missionId)) return validateEnvelopeMission(mission) as unknown as ConnectorMission;
  if (!isMissionId(mission.missionId)) throw new Error("invalid mission ID");
  const curatedKeys = ["protocolVersion", "missionId", "missionVersion", "title", "status", "objective", "reward", "testFixture", "location", "chain", "narrative"];
  if (!(exactKeys(mission, curatedKeys) || exactKeys(mission, [...curatedKeys, "navigationContext"]))) throw new Error("unexpected mission fields");
  // Curated (mission_v0_) and dynamic recon (mission_v02_recon_) visit missions.
  const objective = mission.objective as Record<string, unknown>;
  const area = objective?.area as Record<string, unknown>;
  const location = mission.location as Record<string, unknown>;
  const chain = mission.chain as Record<string, unknown>;
  const narrative = mission.narrative as Record<string, unknown>;
  const navigation = mission.navigationContext as Record<string, unknown> | null;
  const reward = mission.reward as Record<string, unknown>;
  const dynamic = typeof mission.missionId === 'string' && mission.missionId.startsWith('mission_v02_recon_');
  const dynamicLocationId = dynamic ? mission.missionId.slice('mission_v02_recon_'.length) : null;
  if (mission.protocolVersion !== 1 || mission.missionVersion !== 1 || mission.status !== 'available' || mission.testFixture !== null ||
      !objective || objective.type !== 'visit_area' || typeof objective.text !== 'string' || !area || area.type !== 'radius' ||
      ![area.x, area.y, area.z, area.radius].every((entry) => typeof entry === 'number' && Number.isInteger(entry)) ||
      Number(area.x) < 0 || Number(area.x) > 1000000 || Number(area.y) < 0 || Number(area.y) > 1000000 ||
      Number(area.z) < 0 || Number(area.z) > 32 || Number(area.radius) < 1 || Number(area.radius) > 500 ||
      typeof area.name !== 'string' || area.name.length < 1 || area.name.length > 128 || !location ||
      typeof location.locationId !== 'string' || typeof location.town !== 'string' || typeof location.name !== 'string' ||
      (dynamic && (location.locationId !== dynamicLocationId || !reward || reward.type !== 'xp' ||
        reward.rewardId !== `reward_${mission.missionId}` || reward.perk !== 'Woodwork' || reward.amount !== 75)) ||
      !chain || typeof chain.chainId !== 'string' || !Number.isInteger(chain.stage) || !Array.isArray(chain.requiresCompleted) ||
      (navigation != null && (typeof navigation.distanceTiles !== 'number' || !Number.isInteger(navigation.distanceTiles) || navigation.distanceTiles < 0 ||
        !['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'here'].includes(String(navigation.direction)) || typeof navigation.reference !== 'string')) ||
      !narrative || !['briefing', 'shortObjective', 'arrivalMessage', 'completionMessage'].every((key) => typeof narrative[key] === 'string'))
    throw new Error('invalid curated visit mission');
  return mission as unknown as ConnectorMission;
}

export function validateMissionPullResponse(value: unknown): MissionPullResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response root must be an object");
  const response = value as Record<string, unknown>;
  if (!exactKeys(response, ["ok", "protocolVersion", "mission"]) || response.ok !== true || response.protocolVersion !== 1) throw new Error("invalid mission pull response");
  if (response.mission !== null) validateMission(response.mission);
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

// Save identity from the Connector (MISSION_API 13.9); the backend checks the same pattern.
export const SAVE_ID_PATTERN = /^save_[a-z0-9]{1,40}$/;

// Exact payload keys, optionally plus a valid saveId.
function payloadKeysWithSave(payload: Record<string, unknown>, keys: string[]): boolean {
  if (exactKeys(payload, keys)) return true;
  return exactKeys(payload, [...keys, "saveId"]) && typeof payload.saveId === "string" && SAVE_ID_PATTERN.test(payload.saveId);
}

// Curated missions are always version 1; open missions may be revised.
function validMissionVersion(missionId: unknown, version: unknown): boolean {
  if (isEnvelopeMissionId(missionId)) return Number.isInteger(version) && Number(version) >= 1 && Number(version) <= 100000;
  return version === 1;
}

export function validateMissionCompleted(value: unknown): MissionCompletedMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('message root must be an object');
  const message = value as Record<string, unknown>;
  const payload = message.payload as Record<string, unknown>;
  if (!exactKeys(message, ['protocolVersion', 'messageId', 'type', 'createdAt', 'payload']) || message.protocolVersion !== 1 ||
      message.type !== 'mission_completed' || typeof message.messageId !== 'string' || !MESSAGE_ID_PATTERN.test(message.messageId) ||
      typeof message.createdAt !== 'string' || Number.isNaN(Date.parse(message.createdAt)) || !payload || Array.isArray(payload) ||
      !payloadKeysWithSave(payload, ['missionId', 'missionVersion', 'objectiveType', 'completedBy']) || !isMissionId(payload.missionId) ||
      !validMissionVersion(payload.missionId, payload.missionVersion) || typeof payload.completedBy !== 'string' ||
      (isEnvelopeMissionId(payload.missionId) ? typeof payload.objectiveType !== 'string' || !/^[a-z_]{1,40}$/.test(payload.objectiveType)
        : payload.objectiveType !== 'visit_area'))
    throw new Error('invalid mission completion');
  return message as unknown as MissionCompletedMessage;
}

export function validateMissionDeclined(value: unknown): MissionDeclinedMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('message root must be an object');
  const message = value as Record<string, unknown>;
  const payload = message.payload as Record<string, unknown>;
  if (!exactKeys(message, ['protocolVersion', 'messageId', 'type', 'createdAt', 'payload']) || message.protocolVersion !== 1 ||
      message.type !== 'mission_declined' || typeof message.messageId !== 'string' || !MESSAGE_ID_PATTERN.test(message.messageId) ||
      typeof message.createdAt !== 'string' || Number.isNaN(Date.parse(message.createdAt)) || !payload || Array.isArray(payload) ||
      !payloadKeysWithSave(payload, ['missionId', 'missionVersion', 'declinedBy']) || !isMissionId(payload.missionId) ||
      !validMissionVersion(payload.missionId, payload.missionVersion) || typeof payload.declinedBy !== 'string' || payload.declinedBy.length < 1)
    throw new Error('invalid mission decline');
  return message as unknown as MissionDeclinedMessage;
}

// The one extra payload field of each state event, a string of 1 to 200 characters.
export const MISSION_STATE_FIELDS: Readonly<Record<MissionStateKind, string>> = { accepted: "acceptedBy", abandoned: "abandonedBy", failed: "reason", expired: "reason" };

export function missionStateKind(type: unknown): MissionStateKind | undefined {
  const kind = typeof type === "string" && type.startsWith("mission_") ? type.slice(8) : "";
  return Object.hasOwn(MISSION_STATE_FIELDS, kind) ? kind as MissionStateKind : undefined;
}

export function validateMissionState(value: unknown): MissionStateMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("message root must be an object");
  const message = value as Record<string, unknown>;
  const payload = message.payload as Record<string, unknown>;
  const kind = missionStateKind(message.type);
  const field = kind ? MISSION_STATE_FIELDS[kind] : "";
  if (!kind || !exactKeys(message, ["protocolVersion", "messageId", "type", "createdAt", "payload"]) || message.protocolVersion !== 1 ||
      typeof message.messageId !== "string" || !MESSAGE_ID_PATTERN.test(message.messageId) ||
      typeof message.createdAt !== "string" || Number.isNaN(Date.parse(message.createdAt)) || !payload || typeof payload !== "object" || Array.isArray(payload) ||
      !payloadKeysWithSave(payload, ["missionId", "missionVersion", field]) || !isMissionId(payload.missionId) ||
      !validMissionVersion(payload.missionId, payload.missionVersion) || typeof payload[field] !== "string" ||
      (payload[field] as string).length < 1 || (payload[field] as string).length > 200)
    throw new Error("invalid mission state event");
  return message as unknown as MissionStateMessage;
}
