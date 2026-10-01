// src/desktop/BridgeRuntimeManager.ts
// v3 - 27-09-2026 - Refuse non-HTTPS endpoints before the token is read

import { DEFAULT_CONFIG, resolveExchangeDirectory, type KnoxBridgeConfig } from "../config/KnoxBridgeConfig.js";
import { doctorLines, validateExchangeParent } from "../diagnostics/KnoxDiagnostics.js";
import { KnoxLogger, type KnoxLogEvent } from "../logging/KnoxLogger.js";
import { KnoxSyncEngine } from "../sync/KnoxSyncEngine.js";
import type { ConnectionStore } from "./ConnectionStore.js";
import { assertSecureEndpoint, type ConnectionMetadata } from "./ConnectionTypes.js";

export type RuntimePhase = "offline" | "starting" | "running" | "error" | "stopping";
export interface ConnectionRuntimeState { connectionId: string; state: RuntimePhase; backend: "unknown" | "online" | "offline"; exchangeDirectory?: string; lastTelemetrySync?: string; lastMissionSync?: string; playerCount?: number; lastError?: string }
interface ActiveRuntime { engine?: KnoxSyncEngine; state: ConnectionRuntimeState; logger: KnoxLogger; stopped: boolean }

export class BridgeRuntimeManager {
  private readonly active = new Map<string, ActiveRuntime>();
  constructor(private readonly store: ConnectionStore, private readonly onLog: (id: string, event: KnoxLogEvent) => void = () => {}, private readonly preflight: (config: KnoxBridgeConfig) => Promise<void> = validateExchangeParent) {}
  status(id: string): ConnectionRuntimeState { return this.active.get(id)?.state ?? { connectionId: id, state: "offline", backend: "unknown" }; }
  describe(connection: ConnectionMetadata): ConnectionRuntimeState {
    const state = this.status(connection.id); const exchange = resolveExchangeDirectory(connection.exchangeRootOverride ? { exchangeRoot: connection.exchangeRootOverride } : {});
    return { ...state, exchangeDirectory: exchange.directory };
  }
  private async config(connection: ConnectionMetadata): Promise<KnoxBridgeConfig> {
    // Also covers connections saved before HTTPS was enforced: refuse before the token is read.
    assertSecureEndpoint(connection.telemetryEndpoint, "telemetryEndpoint");
    assertSecureEndpoint(connection.missionSyncEndpoint, "missionSyncEndpoint");
    if (connection.syncEndpoint) assertSecureEndpoint(connection.syncEndpoint, "syncEndpoint");
    const token = await this.store.token(connection.id); const exchange = resolveExchangeDirectory(connection.exchangeRootOverride ? { exchangeRoot: connection.exchangeRootOverride } : {});
    return { ...DEFAULT_CONFIG, networkId: connection.networkId, connectionName: connection.name, connectorToken: token, telemetryEndpoint: connection.telemetryEndpoint, missionSyncEndpoint: connection.missionSyncEndpoint, syncEndpoint: connection.syncEndpoint ?? DEFAULT_CONFIG.syncEndpoint, exchangeDirectory: exchange.directory, exchangeDirectorySource: exchange.source };
  }
  async start(connection: ConnectionMetadata): Promise<ConnectionRuntimeState> {
    const existing = this.active.get(connection.id);
    if (existing?.state.state === "running" || existing?.state.state === "starting" || existing?.state.state === "stopping") throw new Error("Connection is already running or transitioning");
    if (existing) this.active.delete(connection.id);
    const exchange = resolveExchangeDirectory(connection.exchangeRootOverride ? { exchangeRoot: connection.exchangeRootOverride } : {});
    const logger = new KnoxLogger();
    const state: ConnectionRuntimeState = { connectionId: connection.id, state: "starting", backend: "unknown", exchangeDirectory: exchange.directory };
    const runtime: ActiveRuntime = { state, logger, stopped: false };
    this.active.set(connection.id, runtime);
    logger.subscribe((event) => { this.observe(state, event); this.onLog(connection.id, event); });
    logger.info("Starting desktop Bridge connection");
    logger.info(`Exchange root: ${exchange.directory}`);
    logger.info(`Exchange root source: ${exchange.source}`);
    try {
      const config = await this.config(connection); logger.addSecret(config.connectorToken);
      await this.preflight(config); if (runtime.stopped) return { ...state };
      const engine = new KnoxSyncEngine(config, logger); runtime.engine = engine;
      await engine.initialize(); if (runtime.stopped) { engine.stop(); return { ...state }; }
      engine.start(); state.state = "running"; delete state.lastError; logger.info("Desktop Bridge connection started");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.state = "error"; state.lastError = message; logger.error(`Cannot start Bridge connection\n\n${message}`);
    }
    return { ...state };
  }
  stop(id: string): ConnectionRuntimeState {
    const runtime = this.active.get(id); if (!runtime) return this.status(id);
    if (runtime.stopped || runtime.state.state === "stopping") return { ...runtime.state };
    runtime.stopped = true; runtime.state.state = "stopping"; runtime.engine?.stop(); runtime.logger.info("Desktop Bridge connection stopped");
    this.active.delete(id); return { connectionId: id, state: "offline", backend: "unknown", exchangeDirectory: runtime.state.exchangeDirectory };
  }
  stopAll(): void { for (const id of [...this.active.keys()]) this.stop(id); }
  async doctor(connection: ConnectionMetadata): Promise<string[]> { return doctorLines(await this.config(connection)); }
  private observe(state: ConnectionRuntimeState, event: KnoxLogEvent): void {
    if (/Knox Relay ONLINE|telemetry accepted|mission .* received/.test(event.message)) state.backend = "online";
    if (/Knox Relay OFFLINE|mission sync OFFLINE/.test(event.message)) state.backend = "offline";
    if (/telemetry accepted/.test(event.message)) state.lastTelemetrySync = event.timestamp;
    if (/mission .* received/.test(event.message)) state.lastMissionSync = event.timestamp;
    const players = event.message.match(/\((\d+) players\)/); if (players?.[1]) state.playerCount = Number(players[1]);
  }
}
