// src/protocol/KnoxValidators.ts
// v2 - 23-09-2026 - Validate local input and the Phase 2 backend response

import { KNOX_PROTOCOL_VERSION, type ConnectorTestMessage, type GameTelemetryMessage, type KnoxPingResponse, type KnoxTelemetryResponse } from "./KnoxProtocol.js";

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
