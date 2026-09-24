// src/protocol/KnoxProtocol.ts
// v4 - 24-09-2026 - Add the Phase 4 test-mission transport contracts

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

export interface TestMission {
  protocolVersion: typeof KNOX_PROTOCOL_VERSION;
  missionId: "test_001";
  missionVersion: 1;
  title: "Connector Test Mission";
  status: "active";
  objective: {
    type: "test";
    text: "Verify Web to Project Zomboid mission transport.";
  };
}

export interface MissionPullResponse {
  ok: true;
  protocolVersion: typeof KNOX_PROTOCOL_VERSION;
  mission: TestMission | null;
}

export interface MissionQueuedResponse {
  ok: true;
  protocolVersion: typeof KNOX_PROTOCOL_VERSION;
  missionId: "test_001";
}

export interface MissionReceivedAcknowledgement {
  protocolVersion: typeof KNOX_PROTOCOL_VERSION;
  messageId: string;
  type: "mission_received_ack";
  createdAt: string;
  payload: { missionId: "test_001" };
}
