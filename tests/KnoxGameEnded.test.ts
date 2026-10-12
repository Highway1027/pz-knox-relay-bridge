// tests/KnoxGameEnded.test.ts
// Game ended (Bridge 0.3.2, Connector plan, Bridge detection "Later"): when the game heartbeat of a save stops, or
// another save is loaded, the connection that ran it sends knoxMissionSync action "game_ended" once, after its last
// calls, so the backend can close the play session and write its recap sooner.

import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config/KnoxBridgeConfig.js";
import { BridgeDirector, gameEnded, type DirectorRunner } from "../src/desktop/BridgeDirector.js";
import type { ConnectionRuntimeState } from "../src/desktop/BridgeRuntimeManager.js";
import type { ConnectionMetadata } from "../src/desktop/ConnectionTypes.js";
import { ensureQueueDirectories, queuePaths } from "../src/files/KnoxQueue.js";
import { KnoxApiClient, type KnoxApiTransport } from "../src/http/KnoxApiClient.js";
import { KnoxLogger, type KnoxLogEvent } from "../src/logging/KnoxLogger.js";
import type { GameEndedResponse } from "../src/protocol/KnoxProtocol.js";
import { validateGameEndedResponse } from "../src/protocol/KnoxValidators.js";
import { GAME_HEARTBEAT_FILE, type LinkConnection } from "../src/sync/KnoxGameLink.js";
import { KnoxSyncEngine, type KnoxSyncEngineOptions } from "../src/sync/KnoxSyncEngine.js";

const A: LinkConnection = { id: "conn-a", networkId: "netA", name: "Main game" };
const B: LinkConnection = { id: "conn-b", networkId: "netB", name: "Test game" };
const beat = (extra: Record<string, unknown> = {}) => ({ protocolVersion: 1, beat: 7, saveId: "save_one", mode: "sp", networkId: "netA", ...extra });

test("a game_ended answer validates with exactly its fields and the same save", () => {
  const answer = { ok: true, protocolVersion: 1, saveId: "save_one", sessionOpen: true };
  assert.equal(validateGameEndedResponse(answer, "save_one").sessionOpen, true);
  assert.throws(() => validateGameEndedResponse({ ...answer, saveId: "save_two" }, "save_one"), /game end/);
  assert.throws(() => validateGameEndedResponse({ ...answer, extra: 1 }, "save_one"), /game end/);
  assert.throws(() => validateGameEndedResponse({ ok: false, error: "invalid_request" }, "save_one"), /game end/);
});

test("the client posts action game_ended with the save", async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let body = ""; request.setEncoding("utf8"); request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const value = JSON.parse(body) as Record<string, unknown>; bodies.push(value);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, protocolVersion: 1, saveId: value.saveId, sessionOpen: false }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const client = new KnoxApiClient({ ...DEFAULT_CONFIG, missionSyncEndpoint: `http://127.0.0.1:${address.port}/sync`, networkId: "netA", connectorToken: "secret" });
    assert.equal((await client.reportGameEnded("save_one")).sessionOpen, false);
    assert.deepEqual(Object.keys(bodies[0]!).sort(), ["action", "connectorVersion", "networkId", "protocolVersion", "saveId"]);
    assert.equal(bodies[0]!.action, "game_ended"); assert.equal(bodies[0]!.saveId, "save_one");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("the engine reports the end once and never throws, also against an older backend", async () => {
  const exchangeDirectory = await mkdtemp(path.join(os.tmpdir(), "knox-ended-"));
  try {
    const sent: string[] = [];
    let fail = false;
    const api = { reportGameEnded: async (saveId: string): Promise<GameEndedResponse> => {
      sent.push(saveId);
      if (fail) throw new Error("backend returned HTTP 400");
      return { ok: true, protocolVersion: 1, saveId, sessionOpen: true };
    } } as unknown as KnoxApiTransport;
    const logger = new KnoxLogger(); const lines: KnoxLogEvent[] = []; logger.subscribe((event) => lines.push(event));
    const engine = new KnoxSyncEngine({ ...DEFAULT_CONFIG, exchangeDirectory }, logger, api);
    await engine.reportGameEnded("save_one");
    fail = true;
    await engine.reportGameEnded("save_one");
    assert.deepEqual(sent, ["save_one", "save_one"]);
    assert.match(lines.find((event) => event.level === "INFO" && /Game ended/.test(event.message))!.message, /recap follows/);
    assert.ok(lines.some((event) => event.level === "WARN" && /not told: backend returned HTTP 400/.test(event.message)));
    // A transport without the call (tests, older builds) does nothing.
    await new KnoxSyncEngine({ ...DEFAULT_CONFIG, exchangeDirectory }, logger, {} as KnoxApiTransport).reportGameEnded("save_one");
  } finally { await rm(exchangeDirectory, { recursive: true, force: true }); }
});

test("which save ended: the one played with a heartbeat, once it is gone or another is loaded", () => {
  const active = { state: "active" as const, saveId: "save_one", networkId: "netA", connection: A };
  assert.equal(gameEnded(active, { state: "idle" }), "save_one");
  assert.equal(gameEnded(active, { ...active, saveId: "save_two" }), "save_one");
  assert.equal(gameEnded(active, active), undefined);
  assert.equal(gameEnded(active, { state: "no_connection", saveId: "save_one", networkId: "netC" }), undefined);
  assert.equal(gameEnded({ ...active, legacy: true }, { state: "idle" }), undefined, "older boards: no heartbeat to go by");
  assert.equal(gameEnded({ state: "unlinked", saveId: "save_one" }, { state: "idle" }), undefined, "nothing ran for it");
});

// ---------------------------------------------------------------- director with a fake runner

class FakeRunner implements DirectorRunner {
  events: string[] = [];
  running?: string;
  async start(connection: ConnectionMetadata, _options: KnoxSyncEngineOptions): Promise<ConnectionRuntimeState> {
    this.events.push(`start ${connection.id}`); this.running = connection.id;
    return { connectionId: connection.id, state: "running", backend: "unknown" };
  }
  async stopAndWait(id: string, gameEndedSaveId?: string): Promise<void> {
    this.events.push(`stop ${id}`); if (gameEndedSaveId) this.events.push(`ended ${gameEndedSaveId} via ${id}`);
    if (this.running === id) this.running = undefined;
  }
  followSave(): void {}
  async reportGameEnded(id: string, saveId: string): Promise<void> { this.events.push(`ended ${saveId} via ${id}`); }
}

const metadata = (link: LinkConnection): ConnectionMetadata => ({ id: link.id, name: link.name, networkId: link.networkId,
  telemetryEndpoint: "https://example.test/t", missionSyncEndpoint: "https://example.test/m", createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z" });

test("director: the game stops, another save loads, another network: each tells the backend once", async () => {
  const exchangeDirectory = await mkdtemp(path.join(os.tmpdir(), "knox-ended-director-"));
  try {
    const paths = queuePaths(exchangeDirectory); await ensureQueueDirectories(paths);
    const runner = new FakeRunner(); let now = Date.now();
    const director = new BridgeDirector({ exchangeDirectory, runner, bridgeVersion: "0.3.2", connections: async () => [A, B].map(metadata), clock: () => now });
    const heartbeatPath = path.join(paths.gameTelemetry, GAME_HEARTBEAT_FILE);
    const writeGame = async (content: Record<string, unknown>) => { await writeFile(heartbeatPath, JSON.stringify(content)); await utimes(heartbeatPath, now / 1000, now / 1000); };

    await writeGame(beat()); await director.tick();
    // Another save on the same network: the connection keeps running and reports the first save.
    now += 1000; await writeGame(beat({ saveId: "save_two" })); await director.tick();
    // Another save on another network: stop, report, start the other.
    now += 1000; await writeGame(beat({ saveId: "save_three", networkId: "netB" })); await director.tick();
    // The heartbeat stops: idle, and the last save is reported.
    now += 16_000; await director.tick();
    await director.tick();
    assert.deepEqual(runner.events, ["start conn-a", "ended save_one via conn-a", "stop conn-a", "ended save_two via conn-a", "start conn-b",
      "stop conn-b", "ended save_three via conn-b"]);
    await director.stop();
    assert.equal(runner.events.length, 7, "closing the Bridge without a game says nothing more");
  } finally { await rm(exchangeDirectory, { recursive: true, force: true }); }
});
