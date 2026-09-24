// src/protocol/KnoxProtocol.ts
// v3 - 23-09-2026 - Add minimal live game telemetry contracts

export const KNOX_PROTOCOL_VERSION = 1 as const;

export interface ConnectorTestMessage {
  protocolVersion: typeof KNOX_PROTOCOL_VERSION;
  messageId: string;
  type: "connector_test";
  createdAt: string;
  payload: {
    message: "hello from Project Zomboid";
  };
}

export interface ConnectorTestAcknowledgement {
  protocolVersion: typeof KNOX_PROTOCOL_VERSION;
  messageId: string;
  replyTo: string;
  type: "connector_test_ack";
  createdAt: string;
  payload: {
    ok: true;
    message: "hello from Knox Relay";
  };
}

export interface KnoxPingRequest {
  protocolVersion: typeof KNOX_PROTOCOL_VERSION;
  connectorVersion: string;
  message: "hello from Project Zomboid";
}

export interface KnoxPingResponse {
  ok: true;
  protocolVersion: typeof KNOX_PROTOCOL_VERSION;
  message: "hello from Knox Relay";
}

export interface GameTelemetryPlayer {
  username: string;
  characterName: string;
  x: number;
  y: number;
  z: number;
}

export interface GameTelemetryMessage {
  protocolVersion: typeof KNOX_PROTOCOL_VERSION;
  messageId: string;
  type: "game_telemetry";
  createdAt: string;
  payload: {
    gameTime: { year: number; month: number; day: number; hour: number; minute: number };
    players: GameTelemetryPlayer[];
  };
}

export interface KnoxTelemetryRequest extends GameTelemetryMessage {
  networkId: string;
  connectorVersion: string;
}

export interface KnoxTelemetryResponse {
  ok: true;
  protocolVersion: typeof KNOX_PROTOCOL_VERSION;
  messageId: string;
}
