// tests/KnoxApiClient.test.ts
// v2 - 24-09-2026 - Verify Phase 4 authenticated mission pull and queue acknowledgement

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config/KnoxBridgeConfig.js";
import { KnoxApiClient } from "../src/http/KnoxApiClient.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address");
  return `http://127.0.0.1:${address.port}/knoxConnectorPing`;
}

test("posts the exact ping schema and validates the response", async () => {
  let received: unknown;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received = JSON.parse(body);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, protocolVersion: 1, message: "hello from Knox Relay" }));
    });
  });
  try {
    const syncEndpoint = await listen(server);
    const client = new KnoxApiClient({ ...DEFAULT_CONFIG, syncEndpoint });
    const result = await client.sendConnectorTest("hello from Project Zomboid");
    assert.deepEqual(received, {
      protocolVersion: 1,
      connectorVersion: "0.1.0",
      message: "hello from Project Zomboid",
    });
    assert.equal(result.message, "hello from Knox Relay");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("aborts a request at the configured timeout", async () => {
  const server = createServer((_request, response) => {
    setTimeout(() => response.end("{}"), 100);
  });
  try {
    const syncEndpoint = await listen(server);
    const client = new KnoxApiClient({ ...DEFAULT_CONFIG, syncEndpoint, httpTimeoutMs: 10 });
    await assert.rejects(client.sendConnectorTest("hello from Project Zomboid"), /timed out after 10ms/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("posts telemetry with Network association and connector token", async () => {
  let received: any; let receivedToken = "";
  const server = createServer((request, response) => {
    let body = ""; request.setEncoding("utf8"); request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => { received = JSON.parse(body); receivedToken = String(request.headers["x-knox-connector-token"]); response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ ok: true, protocolVersion: 1, messageId: received.messageId })); });
  });
  try {
    const telemetryEndpoint = await listen(server);
    const client = new KnoxApiClient({ ...DEFAULT_CONFIG, telemetryEndpoint, networkId: "network-1", connectorToken: "secret" });
    await client.sendTelemetry({ protocolVersion: 1, messageId: "evt_telemetry_api", type: "game_telemetry", createdAt: new Date().toISOString(), payload: { gameTime: { year: 1993, month: 7, day: 9, hour: 12, minute: 0 }, players: [{ username: "Tim", characterName: "Tim Knox", x: 1, y: 2, z: 0 }] } });
    assert.equal(received.networkId, "network-1"); assert.equal(received.connectorVersion, "0.1.0"); assert.equal(receivedToken, "secret");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("pulls and acknowledges the strict test mission", async () => {
  const actions: any[] = [];
  const server = createServer((request, response) => {
    let body = ""; request.setEncoding("utf8"); request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const value = JSON.parse(body); actions.push(value);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value.action === "pull"
        ? { ok: true, protocolVersion: 1, mission: { protocolVersion: 1, missionId: "test_001", missionVersion: 1, title: "Connector Test Mission", status: "active", objective: { type: "test", text: "Verify Web to Project Zomboid mission transport." } } }
        : { ok: true, protocolVersion: 1, missionId: "test_001" }));
    });
  });
  try {
    const missionSyncEndpoint = await listen(server);
    const client = new KnoxApiClient({ ...DEFAULT_CONFIG, missionSyncEndpoint, networkId: "network-1", connectorToken: "secret" });
    assert.equal((await client.pullMission()).mission?.missionId, "test_001");
    await client.acknowledgeMissionQueued("test_001");
    assert.deepEqual(actions.map((value) => value.action), ["pull", "queued"]);
    assert.equal(actions[0].networkId, "network-1");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
