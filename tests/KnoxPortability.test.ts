// tests/KnoxPortability.test.ts
// v1 - 26-09-2026 - Cover portable path, precedence, setup, and secret-safe diagnostics

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { automaticExchangeDirectory, loadConfig, resolveExchangeDirectory } from "../src/config/KnoxBridgeConfig.js";
import { startupDiagnostics } from "../src/diagnostics/KnoxDiagnostics.js";
import { credentialsConfigured, ensureCredentials } from "../src/setup/KnoxSetup.js";

test("automatic paths use platform-safe separators for Windows, macOS, and Linux", () => {
  assert.equal(automaticExchangeDirectory("C:\\Users\\Alex", "win32"), "C:\\Users\\Alex\\Zomboid\\Lua\\KnoxRelay");
  assert.equal(automaticExchangeDirectory("/Users/alex", "darwin"), "/Users/alex/Zomboid/Lua/KnoxRelay");
  assert.equal(automaticExchangeDirectory("/home/alex", "linux"), "/home/alex/Zomboid/Lua/KnoxRelay");
});

test("exchange precedence is environment, config, then automatic", () => {
  assert.equal(resolveExchangeDirectory({ exchangeRoot: "config-root" }, { KNOX_EXCHANGE_ROOT: "env-root" }, "/home/a", "linux").source, "environment");
  assert.equal(resolveExchangeDirectory({ exchangeRoot: "config-root" }, {}, "/home/a", "linux").source, "config override");
  assert.deepEqual(resolveExchangeDirectory({ exchangeRoot: "  " }, {}, "/home/a", "linux"), { directory: "/home/a/Zomboid/Lua/KnoxRelay", source: "automatic" });
});

test("legacy exchangeDirectory config remains valid", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "knox-config-"));
  const configPath = path.join(directory, "config.json");
  try {
    await writeFile(configPath, JSON.stringify({ exchangeDirectory: "legacy-root", networkId: "file-network", connectorToken: "file-token" }));
    const config = await loadConfig(configPath, { KNOX_NETWORK_ID: "env-network" }, "/home/a", "linux");
    assert.equal(config.exchangeDirectorySource, "config override");
    assert.equal(config.networkId, "env-network");
    assert.equal(config.connectorToken, "file-token");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("startup diagnostics never contain the connector token", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "knox-config-"));
  const configPath = path.join(directory, "config.json");
  try {
    await writeFile(configPath, JSON.stringify({ networkId: "network", connectorToken: "super-secret-token" }));
    const output = startupDiagnostics(await loadConfig(configPath, {}, "/home/a", "linux")).join("\n");
    assert.equal(output.includes("super-secret-token"), false);
    assert.match(output, /Network: configured/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("setup accepts environment credentials without writing local config", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "knox-setup-"));
  const configPath = path.join(directory, "config.json");
  try {
    assert.equal(credentialsConfigured("network", "token"), true);
    await ensureCredentials(configPath, { KNOX_NETWORK_ID: "network", KNOX_CONNECTOR_TOKEN: "token" });
    await assert.rejects(readFile(configPath), /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("local secret config is excluded from Git", async () => {
  const ignore = await readFile(path.resolve(".gitignore"), "utf8");
  assert.match(ignore, /^config\.json$/m);
});
