// src/sync/KnoxSyncEngine.ts
// v3 - 23-09-2026 - Add coalesced latest-snapshot telemetry delivery

import { access } from "node:fs/promises";
import path from "node:path";
import type { KnoxBridgeConfig } from "../config/KnoxBridgeConfig.js";
import { atomicWriteJson, ensureQueueDirectories, listStableJsonFiles, moveQueueFile, queuePaths, readJsonFile } from "../files/KnoxQueue.js";
import { KnoxApiClient, type KnoxApiTransport } from "../http/KnoxApiClient.js";
import type { KnoxLogger } from "../logging/KnoxLogger.js";
import { KNOX_PROTOCOL_VERSION, type ConnectorTestAcknowledgement, type ConnectorTestMessage } from "../protocol/KnoxProtocol.js";
import { validateConnectorTest, validateGameTelemetry } from "../protocol/KnoxValidators.js";

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
  private readonly retryState = new Map<string, { attempts: number; retryAt: number }>();
  private backendOnline: boolean | undefined;
  private lastTelemetryMessageId?: string;
  private telemetryRetry = { messageId: "", attempts: 0, retryAt: 0 };

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
      await this.processTelemetrySnapshot();
    } finally {
      this.polling = false;
    }
  }

  start(): void {
    this.timer = setInterval(() => void this.pollOnce().catch((error) => this.logger.error(String(error))), this.config.pollIntervalMs);
    void this.pollOnce().catch((error) => this.logger.error(String(error)));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async readAndValidate(filePath: string): Promise<ConnectorTestMessage | undefined> {
    try {
      return validateConnectorTest(await readJsonFile(filePath));
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
}
