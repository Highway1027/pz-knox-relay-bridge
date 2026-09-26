// src/diagnostics/KnoxDiagnostics.ts
// v1 - 26-09-2026 - Add secret-safe startup and doctor diagnostics

import os from "node:os";
import { access, constants, stat } from "node:fs/promises";
import path from "node:path";
import type { KnoxBridgeConfig } from "../config/KnoxBridgeConfig.js";
import { automaticPzDirectory } from "../config/KnoxBridgeConfig.js";

export function startupDiagnostics(config: KnoxBridgeConfig, homeDirectory = os.homedir()): string[] {
  return [
    "Knox Relay Bridge",
    `Platform: ${process.platform}`,
    `Home: ${homeDirectory}`,
    `Exchange root: ${config.exchangeDirectory}`,
    `Exchange root source: ${config.exchangeDirectorySource}`,
    `Network: ${config.networkId ? "configured" : "missing"}`,
    `Backend: ${config.missionSyncEndpoint || config.telemetryEndpoint || config.syncEndpoint || "missing"}`,
  ];
}

async function isDirectory(directory: string): Promise<boolean> {
  try { return (await stat(directory)).isDirectory(); } catch { return false; }
}

export async function validateExchangeParent(config: KnoxBridgeConfig, homeDirectory = os.homedir()): Promise<void> {
  if (config.exchangeDirectorySource !== "automatic") return;
  const pzDirectory = automaticPzDirectory(homeDirectory);
  if (!(await isDirectory(pzDirectory))) {
    throw new Error(`Knox Relay could not find the Project Zomboid user-data folder.\n\nExpected default:\n  ${pzDirectory}\n\nStart Project Zomboid once on this account and make sure Knox Relay Connector is installed/enabled.\nYou may also set KNOX_EXCHANGE_ROOT for a custom exchange path.`);
  }
}

export async function doctorLines(config: KnoxBridgeConfig, homeDirectory = os.homedir()): Promise<string[]> {
  const pzDirectory = automaticPzDirectory(homeDirectory);
  const checks: Array<[string, boolean]> = [
    [`Node ${process.version}`, Number(process.versions.node.split(".")[0]) >= 20],
    ["Network ID configured", Boolean(config.networkId)],
    ["Connector token configured", Boolean(config.connectorToken)],
    ["Project Zomboid user folder found", await isDirectory(pzDirectory)],
    ["Backend endpoint configured", Boolean(config.missionSyncEndpoint || config.telemetryEndpoint)],
  ];
  try { await access(config.exchangeDirectory, constants.R_OK); checks.push(["Knox exchange folder readable", true]); }
  catch { checks.push(["Knox exchange folder readable", false]); }
  try { await access(config.exchangeDirectory, constants.W_OK); checks.push(["Knox exchange folder writable", true]); }
  catch { checks.push(["Knox exchange folder writable", false]); }
  return ["Knox Relay Bridge Doctor", `Exchange root: ${path.normalize(config.exchangeDirectory)}`, ...checks.map(([label, ok]) => `${ok ? "OK" : "FAIL"} ${label}`)];
}
