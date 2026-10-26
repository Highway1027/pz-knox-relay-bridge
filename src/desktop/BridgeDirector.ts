// src/desktop/BridgeDirector.ts
// Bridge detection (Bridge 0.3.0, plan "Bridge heartbeat file and Bridge detection", agreed 11-10-2026).
// The desktop Bridge follows the game instead of running whichever connection was started by hand: every second it
// looks at the game heartbeat, runs the one connection for the save's network (switching after the call in flight),
// stays idle without a game, and writes its own heartbeat for the game. KnoxGameLink holds the rules.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, ensureQueueDirectories, queuePaths } from "../files/KnoxQueue.js";
import { SAVE_ID_PATTERN } from "../protocol/KnoxValidators.js";
import type { GameEndResult, KnoxSyncEngineOptions } from "../sync/KnoxSyncEngine.js";
import {
  BRIDGE_BEAT_MS, BRIDGE_HEARTBEAT_FILE, GAME_FRESH_MS, GAME_HEARTBEAT_FILE, LEGACY_TELEMETRY_FRESH_MS, SAVE_NETWORKS_FILE,
  bridgeHeartbeat, decideLink, parseGameHeartbeat, parseSaveNetworks, rememberSave, routesTo,
  type GameSighting, type LinkConnection, type LinkDecision, type SaveNetworks,
} from "../sync/KnoxGameLink.js";
import type { ConnectionRuntimeState } from "./BridgeRuntimeManager.js";
import type { ConnectionMetadata } from "./ConnectionTypes.js";

export const DIRECTOR_TICK_MS = 1000;
// A connection that failed to start is tried again after this long.
export const START_RETRY_MS = 30_000;

export interface DirectorRunner {
  start(connection: ConnectionMetadata, options: KnoxSyncEngineOptions): Promise<ConnectionRuntimeState>;
  // gameEndedSaveId (0.3.2): after stopping, tell the backend the game of this save stopped. 0.3.3: with the result.
  stopAndWait(id: string, gameEndedSaveId?: string): Promise<GameEndResult | undefined | void>;
  followSave(id: string, saveId: string | undefined): void;
  // The running connection tells the backend the game of this save stopped (another save of the same network loaded).
  reportGameEnded?(id: string, saveId: string): Promise<void>;
}

export interface DirectorStatus {
  state: LinkDecision["state"] | "error" | "no_game_folder" | "stopped";
  exchangeDirectory: string;
  saveId?: string;
  networkId?: string;
  mode?: "sp" | "mp";
  legacy?: boolean;
  activeConnectionId?: string;
  activeName?: string;
  lastError?: string;
  // Desktop 0.3.3: while idle after a game ran here: was everything sent (the window says "safe to close").
  lastGame?: GameEndResult & { endedAt: number };
}

export interface DirectorOptions {
  exchangeDirectory: string;
  connections: () => Promise<ConnectionMetadata[]>;
  runner: DirectorRunner;
  bridgeVersion: string;
  log?: (level: "INFO" | "ERROR", message: string) => void;
  onChange?: (status: DirectorStatus) => void;
  // False while there is no Project Zomboid user folder (the Bridge then writes nothing).
  ready?: () => Promise<boolean>;
  clock?: () => number;
}

async function mtimeOf(filePath: string): Promise<number | undefined> {
  try { return (await stat(filePath)).mtimeMs; } catch { return undefined; }
}

// Bridge 0.3.2 (plan, Bridge detection "Later"): the save that was being played with a heartbeat and is not any more
// (the heartbeat stopped, or another save was loaded). The running connection tells the backend, so the play session
// closes and its recap is written 5 to 10 minutes later instead of after 20 idle minutes. Older boards (legacy) have no
// heartbeat to go by.
export function gameEnded(previous: LinkDecision, next: LinkDecision): string | undefined {
  if (previous.state !== "active" || previous.legacy || !previous.saveId) return undefined;
  return next.saveId === previous.saveId ? undefined : previous.saveId;
}

export class BridgeDirector {
  private readonly paths;
  private timer?: NodeJS.Timeout;
  private busy?: Promise<void>;
  private stopped = false;
  private known: SaveNetworks = { saves: {} };
  private knownLoaded = false;
  private decision: LinkDecision = { state: "idle" };
  private activeId?: string;
  private activeName?: string;
  private startError?: { id: string; message: string; retryAt: number };
  private lastGame?: GameEndResult & { endedAt: number };
  private beat = 0;
  private lastBeatAt = 0;
  private lastBeatKey = "";
  private lastStatusKey = "";
  private heartbeatCache?: { mtime: number; sighting: GameSighting };
  private legacySave?: { mtime: number; saveId?: string };
  private badHeartbeatReported = false;
  private status: DirectorStatus;

  constructor(private readonly options: DirectorOptions) {
    this.paths = queuePaths(options.exchangeDirectory);
    this.status = { state: "idle", exchangeDirectory: options.exchangeDirectory };
  }

  get exchangeDirectory(): string { return this.options.exchangeDirectory; }
  current(): DirectorStatus { return { ...this.status }; }

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), DIRECTOR_TICK_MS);
    void this.tick();
  }

  // Stops the running connection after its call in flight and tells the game at once ("stopped").
  // 0.3.6: "stopped" is written before the wait, not after: quit waits at most 3 s, and a slow call in flight
  // (backend down) left the game reading "active". Written again at the end, in case a tick's beat landed between.
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.beat > 0) await this.writeBeat([], true).catch(() => undefined);
    await this.busy?.catch(() => undefined);
    if (this.activeId) await this.options.runner.stopAndWait(this.activeId);
    this.activeId = undefined;
    this.activeName = undefined;
    if (this.beat > 0) await this.writeBeat([], true).catch(() => undefined);
    this.publish({ state: "stopped", exchangeDirectory: this.options.exchangeDirectory });
  }

  async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = this.step().catch((error) => this.log("ERROR", `Bridge director: ${error instanceof Error ? error.message : String(error)}`));
    try { await this.busy; } finally { this.busy = undefined; }
  }

  private log(level: "INFO" | "ERROR", message: string): void { this.options.log?.(level, message); }
  private now(): number { return (this.options.clock ?? Date.now)(); }

  private async step(): Promise<void> {
    if (this.options.ready && !(await this.options.ready())) {
      this.publish({ state: "no_game_folder", exchangeDirectory: this.options.exchangeDirectory });
      return;
    }
    await ensureQueueDirectories(this.paths);
    if (!this.knownLoaded) await this.loadKnown();
    const now = this.now();
    const metadata = await this.options.connections();
    const connections: LinkConnection[] = metadata.map((item) => ({ id: item.id, networkId: item.networkId, name: item.name }));
    const sighting = await this.sight(now);
    const decision = decideLink(sighting, connections, this.known);
    if (rememberSave(this.known, decision)) await this.saveKnown();
    const previous = this.decision;
    this.decision = decision;
    if (previous.state !== decision.state || previous.saveId !== decision.saveId || previous.networkId !== decision.networkId) this.logDecision(decision);

    const target = decision.state === "active" ? metadata.find((item) => item.id === decision.connection?.id) : undefined;
    const ended = gameEnded(previous, decision);
    if (decision.state !== "idle") this.lastGame = undefined;
    if (this.activeId && this.activeId !== target?.id) {
      this.log("INFO", `Stopping ${this.activeName ?? "the running connection"} after the call in flight`);
      const result = await this.options.runner.stopAndWait(this.activeId, ended);
      if (result && decision.state === "idle") this.lastGame = { ...result, endedAt: now };
      this.activeId = undefined;
      this.activeName = undefined;
    } else if (this.activeId && ended) {
      await this.options.runner.reportGameEnded?.(this.activeId, ended);
    }
    if (target && this.activeId !== target.id && !this.stopped) await this.startConnection(target, now);
    if (this.activeId) this.options.runner.followSave(this.activeId, decision.saveId);

    const error = target && this.startError?.id === target.id ? this.startError.message : undefined;
    await this.maybeBeat(connections, now, error);
    this.publish({
      state: error ? "error" : decision.state, exchangeDirectory: this.options.exchangeDirectory,
      ...(decision.saveId ? { saveId: decision.saveId } : {}), ...(decision.networkId ? { networkId: decision.networkId } : {}),
      ...(sighting.kind === "heartbeat" ? { mode: sighting.heartbeat.mode } : {}), ...(decision.legacy ? { legacy: true } : {}),
      ...(this.activeId ? { activeConnectionId: this.activeId, activeName: this.activeName } : {}), ...(error ? { lastError: error } : {}),
      ...(this.lastGame && decision.state === "idle" ? { lastGame: { ...this.lastGame } } : {}),
    });
  }

  private async startConnection(target: ConnectionMetadata, now: number): Promise<void> {
    if (this.startError?.id === target.id && this.startError.retryAt > now) return;
    const networkId = target.networkId;
    // Read at every file: the decision changes (legacy, the save map) while the connection runs.
    const route = (saveId: string | undefined) => routesTo(this.known, networkId, saveId, this.decision);
    const state = await this.options.runner.start(target, { route });
    if (state.state === "running") {
      this.activeId = target.id;
      this.activeName = target.name;
      this.startError = undefined;
      this.log("INFO", `Running ${target.name} for ${this.decision.saveId ?? "the game"}`);
    } else {
      this.startError = { id: target.id, message: state.lastError ?? "the connection did not start", retryAt: now + START_RETRY_MS };
      this.log("ERROR", `Cannot start ${target.name}: ${this.startError.message}`);
    }
  }

  private logDecision(decision: LinkDecision): void {
    const save = decision.saveId ?? "a save";
    const text = decision.state === "idle" ? "No game running: idle, no web calls"
      : decision.state === "unlinked" ? `Game running: ${save} is not linked to a Knox network yet (pick one in game)`
      : decision.state === "no_connection" ? `Game running: ${save} is linked to ${decision.networkId ?? "an unknown network"}, which has no connection here`
      : `Game running: ${save} is linked to ${decision.connection?.name ?? decision.networkId}${decision.legacy ? " (older Mission Board, no heartbeat)" : ""}`;
    this.log("INFO", text);
  }

  // The game heartbeat when fresh; else an older Mission Board's fresh telemetry; else nothing.
  private async sight(now: number): Promise<GameSighting> {
    const heartbeatPath = path.join(this.paths.gameTelemetry, GAME_HEARTBEAT_FILE);
    const heartbeatTime = await mtimeOf(heartbeatPath);
    if (heartbeatTime !== undefined && now - heartbeatTime <= GAME_FRESH_MS) {
      try {
        const sighting: GameSighting = { kind: "heartbeat", heartbeat: parseGameHeartbeat(JSON.parse(await readFile(heartbeatPath, "utf8"))) };
        this.heartbeatCache = { mtime: heartbeatTime, sighting };
        this.badHeartbeatReported = false;
        return sighting;
      } catch (error) {
        // Half-written or malformed: keep the last good one for this tick.
        if (!this.badHeartbeatReported) this.log("ERROR", `${GAME_HEARTBEAT_FILE}: ${error instanceof Error ? error.message : String(error)}`);
        this.badHeartbeatReported = true;
        if (this.heartbeatCache && now - this.heartbeatCache.mtime <= GAME_FRESH_MS) return this.heartbeatCache.sighting;
        return { kind: "none" };
      }
    }
    const telemetryPath = path.join(this.paths.gameTelemetry, "current.json");
    const telemetryTime = await mtimeOf(telemetryPath);
    if (telemetryTime === undefined || now - telemetryTime > LEGACY_TELEMETRY_FRESH_MS) return { kind: "none" };
    // A Mission Board with a heartbeat that just quit also leaves fresh telemetry behind: only an older board (no
    // heartbeat file, or one far older than the telemetry) counts.
    if (heartbeatTime !== undefined && heartbeatTime >= telemetryTime - GAME_FRESH_MS) return { kind: "none" };
    if (this.legacySave?.mtime !== telemetryTime) {
      let saveId = this.legacySave?.saveId;
      try {
        const snapshotSave = (JSON.parse(await readFile(telemetryPath, "utf8")) as { payload?: { snapshot?: { saveId?: unknown } } }).payload?.snapshot?.saveId;
        if (typeof snapshotSave === "string" && SAVE_ID_PATTERN.test(snapshotSave)) saveId = snapshotSave;
      } catch {
        // Being written: the next tick reads it.
      }
      this.legacySave = { mtime: telemetryTime, ...(saveId ? { saveId } : {}) };
    }
    return { kind: "legacy", ...(this.legacySave.saveId ? { saveId: this.legacySave.saveId } : {}) };
  }

  private async maybeBeat(connections: LinkConnection[], now: number, error: string | undefined): Promise<void> {
    const key = JSON.stringify([this.decision, this.activeId, error, connections.map((item) => [item.networkId, item.name])]);
    if (this.stopped || (key === this.lastBeatKey && now - this.lastBeatAt < BRIDGE_BEAT_MS)) return;
    try {
      await this.writeBeat(connections, false, error);
      this.lastBeatKey = key;
      this.lastBeatAt = now;
    } catch {
      // PZ had the file open; next tick.
    }
  }

  private async writeBeat(connections: LinkConnection[], stopped: boolean, error?: string): Promise<void> {
    this.beat += 1;
    const message = error ? `The Bridge cannot start ${this.decision.connection?.name ?? "the connection"}: ${error.split("\n")[0]}` : undefined;
    await atomicWriteJson(path.join(this.paths.bridgePending, BRIDGE_HEARTBEAT_FILE),
      bridgeHeartbeat(this.beat, this.options.bridgeVersion, this.decision, connections, { stopped, ...(message ? { error: message } : {}) }));
  }

  private publish(status: DirectorStatus): void {
    this.status = status;
    const key = JSON.stringify(status);
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.options.onChange?.({ ...status });
  }

  private async loadKnown(): Promise<void> {
    try {
      this.known = parseSaveNetworks(JSON.parse(await readFile(path.join(this.paths.state, SAVE_NETWORKS_FILE), "utf8")));
    } catch {
      this.known = { saves: {} };
    }
    this.knownLoaded = true;
  }

  private async saveKnown(): Promise<void> {
    await atomicWriteJson(path.join(this.paths.state, SAVE_NETWORKS_FILE), { protocolVersion: 1, ...this.known }).catch((error) =>
      this.log("ERROR", `Could not save ${SAVE_NETWORKS_FILE}: ${error instanceof Error ? error.message : String(error)}`));
  }
}
