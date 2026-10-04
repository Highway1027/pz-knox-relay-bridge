// src/sync/KnoxSyncEngine.ts
// v7 - 26-09-2026 - Stop desktop polling cleanly between transport stages

import { access, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { KnoxBridgeConfig } from "../config/KnoxBridgeConfig.js";
import { atomicWriteJson, ensureQueueDirectories, listStableJsonFiles, moveQueueFile, queuePaths, readJsonFile } from "../files/KnoxQueue.js";
import { KnoxApiClient, type KnoxApiTransport } from "../http/KnoxApiClient.js";
import type { KnoxLogger } from "../logging/KnoxLogger.js";
import { KNOX_PROTOCOL_VERSION, type ConnectorMission, type MissionFileIdentity, type ConnectorTestAcknowledgement, type ConnectorTestMessage, type MissionCompletedMessage, type MissionDeclinedMessage, type MissionReceivedAcknowledgement, type MissionStateMessage } from "../protocol/KnoxProtocol.js";
import { validateConnectorTest, validateGameTelemetry, validateMissionCompleted, validateMissionDeclined, validateMissionReceivedAcknowledgement, validateMissionState, missionStateKind } from "../protocol/KnoxValidators.js";

export const KNOX_MISSION_INDEX_FILE = "knox_missions.json";
export const KNOX_AUDIO_INDEX_FILE = "knox_audio.json";
const KNOX_MISSION_FILE = /^mission_(knox_[a-z0-9_]{1,96})\.json$/;
const KNOX_MISSION_INDEX_MAX = 64;

const ACK_FILE = /^ack_evt_[A-Za-z0-9_-]{1,96}\.json$/;
const ACK_PRUNE_INTERVAL_MS = 10 * 60 * 1000;

const isMissionState = (message: { type: string }): message is MissionStateMessage => missionStateKind(message.type) !== undefined;

// The mission as the backend sent it, plus this connection's network id and name.
export function withFileIdentity(mission: ConnectorMission, config: Pick<KnoxBridgeConfig, "networkId" | "connectionName">): ConnectorMission & MissionFileIdentity {
  const name = config.connectionName.trim().slice(0, 80);
  return { ...mission, networkId: config.networkId, ...(name ? { connectionName: name } : {}) };
}

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
  private nextAudioPollAt = 0;
  private audioRetryAttempts = 0;
  private missionRetryAttempts = 0;
  private missionBackendOnline: boolean | undefined;
  private lastKnoxMissionIndex?: string;
  private nextAckPruneAt = 0;

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
      if (!this.running) return;
      await this.pollAudio();
      if (!this.running) return;
      await this.refreshKnoxMissionIndex();
      if (!this.running) return;
      await this.pruneOldAcknowledgements();
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

  private async readAndValidate(filePath: string): Promise<ConnectorTestMessage | MissionReceivedAcknowledgement | MissionCompletedMessage | MissionDeclinedMessage | MissionStateMessage | undefined> {
    try {
      const value = await readJsonFile(filePath);
      const type = (value as { type?: unknown } | null)?.type;
      if (type === "connector_test") return validateConnectorTest(value);
      if (type === "mission_received_ack") return validateMissionReceivedAcknowledgement(value);
      if (type === 'mission_completed') return validateMissionCompleted(value);
      if (type === 'mission_declined') return validateMissionDeclined(value);
      if (missionStateKind(type)) return validateMissionState(value);
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
        await this.api.acknowledgeMissionCompleted(message.payload.missionId, message.payload.saveId);
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
        await this.api.acknowledgeMissionDeclined(message.payload.missionId, message.payload.saveId);
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

    if (isMissionState(message)) {
      const stateKind = missionStateKind(message.type)!;
      const payload = message.payload;
      try {
        await this.api.reportMissionState(stateKind, payload.missionId, payload.saveId, payload.reason);
        await moveQueueFile(filePath, this.paths.gameProcessed);
        this.retryState.delete(fileName);
        this.logger.log("BRIDGE->KNOX", `mission ${payload.missionId} ${stateKind}`);
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

  // PZ Lua cannot list a folder, so the Connector learns which knox_ mission files are waiting
  // from this index. Rewritten only when the list changes (or the file went missing).
  private async refreshKnoxMissionIndex(): Promise<void> {
    const indexPath = path.join(this.paths.bridgePending, KNOX_MISSION_INDEX_FILE);
    const missionIds = (await readdir(this.paths.bridgePending))
      .map((name) => KNOX_MISSION_FILE.exec(name)?.[1])
      .filter((id): id is string => id !== undefined)
      .sort()
      .slice(0, KNOX_MISSION_INDEX_MAX);
    const key = missionIds.join(",");
    if (key === this.lastKnoxMissionIndex && await exists(indexPath)) return;
    await atomicWriteJson(indexPath, { protocolVersion: KNOX_PROTOCOL_VERSION, missionIds });
    this.lastKnoxMissionIndex = key;
  }

  // PZ Lua cannot delete files, so every connector test leaves an ack_ file in bridge-to-game/pending.
  // PZ reads its ack within seconds of the Bridge writing it; one older than a day is never read again.
  // Runs at start and then every ten minutes; a file that is gone or locked is simply left for next time.
  async pruneOldAcknowledgements(now = Date.now()): Promise<number> {
    if (now < this.nextAckPruneAt) return 0;
    this.nextAckPruneAt = now + ACK_PRUNE_INTERVAL_MS;
    let removed = 0;
    for (const name of await readdir(this.paths.bridgePending)) {
      if (!ACK_FILE.test(name)) continue;
      const filePath = path.join(this.paths.bridgePending, name);
      try {
        if (now - (await stat(filePath)).mtimeMs < this.config.acknowledgementMaxAgeMs) continue;
        await unlink(filePath);
        removed += 1;
      } catch {
        // Next round.
      }
    }
    if (removed > 0) this.logger.info(`Removed ${removed} old ack_ file${removed === 1 ? "" : "s"} from bridge-to-game/pending`);
    return removed;
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
        // Save identity (MISSION_API 13.9): the Connector links a save to the network of its first mission.
        await atomicWriteJson(pendingPath, withFileIdentity(mission, this.config));
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

  private async pollAudio(): Promise<void> {
    if (!this.config.audioSyncEndpoint || Date.now() < this.nextAudioPollAt) return;
    this.nextAudioPollAt = Date.now() + this.config.missionPollIntervalMs;
    try {
      const response = await this.api.pullAudio();
      this.audioRetryAttempts = 0;
      if (!response.audio) return;
      const audio = response.audio;
      const fileName = `audio_${audio.audioId}.json`;
      const pendingPath = path.join(this.paths.bridgePending, fileName);
      const processedPath = path.join(this.paths.bridgeProcessed, fileName);
      if (!(await exists(pendingPath)) && !(await exists(processedPath))) {
        await atomicWriteJson(pendingPath, {
          protocolVersion: KNOX_PROTOCOL_VERSION,
          ...audio,
        });
      }
      await atomicWriteJson(path.join(this.paths.bridgePending, KNOX_AUDIO_INDEX_FILE), {
        protocolVersion: KNOX_PROTOCOL_VERSION,
        audioIds: [audio.audioId],
      });
      await this.api.acknowledgeAudioQueued(audio.audioId);
      this.logger.log("KNOX->BRIDGE", `audio ${audio.audioId} queued for the Connector`);
    } catch (error) {
      this.audioRetryAttempts += 1;
      const delay = Math.min(this.config.retryInitialMs * (2 ** Math.min(this.audioRetryAttempts - 1, 20)), this.config.retryMaxMs);
      this.nextAudioPollAt = Date.now() + delay;
      this.logger.error(`audio sync retry in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
