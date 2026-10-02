// src/protocol/KnoxProtocol.ts
// v8 - 27-09-2026 - Optional telemetry snapshot; open knox_ mission ids

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
    // World/player summary from Connector 0.13.0+, about once a minute. Checked as a bounded envelope.
    snapshot?: Record<string, unknown>;
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

export type MissionId = "mission_v0_muldraugh_checkin" | "mission_v0_fallas_recon" | "mission_v0_echo_recon"
  | "mission_v0_march_recon" | "mission_v0_westpoint_recon" | `mission_v02_${string}` | `knox_${string}`;

export interface VisitArea {
  type: "radius";
  x: number;
  y: number;
  z: number;
  radius: number;
  name: string;
}

export type MissionReward = { type: "xp"; rewardId: `reward_mission_v0${string}`; perk: string; amount: number };

export interface ConnectorMission {
  protocolVersion: typeof KNOX_PROTOCOL_VERSION;
  missionId: MissionId;
  missionVersion: 1;
  title: string;
  status: "available" | "active";
  objective: { type: "visit_area"; text: string; area: VisitArea };
  reward: MissionReward | null;
  testFixture: null;
  location?: { locationId: string; name: string; town: string; navigation?: Record<string, unknown> };
  navigationContext?: { distanceTiles: number; direction: string; reference: string } | null;
  chain?: { chainId: string; stage: number; requiresCompleted: string[] };
  narrative?: { briefing: string; shortObjective: string; arrivalMessage: string; completionMessage: string };
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

export interface MissionCompletedMessage {
  protocolVersion: typeof KNOX_PROTOCOL_VERSION;
  messageId: string;
  type: "mission_completed";
  createdAt: string;
  // saveId: the save that completed it (Connector, once the save is linked; MISSION_API 13.9).
  payload: { missionId: MissionId; missionVersion: number; objectiveType: string; completedBy: string; saveId?: string };
}

export interface MissionDeclinedMessage {
  protocolVersion: typeof KNOX_PROTOCOL_VERSION;
  messageId: string;
  type: "mission_declined";
  createdAt: string;
  payload: { missionId: MissionId; missionVersion: number; declinedBy: string; saveId?: string };
}

// Other state changes of a Knox mission (Connector, 02-10-2026). One extra field per kind:
// accepted -> acceptedBy, abandoned -> abandonedBy, failed and expired -> reason (a short sentence).
// expired: closed by its deadline (onExpire), Connector 0.18.1+.
export type MissionStateKind = "accepted" | "abandoned" | "failed" | "expired";
export interface MissionStateMessage {
  protocolVersion: typeof KNOX_PROTOCOL_VERSION;
  messageId: string;
  type: `mission_${MissionStateKind}`;
  createdAt: string;
  payload: { missionId: MissionId; missionVersion: number; acceptedBy?: string; abandonedBy?: string; reason?: string; saveId?: string };
}

// Added by the Bridge to every mission file it writes, so the Connector can link a save to one network.
export interface MissionFileIdentity {
  networkId: string;
  connectionName?: string;
}
