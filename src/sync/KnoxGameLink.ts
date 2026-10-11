// src/sync/KnoxGameLink.ts
// Bridge detection (Bridge 0.3.0, Mission Board 0.37.0; plan "Bridge heartbeat file and Bridge detection", agreed 11-10-2026).
// Pure rules, no file access: which connection runs for the game being played, and what the Bridge tells the game.
//
// - The game writes game-to-bridge/telemetry/heartbeat.json every 5 s: saveId, the network the save is linked to, SP/MP.
// - The save chooses the network. One connection runs at a time: the one for the save's network.
// - No fresh game heartbeat: the Bridge is idle (no web calls).
// - The Bridge writes bridge-to-game/pending/knox_bridge.json every 3 s with a beat counter (PZ Lua cannot read file
//   times, so the game watches the counter), its state and the list of connections for the in-game link picker.

import { NETWORK_ID_PATTERN, SAVE_ID_PATTERN } from "../protocol/KnoxValidators.js";

export const GAME_HEARTBEAT_FILE = "heartbeat.json";
export const BRIDGE_HEARTBEAT_FILE = "knox_bridge.json";
export const SAVE_NETWORKS_FILE = "save-networks.json";
// The game writes every 5 s; three missed beats mean the game is gone (quit, crashed, back in the main menu).
export const GAME_FRESH_MS = 15_000;
// Mission Boards before 0.37.0 write no heartbeat, only telemetry (every 10 s while a player is in the world).
export const LEGACY_TELEMETRY_FRESH_MS = 30_000;
export const BRIDGE_BEAT_MS = 3_000;
const MAX_SAVES = 200;
const MAX_NAME = 80;

export interface LinkConnection { id: string; networkId: string; name: string }

export interface GameHeartbeat { saveId: string; networkId?: string; mode: "sp" | "mp"; boardVersion?: string }

// What the Bridge sees of the game: a heartbeat, only an older board's telemetry, or nothing.
export type GameSighting =
  | { kind: "none" }
  | { kind: "heartbeat"; heartbeat: GameHeartbeat }
  | { kind: "legacy"; saveId?: string };

export type LinkState = "idle" | "unlinked" | "no_connection" | "active";
export interface LinkDecision {
  state: LinkState;
  saveId?: string;
  // The network the save is linked to (also when no connection has it).
  networkId?: string;
  connection?: LinkConnection;
  // Chosen from an older board's telemetry, without a heartbeat.
  legacy?: boolean;
}

export interface SaveNetworks { saves: Record<string, string>; lastNetworkId?: string }

const exactKeys = (value: Record<string, unknown>, required: string[], optional: string[]): boolean => {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
};

// Throws on anything but a well-formed game heartbeat.
export function parseGameHeartbeat(value: unknown): GameHeartbeat {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("heartbeat must be an object");
  const beat = value as Record<string, unknown>;
  if (!exactKeys(beat, ["protocolVersion", "beat", "saveId", "mode"], ["networkId", "boardVersion"]) || beat.protocolVersion !== 1 ||
      typeof beat.beat !== "number" || !Number.isFinite(beat.beat) ||
      typeof beat.saveId !== "string" || !SAVE_ID_PATTERN.test(beat.saveId) || (beat.mode !== "sp" && beat.mode !== "mp") ||
      ("networkId" in beat && (typeof beat.networkId !== "string" || !NETWORK_ID_PATTERN.test(beat.networkId))) ||
      ("boardVersion" in beat && (typeof beat.boardVersion !== "string" || !/^[0-9][0-9A-Za-z.+-]{0,31}$/.test(beat.boardVersion))))
    throw new Error("invalid game heartbeat");
  return { saveId: beat.saveId, mode: beat.mode, ...(beat.networkId ? { networkId: beat.networkId as string } : {}),
    ...(beat.boardVersion ? { boardVersion: beat.boardVersion as string } : {}) };
}

function connectionFor(networkId: string | undefined, connections: LinkConnection[]): LinkConnection | undefined {
  return networkId ? connections.find((connection) => connection.networkId === networkId) : undefined;
}

// Which connection runs. An older board names no network: use what this save used before, else the last network
// the Bridge ran, else the only connection there is.
export function decideLink(sighting: GameSighting, connections: LinkConnection[], known: SaveNetworks): LinkDecision {
  if (sighting.kind === "none") return { state: "idle" };
  if (sighting.kind === "heartbeat") {
    const { saveId, networkId } = sighting.heartbeat;
    if (!networkId) return { state: "unlinked", saveId };
    const connection = connectionFor(networkId, connections);
    return connection ? { state: "active", saveId, networkId, connection } : { state: "no_connection", saveId, networkId };
  }
  const saveId = sighting.saveId;
  const networkId = (saveId ? known.saves[saveId] : undefined) ?? known.lastNetworkId ?? (connections.length === 1 ? connections[0]!.networkId : undefined);
  const connection = connectionFor(networkId, connections);
  if (!connection) return { state: "no_connection", legacy: true, ...(saveId ? { saveId } : {}), ...(networkId ? { networkId } : {}) };
  return { state: "active", legacy: true, ...(saveId ? { saveId } : {}), networkId: connection.networkId, connection };
}

// Remembers which network each save is linked to (from heartbeats), so files are routed by the saveId they carry.
// Returns true when something changed (the caller saves the file).
export function rememberSave(known: SaveNetworks, decision: LinkDecision): boolean {
  let changed = false;
  if (decision.saveId && decision.networkId && !decision.legacy && known.saves[decision.saveId] !== decision.networkId) {
    delete known.saves[decision.saveId];
    known.saves[decision.saveId] = decision.networkId;
    const ids = Object.keys(known.saves);
    for (const old of ids.slice(0, Math.max(0, ids.length - MAX_SAVES))) delete known.saves[old];
    changed = true;
  }
  if (decision.state === "active" && decision.connection && known.lastNetworkId !== decision.connection.networkId) {
    known.lastNetworkId = decision.connection.networkId;
    changed = true;
  }
  return changed;
}

// Which outbound files the running connection may send. A file names its save (saveId) once the save is linked; a file
// for a save linked to another network waits for that network. Without a heartbeat (older board) every file goes, as
// before 0.3.0. A file without a saveId belongs to the save being played.
export function routesTo(known: SaveNetworks, networkId: string, saveId: string | undefined, decision: LinkDecision): boolean {
  if (!saveId || decision.legacy) return true;
  const saveNetwork = known.saves[saveId];
  if (saveNetwork) return saveNetwork === networkId;
  // A save not seen in a heartbeat yet: held, never sent to whichever network happens to run.
  return false;
}

export function parseSaveNetworks(value: unknown): SaveNetworks {
  const known: SaveNetworks = { saves: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) return known;
  const raw = value as { saves?: unknown; lastNetworkId?: unknown };
  if (raw.saves && typeof raw.saves === "object" && !Array.isArray(raw.saves)) {
    for (const [saveId, networkId] of Object.entries(raw.saves as Record<string, unknown>)) {
      if (SAVE_ID_PATTERN.test(saveId) && typeof networkId === "string" && NETWORK_ID_PATTERN.test(networkId)) known.saves[saveId] = networkId;
    }
  }
  if (typeof raw.lastNetworkId === "string" && NETWORK_ID_PATTERN.test(raw.lastNetworkId)) known.lastNetworkId = raw.lastNetworkId;
  return known;
}

export interface BridgeHeartbeatFile {
  protocolVersion: 1;
  beat: number;
  bridgeVersion: string;
  // "stopped": written once when the Bridge closes, so the game knows at once. "error": the connection for this save
  // cannot start (see message).
  state: LinkState | "stopped" | "error";
  saveId?: string;
  networkId?: string;
  activeNetworkId?: string;
  activeName?: string;
  message?: string;
  connections: { networkId: string; name: string }[];
}

export function bridgeHeartbeat(beat: number, bridgeVersion: string, decision: LinkDecision | undefined, connections: LinkConnection[],
  extra: { stopped?: boolean; error?: string } = {}): BridgeHeartbeatFile {
  const seen = new Set<string>();
  const list = connections.filter((connection) => !seen.has(connection.networkId) && seen.add(connection.networkId))
    .map((connection) => ({ networkId: connection.networkId, name: (connection.name.trim() || connection.networkId).slice(0, MAX_NAME) }));
  const state = extra.stopped ? "stopped" : extra.error ? "error" : decision?.state ?? "idle";
  return {
    protocolVersion: 1, beat, bridgeVersion, state,
    ...(decision?.saveId && !extra.stopped ? { saveId: decision.saveId } : {}),
    ...(decision?.networkId && !extra.stopped ? { networkId: decision.networkId } : {}),
    ...(decision?.state === "active" && decision.connection && !extra.stopped && !extra.error
      ? { activeNetworkId: decision.connection.networkId, activeName: (decision.connection.name.trim() || decision.connection.networkId).slice(0, MAX_NAME) } : {}),
    ...(extra.error && !extra.stopped ? { message: extra.error.slice(0, 200) } : {}),
    connections: list,
  };
}
