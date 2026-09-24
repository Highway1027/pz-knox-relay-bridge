// src/http/KnoxApiClient.ts
// v2 - 24-09-2026 - Add authenticated Phase 4 mission pull/queued requests

import type { KnoxBridgeConfig } from "../config/KnoxBridgeConfig.js";
import { KNOX_PROTOCOL_VERSION, type GameTelemetryMessage, type KnoxPingRequest, type KnoxPingResponse, type KnoxTelemetryRequest, type KnoxTelemetryResponse, type MissionPullResponse, type MissionQueuedResponse } from "../protocol/KnoxProtocol.js";
import { validateMissionPullResponse, validateMissionQueuedResponse, validatePingResponse, validateTelemetryResponse } from "../protocol/KnoxValidators.js";

export interface KnoxApiTransport {
  sendConnectorTest(message: "hello from Project Zomboid"): Promise<KnoxPingResponse>;
  sendTelemetry(message: GameTelemetryMessage): Promise<KnoxTelemetryResponse>;
  pullMission(): Promise<MissionPullResponse>;
  acknowledgeMissionQueued(missionId: "test_001"): Promise<MissionQueuedResponse>;
}

export class KnoxApiClient implements KnoxApiTransport {
  constructor(private readonly config: KnoxBridgeConfig) {}

  async sendConnectorTest(message: "hello from Project Zomboid"): Promise<KnoxPingResponse> {
    if (!this.config.syncEndpoint) throw new Error("syncEndpoint is not configured");

    const payload: KnoxPingRequest = {
      protocolVersion: KNOX_PROTOCOL_VERSION,
      connectorVersion: this.config.connectorVersion,
      message,
    };

    let response: Response;
    try {
      response = await fetch(this.config.syncEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.config.httpTimeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "NetworkError";
      throw new Error(name === "TimeoutError" ? `request timed out after ${this.config.httpTimeoutMs}ms` : `network request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) throw new Error(`backend returned HTTP ${response.status}`);

    try {
      return validatePingResponse(await response.json());
    } catch (error) {
      throw new Error(`invalid backend response: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async sendTelemetry(message: GameTelemetryMessage): Promise<KnoxTelemetryResponse> {
    if (!this.config.telemetryEndpoint) throw new Error("telemetryEndpoint is not configured");
    if (!this.config.networkId) throw new Error("networkId is not configured");
    if (!this.config.connectorToken) throw new Error("connectorToken is not configured");
    const payload: KnoxTelemetryRequest = { ...message, networkId: this.config.networkId, connectorVersion: this.config.connectorVersion };
    let response: Response;
    try {
      response = await fetch(this.config.telemetryEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Knox-Connector-Token": this.config.connectorToken },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.config.httpTimeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "NetworkError";
      throw new Error(name === "TimeoutError" ? `request timed out after ${this.config.httpTimeoutMs}ms` : `network request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(`backend returned HTTP ${response.status}`);
    try {
      return validateTelemetryResponse(await response.json(), message.messageId);
    } catch (error) {
      throw new Error(`invalid backend response: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async pullMission(): Promise<MissionPullResponse> {
    return validateMissionPullResponse(await this.missionRequest({ action: "pull" }));
  }

  async acknowledgeMissionQueued(missionId: "test_001"): Promise<MissionQueuedResponse> {
    return validateMissionQueuedResponse(await this.missionRequest({ action: "queued", missionId }));
  }

  private async missionRequest(action: { action: "pull" } | { action: "queued"; missionId: "test_001" }): Promise<unknown> {
    if (!this.config.missionSyncEndpoint) throw new Error("missionSyncEndpoint is not configured");
    if (!this.config.networkId) throw new Error("networkId is not configured");
    if (!this.config.connectorToken) throw new Error("connectorToken is not configured");
    let response: Response;
    try {
      response = await fetch(this.config.missionSyncEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Knox-Connector-Token": this.config.connectorToken },
        body: JSON.stringify({
          protocolVersion: KNOX_PROTOCOL_VERSION,
          connectorVersion: this.config.connectorVersion,
          networkId: this.config.networkId,
          ...action,
        }),
        signal: AbortSignal.timeout(this.config.httpTimeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "NetworkError";
      throw new Error(name === "TimeoutError" ? `request timed out after ${this.config.httpTimeoutMs}ms` : `network request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(`backend returned HTTP ${response.status}`);
    try { return await response.json(); }
    catch (error) { throw new Error(`invalid backend response: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
