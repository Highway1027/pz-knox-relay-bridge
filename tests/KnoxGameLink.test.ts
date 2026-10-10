// tests/KnoxGameLink.test.ts
// Bridge detection (Bridge 0.3.0, plan "Bridge heartbeat file and Bridge detection", agreed 11-10-2026): the save chooses
// the network, one connection at a time, idle without a game, files routed by saveId, heartbeat for the game.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeDirector, type DirectorRunner } from "../src/desktop/BridgeDirector.js";
import type { ConnectionRuntimeState } from "../src/desktop/BridgeRuntimeManager.js";
import type { ConnectionMetadata } from "../src/desktop/ConnectionTypes.js";
import { ensureQueueDirectories, queuePaths } from "../src/files/KnoxQueue.js";
import { validateMissionRequest } from "../src/protocol/KnoxValidators.js";
import {
  BRIDGE_HEARTBEAT_FILE, GAME_HEARTBEAT_FILE, SAVE_NETWORKS_FILE, bridgeHeartbeat, decideLink, parseGameHeartbeat, parseSaveNetworks,
  rememberSave, routesTo, type LinkConnection, type SaveNetworks,
} from "../src/sync/KnoxGameLink.js";
import type { KnoxSyncEngineOptions } from "../src/sync/KnoxSyncEngine.js";

const A: LinkConnection = { id: "conn-a", networkId: "netA", name: "TESTING Single player 3" };
const B: LinkConnection = { id: "conn-b", networkId: "netB", name: "Testing Solo Multiplayer" };
const beat = (extra: Record<string, unknown> = {}) => ({ protocolVersion: 1, beat: 7, saveId: "save_one", mode: "sp", ...extra });

test("a game heartbeat parses with exactly its fields", () => {
  assert.deepEqual(parseGameHeartbeat(beat({ networkId: "netA", boardVersion: "0.37.0" })),
    { saveId: "save_one", mode: "sp", networkId: "netA", boardVersion: "0.37.0" });
  assert.deepEqual(parseGameHeartbeat(beat()), { saveId: "save_one", mode: "sp" });
  assert.throws(() => parseGameHeartbeat(beat({ extra: 1 })), /invalid game heartbeat/);
  assert.throws(() => parseGameHeartbeat(beat({ saveId: "SAVE" })), /invalid game heartbeat/);
  assert.throws(() => parseGameHeartbeat(beat({ mode: "coop" })), /invalid game heartbeat/);
  assert.throws(() => parseGameHeartbeat(beat({ networkId: "net A" })), /invalid game heartbeat/);
  assert.throws(() => parseGameHeartbeat([]), /object/);
});

test("the save chooses the network; no game means idle", () => {
  const known: SaveNetworks = { saves: {} };
  assert.deepEqual(decideLink({ kind: "none" }, [A, B], known), { state: "idle" });
  assert.deepEqual(decideLink({ kind: "heartbeat", heartbeat: { saveId: "save_one", mode: "sp" } }, [A, B], known), { state: "unlinked", saveId: "save_one" });
  const onB = decideLink({ kind: "heartbeat", heartbeat: { saveId: "save_one", mode: "sp", networkId: "netB" } }, [A, B], known);
  assert.equal(onB.state, "active"); assert.equal(onB.connection?.id, "conn-b");
  assert.deepEqual(decideLink({ kind: "heartbeat", heartbeat: { saveId: "save_one", mode: "mp", networkId: "netC" } }, [A, B], known),
    { state: "no_connection", saveId: "save_one", networkId: "netC" });
});

test("an older Mission Board (telemetry only) gets the save's last network, else the last one run, else the only one", () => {
  const known: SaveNetworks = { saves: { save_one: "netB" }, lastNetworkId: "netA" };
  assert.equal(decideLink({ kind: "legacy", saveId: "save_one" }, [A, B], known).connection?.id, "conn-b");
  assert.equal(decideLink({ kind: "legacy", saveId: "save_two" }, [A, B], known).connection?.id, "conn-a");
  assert.equal(decideLink({ kind: "legacy" }, [B], { saves: {} }).connection?.id, "conn-b");
  const unknown = decideLink({ kind: "legacy" }, [A, B], { saves: {} });
  assert.equal(unknown.state, "no_connection"); assert.equal(unknown.legacy, true);
});

test("heartbeats teach the saveId -> network map; files wait for their own network", () => {
  const known: SaveNetworks = { saves: {} };
  const onA = decideLink({ kind: "heartbeat", heartbeat: { saveId: "save_one", mode: "sp", networkId: "netA" } }, [A, B], known);
  assert.equal(rememberSave(known, onA), true);
  assert.equal(rememberSave(known, onA), false);
  assert.deepEqual(known, { saves: { save_one: "netA" }, lastNetworkId: "netA" });
  assert.equal(routesTo(known, "netA", "save_one", onA), true);
  assert.equal(routesTo(known, "netB", "save_one", onA), false);
  assert.equal(routesTo(known, "netA", "save_unknown", onA), false, "a save never seen is held");
  assert.equal(routesTo(known, "netA", undefined, onA), true, "no saveId: the save being played");
  assert.equal(routesTo(known, "netA", "save_unknown", { state: "active", legacy: true }), true, "older boards: as before 0.3.0");
  // Relinked to B: the map follows.
  rememberSave(known, decideLink({ kind: "heartbeat", heartbeat: { saveId: "save_one", mode: "sp", networkId: "netB" } }, [A, B], known));
  assert.equal(known.saves.save_one, "netB");
  assert.deepEqual(parseSaveNetworks({ saves: { save_one: "netB", bad: "x", save_two: "bad id" }, lastNetworkId: "netB" }), { saves: { save_one: "netB" }, lastNetworkId: "netB" });
});

test("the Bridge heartbeat lists each network once and names the active one", () => {
  const decision = decideLink({ kind: "heartbeat", heartbeat: { saveId: "save_one", mode: "sp", networkId: "netA" } }, [A, B], { saves: {} });
  const file = bridgeHeartbeat(3, "0.3.0", decision, [A, B, { ...A, id: "dup" }]);
  assert.deepEqual(file, { protocolVersion: 1, beat: 3, bridgeVersion: "0.3.0", state: "active", saveId: "save_one", networkId: "netA",
    activeNetworkId: "netA", activeName: "TESTING Single player 3", connections: [{ networkId: "netA", name: "TESTING Single player 3" }, { networkId: "netB", name: "Testing Solo Multiplayer" }] });
  assert.equal(bridgeHeartbeat(4, "0.3.0", decision, [A], { stopped: true }).state, "stopped");
  const error = bridgeHeartbeat(5, "0.3.0", decision, [A], { error: "token missing" });
  assert.equal(error.state, "error"); assert.equal(error.message, "token missing"); assert.equal(error.activeNetworkId, undefined);
});

test("a mission request may name the save's network", () => {
  const request = (payload: Record<string, unknown>) => ({ protocolVersion: 1, messageId: "evt_1", type: "mission_request", createdAt: new Date().toISOString(),
    payload: { requestId: "req_1_2", requestedBy: "Rosita", ...payload } });
  assert.equal(validateMissionRequest(request({ saveId: "save_one", networkId: "netA" })).payload.networkId, "netA");
  assert.equal(validateMissionRequest(request({ networkId: "netA" })).payload.networkId, "netA");
  assert.throws(() => validateMissionRequest(request({ networkId: "" })), /invalid mission request/);
  assert.throws(() => validateMissionRequest(request({ networkId: "netA", extra: 1 })), /invalid mission request/);
});

// ---------------------------------------------------------------- director with a fake runner

function metadata(link: LinkConnection): ConnectionMetadata {
  return { id: link.id, name: link.name, networkId: link.networkId, telemetryEndpoint: "https://example.test/t", missionSyncEndpoint: "https://example.test/m",
    createdAt: "2026-10-11T00:00:00.000Z", updatedAt: "2026-10-11T00:00:00.000Z" };
}

class FakeRunner implements DirectorRunner {
  events: string[] = [];
  running?: string;
  routes = new Map<string, KnoxSyncEngineOptions["route"]>();
  failIds = new Set<string>();
  followed?: string;
  async start(connection: ConnectionMetadata, options: KnoxSyncEngineOptions): Promise<ConnectionRuntimeState> {
    this.events.push(`start ${connection.id}`);
    if (this.failIds.has(connection.id)) return { connectionId: connection.id, state: "error", backend: "unknown", lastError: "Connector token is not configured" };
    assert.equal(this.running, undefined, "one connection at a time");
    this.running = connection.id; this.routes.set(connection.id, options.route);
    return { connectionId: connection.id, state: "running", backend: "unknown" };
  }
  async stopAndWait(id: string): Promise<void> { this.events.push(`stop ${id}`); if (this.running === id) this.running = undefined; }
  followSave(_id: string, saveId: string | undefined): void { this.followed = saveId; }
}

async function directorFixture(connections: LinkConnection[]) {
  const exchangeDirectory = await mkdtemp(path.join(os.tmpdir(), "knox-director-"));
  const paths = queuePaths(exchangeDirectory);
  await ensureQueueDirectories(paths);
  const runner = new FakeRunner();
  let now = Date.now();
  const list = [...connections];
  const director = new BridgeDirector({ exchangeDirectory, runner, bridgeVersion: "0.3.0", connections: async () => list.map(metadata), clock: () => now });
  const heartbeatPath = path.join(paths.gameTelemetry, GAME_HEARTBEAT_FILE);
  const writeGame = async (content: Record<string, unknown>, at = now) => {
    await writeFile(heartbeatPath, JSON.stringify(content));
    await utimes(heartbeatPath, at / 1000, at / 1000);
  };
  const bridgeFile = async () => JSON.parse(await readFile(path.join(paths.bridgePending, BRIDGE_HEARTBEAT_FILE), "utf8"));
  return { exchangeDirectory, paths, runner, director, writeGame, bridgeFile, list, advance: (ms: number) => { now += ms; }, now: () => now };
}

test("director: idle without a game, runs the save's network, switches with the save, idles when the game stops", async () => {
  const f = await directorFixture([A, B]);
  try {
    await f.director.tick();
    assert.equal(f.runner.running, undefined, "no game: no connection, no web calls");
    assert.equal((await f.bridgeFile()).state, "idle");
    assert.deepEqual((await f.bridgeFile()).connections.map((item: { networkId: string }) => item.networkId), ["netA", "netB"]);

    await f.writeGame(beat({ networkId: "netB" }));
    await f.director.tick();
    assert.equal(f.runner.running, "conn-b"); assert.equal(f.runner.followed, "save_one");
    const first = await f.bridgeFile();
    assert.equal(first.state, "active"); assert.equal(first.activeNetworkId, "netB"); assert.equal(first.saveId, "save_one");
    assert.equal(JSON.parse(await readFile(path.join(f.paths.state, SAVE_NETWORKS_FILE), "utf8")).saves.save_one, "netB");

    // Another save on another network: the running connection stops first, then the other starts.
    f.advance(1000); await f.writeGame(beat({ saveId: "save_two", networkId: "netA" }));
    await f.director.tick();
    assert.deepEqual(f.runner.events, ["start conn-b", "stop conn-b", "start conn-a"]);
    assert.equal(f.runner.followed, "save_two");
    // Files are routed by save: save_one's waits for netB, save_two's goes to netA.
    const route = f.runner.routes.get("conn-a")!;
    assert.equal(route("save_one"), false); assert.equal(route("save_two"), true);

    // The beat counter moves every 3 s even when nothing changes.
    const before = (await f.bridgeFile()).beat;
    f.advance(1000); await f.writeGame(beat({ saveId: "save_two", networkId: "netA" }), f.now()); await f.director.tick();
    assert.equal((await f.bridgeFile()).beat, before, "no change within 3 s");
    f.advance(3000); await f.writeGame(beat({ saveId: "save_two", networkId: "netA" }), f.now()); await f.director.tick();
    assert.equal((await f.bridgeFile()).beat, before + 1);

    // No heartbeat for more than 15 s: idle.
    f.advance(16_000); await f.director.tick();
    assert.equal(f.runner.running, undefined);
    assert.equal((await f.bridgeFile()).state, "idle");

    await f.director.stop();
    assert.equal((await f.bridgeFile()).state, "stopped");
  } finally { await rm(f.exchangeDirectory, { recursive: true, force: true }); }
});

test("director: an unlinked save or a network without a connection runs nothing and says why", async () => {
  const f = await directorFixture([A]);
  try {
    await f.writeGame(beat());
    await f.director.tick();
    assert.equal(f.runner.running, undefined);
    assert.equal((await f.bridgeFile()).state, "unlinked");
    assert.equal(f.director.current().state, "unlinked");
    await f.writeGame(beat({ networkId: "netB" }));
    await f.director.tick();
    assert.equal(f.runner.running, undefined);
    const file = await f.bridgeFile();
    assert.equal(file.state, "no_connection"); assert.equal(file.networkId, "netB");
    // Adding the connection is picked up on the next tick.
    f.list.push(B); await f.director.tick();
    assert.equal(f.runner.running, "conn-b");
  } finally { await rm(f.exchangeDirectory, { recursive: true, force: true }); }
});

test("director: a connection that cannot start is reported to the game and retried after 30 s", async () => {
  const f = await directorFixture([A]);
  try {
    f.runner.failIds.add("conn-a");
    await f.writeGame(beat({ networkId: "netA" }));
    await f.director.tick();
    const file = await f.bridgeFile();
    assert.equal(file.state, "error"); assert.match(file.message, /cannot start TESTING Single player 3: Connector token/);
    f.advance(1000); await f.writeGame(beat({ networkId: "netA" })); await f.director.tick();
    assert.deepEqual(f.runner.events, ["start conn-a"], "no retry within 30 s");
    f.runner.failIds.clear();
    f.advance(30_000); await f.writeGame(beat({ networkId: "netA" })); await f.director.tick();
    assert.equal(f.runner.running, "conn-a");
    assert.equal((await f.bridgeFile()).state, "active");
  } finally { await rm(f.exchangeDirectory, { recursive: true, force: true }); }
});

test("director: an older Mission Board without a heartbeat still gets a connection from its telemetry", async () => {
  const f = await directorFixture([A, B]);
  try {
    const telemetry = path.join(f.paths.gameTelemetry, "current.json");
    await writeFile(path.join(f.paths.state, SAVE_NETWORKS_FILE), JSON.stringify({ saves: { save_old: "netB" } }));
    await writeFile(telemetry, JSON.stringify({ payload: { snapshot: { saveId: "save_old" } } }));
    await utimes(telemetry, f.now() / 1000, f.now() / 1000);
    await f.director.tick();
    assert.equal(f.runner.running, "conn-b");
    assert.equal(f.director.current().legacy, true);
    assert.equal(f.runner.routes.get("conn-b")!("save_other"), true, "older boards send every file, as before");
    // A Mission Board with a heartbeat that just quit leaves fresh telemetry behind: not a legacy game.
    await f.director.stop();
    const g = await directorFixture([A]);
    try {
      const gTelemetry = path.join(g.paths.gameTelemetry, "current.json");
      await g.writeGame(beat({ networkId: "netA" }), g.now() - 20_000);
      await writeFile(gTelemetry, "{}"); await utimes(gTelemetry, (g.now() - 12_000) / 1000, (g.now() - 12_000) / 1000);
      await g.director.tick();
      assert.equal(g.runner.running, undefined);
      assert.equal(g.director.current().state, "idle");
    } finally { await rm(g.exchangeDirectory, { recursive: true, force: true }); }
  } finally { await rm(f.exchangeDirectory, { recursive: true, force: true }); }
});
