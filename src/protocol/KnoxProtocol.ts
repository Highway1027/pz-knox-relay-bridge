// src/protocol/KnoxProtocol.ts
// v5 - 25-09-2026 - Add Phase 6B delivery-area mission contracts

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

export type MissionId = "test_001" | "test_002" | "test_003" | "test_004" | "test_005" | "test_006" | "test_007";

export interface DeliveryArea {
  type: "radius";
  x: number;
  y: number;
  z: number;
  radius: 20;
  name: string;
}

export type MissionReward =
  | { type: "item"; rewardId: "test_reward_item_001"; itemFullType: "Base.Bandage"; quantity: 1 }
  | { type: "xp"; rewardId: "test_reward_xp_001"; perk: "Woodwork"; amount: 100 }
  | { type: "xp"; rewardId: "test_reward_xp_002"; perk: "Woodwork"; amount: 50 }
  | { type: "xp"; rewardId: "test_reward_xp_003" | "test_reward_xp_004"; perk: "Woodwork"; amount: 50 }
  | { type: "world_xp_multiplier"; rewardId: "test_reward_world_xp_001"; delta: 0.1 };

export interface ConnectorMission {
  protocolVersion: typeof KNOX_PROTOCOL_VERSION;
  missionId: MissionId;
  missionVersion: 1;
  title: string;
  status: "available" | "active";
  objective:
    | { type: "test"; text: string }
    | { type: "deliver_items"; text: string; requirements: Array<{ itemType: string; quantity: number }>; deliveryArea: DeliveryArea | null };
  reward: MissionReward | null;
  testFixture: { provisionRequirementsOnAccept: true; kind?: "nearby" | "distant" } | null;
}

export interface MissionPullResponse {
  ok: true;
  protocolVersion: typeof KNOX_PROTOCOL_VERSION;
  mission: ConnectorMission | null;
}

export interface MissionQueuedResponse {
  ok: true;
  protocolVersion: typeof KNOX_PROTOCOL_VERSION;
  missionId: MissionId;
}

export interface MissionReceivedAcknowledgement {
  protocolVersion: typeof KNOX_PROTOCOL_VERSION;
  messageId: string;
  type: "mission_received_ack";
  createdAt: string;
  payload: { missionId: MissionId };
}
