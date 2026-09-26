// src/sync/KnoxSyncEngine.ts
// v7 - 26-09-2026 - Stop desktop polling cleanly between transport stages

import { access } from "node:fs/promises";
import path from "node:path";
import type { KnoxBridgeConfig } from "../config/KnoxBridgeConfig.js";
import { atomicWriteJson, ensureQueueDirectories, listStableJsonFiles, moveQueueFile, queuePaths, readJsonFile } from "../files/KnoxQueue.js";
import { KnoxApiClient, type KnoxApiTransport } from "../http/KnoxApiClient.js";
import type { KnoxLogger } from "../logging/KnoxLogger.js";
import { KNOX_PROTOCOL_VERSION, type ConnectorTestAcknowledgement, type ConnectorTestMessage, type MissionCompletedMessage, type MissionDeclinedMessage, type MissionReceivedAcknowledgement } from "../protocol/KnoxProtocol.js";
import { validateConnectorTest, validateGameTelemetry, validateMissionCompleted, validateMissionDeclined, validateMissionReceivedAcknowledgement } from "../protocol/KnoxValidators.js";

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export class KnoxSyncEngine {
  private readonly paths;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private running = true;
  private readonly retryState = new Map<string, { attempts: number; retryAt: number }>();
  private backendOnline: boolean | undefined;
  private lastTelemetryMessageId?: string;
  private telemetryRetry = { messageId: "", attempts: 0, retryAt: 0 };
  private nextMissionPollAt = 0;
  private missionRetryAttempts = 0;
  private missionBackendOnline: boolean | undefined;

  constructor(
    private readonly config: KnoxBridgeConfig,
    private readonly logger: KnoxLogger,
    private readonly api: KnoxApiTransport = new KnoxApiClient(config),
  ) {
    this.paths = queuePaths(config.exchangeDirectory);
  }

  async initialize(): Promise<void> {
    await ensureQueueDirectories(this.paths);
    this.logger.info(`Watching ${this.paths.gamePending}`);
  }

  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const files = await listStableJsonFiles(this.paths.gamePending, this.config.stableFileAgeMs);
      for (const filePath of files) await this.processFile(filePath);
      if (!this.running) return;
      await this.processTelemetrySnapshot();
      if (!this.running) return;
      await this.pollMission();
    } finally {
      this.polling = false;
    }
  }

  start(): void {
    this.running = true;
    this.timer = setInterval(() => void this.pollOnce().catch((error) => this.logger.error(String(error))), this.config.pollIntervalMs);
    void this.pollOnce().catch((error) => this.logger.error(String(error)));
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
  }

  private async readAndValidate(filePath: string): Promise<ConnectorTestMessage | MissionReceivedAcknowledgement | MissionCompletedMessage | MissionDeclinedMessage | undefined> {
    try {
      const value = await readJsonFile(filePath);
      const type = (value as { type?: unknown } | null)?.type;
      if (type === "connector_test") return validateConnectorTest(value);
      if (type === "mission_received_ack") return validateMissionReceivedAcknowledgement(value);
      if (type === 'mission_completed') return validateMissionCompleted(value);
      if (type === 'mission_declined') return validateMissionDeclined(value);
      throw new Error("unsupported message type");
    } catch (error) {
      this.logger.error(`${path.basename(filePath)} failed validation: ${error instanceof Error ? error.message : String(error)}`);
      try {
        await moveQueueFile(filePath, this.paths.gameFailed);
      } catch (moveError) {
        this.logger.error(`Could not move ${path.basename(filePath)} to failed: ${String(moveError)}`);
      }
      return undefined;
    }
  }

  private async processFile(filePath: string): Promise<void> {
    const fileName = path.basename(filePath);
    const retry = this.retryState.get(fileName);
    if (retry && retry.retryAt > Date.now()) return;

    const message = await this.readAndValidate(filePath);
    if (!message) return;
    if (message.type === "mission_received_ack") {
      const missionFile = path.join(this.paths.bridgePending, `mission_${message.payload.missionId}.json`);
      if (await exists(missionFile)) await moveQueueFile(missionFile, this.paths.bridgeProcessed);
      await moveQueueFile(filePath, this.paths.gameProcessed);
      this.retryState.delete(fileName);
      this.logger.log("PZ->BRIDGE", `mission ${message.payload.missionId} acknowledged`);
      return;
    }

    if (message.type === 'mission_completed') {
      try {
        await this.api.acknowledgeMissionCompleted(message.payload.missionId);
        await moveQueueFile(filePath, this.paths.gameProcessed);
        this.retryState.delete(fileName);
        this.logger.log('BRIDGE->KNOX', `mission ${message.payload.missionId} completed`);
      } catch (error) {
        const attempts = (retry?.attempts ?? 0) + 1;
        const delay = Math.min(this.config.retryInitialMs * (2 ** Math.min(attempts - 1, 20)), this.config.retryMaxMs);
        this.retryState.set(fileName, { attempts, retryAt: Date.now() + delay });
        this.logger.error(`${message.messageId} retained for retry in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    if (message.type === 'mission_declined') {
      try {
        await this.api.acknowledgeMissionDeclined(message.payload.missionId);
        await moveQueueFile(filePath, this.paths.gameProcessed);
        this.retryState.delete(fileName);
        this.logger.log('BRIDGE->KNOX', `mission ${message.payload.missionId} declined`);
      } catch (error) {
        const attempts = (retry?.attempts ?? 0) + 1;
        const delay = Math.min(this.config.retryInitialMs * (2 ** Math.min(attempts - 1, 20)), this.config.retryMaxMs);
        this.retryState.set(fileName, { attempts, retryAt: Date.now() + delay });
        this.logger.error(`${message.messageId} retained for retry in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    const acknowledgementPath = path.join(this.paths.bridgePending, `ack_${message.messageId}.json`);
    this.logger.log("PZ->BRIDGE", `${message.type} ${message.messageId}`);

    if (await exists(acknowledgementPath)) {
      await moveQueueFile(filePath, this.paths.gameProcessed);
      this.retryState.delete(fileName);
      return;
    }

    try {
      const backendResponse = await this.api.sendConnectorTest(message.payload.message);
      if (this.backendOnline !== true) this.logger.log("HTTP", "Knox Relay ONLINE");
      this.backendOnline = true;

      const acknowledgement: ConnectorTestAcknowledgement = {
        protocolVersion: KNOX_PROTOCOL_VERSION,
        messageId: `ack_${message.messageId}`,
        replyTo: message.messageId,
        type: "connector_test_ack",
        createdAt: new Date().toISOString(),
        payload: { ok: true, message: backendResponse.message },
      };
      await atomicWriteJson(acknowledgementPath, acknowledgement);
      this.logger.log("BRIDGE->PZ", `${acknowledgement.type} ${message.messageId}`);
      await moveQueueFile(filePath, this.paths.gameProcessed);
      this.retryState.delete(fileName);
    } catch (error) {
      const attempts = (retry?.attempts ?? 0) + 1;
      const delay = Math.min(this.config.retryInitialMs * (2 ** Math.min(attempts - 1, 20)), this.config.retryMaxMs);
      this.retryState.set(fileName, { attempts, retryAt: Date.now() + delay });
      if (this.backendOnline !== false) this.logger.log("HTTP", "Knox Relay OFFLINE");
      this.backendOnline = false;
      this.logger.error(`${message.messageId} retained for retry in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async processTelemetrySnapshot(): Promise<void> {
    const telemetryPath = path.join(this.paths.gameTelemetry, "current.json");
    if (!(await exists(telemetryPath))) return;
    let message;
    try {
      const stable = await listStableJsonFiles(this.paths.gameTelemetry, this.config.stableFileAgeMs);
      if (!stable.includes(telemetryPath)) return;
      message = validateGameTelemetry(await readJsonFile(telemetryPath));
    } catch (error) {
      this.logger.error(`current.json telemetry validation failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (message.messageId === this.lastTelemetryMessageId) return;
    if (this.telemetryRetry.messageId !== message.messageId) this.telemetryRetry = { messageId: message.messageId, attempts: 0, retryAt: 0 };
    if (this.telemetryRetry.retryAt > Date.now()) return;
    this.logger.log("PZ->BRIDGE", `${message.type} ${message.messageId} (${message.payload.players.length} players)`);
    try {
      await this.api.sendTelemetry(message);
      if (this.backendOnline !== true) this.logger.log("HTTP", "Knox Relay ONLINE");
      this.backendOnline = true;
      this.lastTelemetryMessageId = message.messageId;
      this.telemetryRetry = { messageId: "", attempts: 0, retryAt: 0 };
      this.logger.log("BRIDGE->KNOX", `telemetry accepted ${message.messageId}`);
    } catch (error) {
      const attempts = this.telemetryRetry.attempts + 1;
      const delay = Math.min(this.config.retryInitialMs * (2 ** Math.min(attempts - 1, 20)), this.config.retryMaxMs);
      this.telemetryRetry = { messageId: message.messageId, attempts, retryAt: Date.now() + delay };
      if (this.backendOnline !== false) this.logger.log("HTTP", "Knox Relay OFFLINE");
      this.backendOnline = false;
      this.logger.error(`${message.messageId} latest telemetry retained for retry in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async pollMission(): Promise<void> {
    if (!this.config.missionSyncEndpoint || Date.now() < this.nextMissionPollAt) return;
    this.nextMissionPollAt = Date.now() + this.config.missionPollIntervalMs;
    try {
      const response = await this.api.pullMission();
      if (this.missionBackendOnline === false) this.logger.log("HTTP", "mission sync ONLINE");
      this.missionBackendOnline = true;
      this.missionRetryAttempts = 0;
      if (!response.mission) return;
      const mission = response.mission;
      this.logger.log("KNOX->BRIDGE", `mission ${mission.missionId} received`);
      const fileName = `mission_${mission.missionId}.json`;
      const pendingPath = path.join(this.paths.bridgePending, fileName);
      const processedPath = path.join(this.paths.bridgeProcessed, fileName);
      if (!(await exists(pendingPath)) && !(await exists(processedPath))) {
        await atomicWriteJson(pendingPath, mission);
        this.logger.log("BRIDGE->PZ", `mission ${mission.missionId} queued`);
      }
      await this.api.acknowledgeMissionQueued(mission.missionId);
    } catch (error) {
      this.missionRetryAttempts += 1;
      const delay = Math.min(this.config.retryInitialMs * (2 ** Math.min(this.missionRetryAttempts - 1, 20)), this.config.retryMaxMs);
      this.nextMissionPollAt = Date.now() + delay;
      if (this.missionBackendOnline !== false) this.logger.log("HTTP", "mission sync OFFLINE");
      this.missionBackendOnline = false;
      this.logger.error(`mission sync retry in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
