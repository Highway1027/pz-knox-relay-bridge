// src/config/KnoxBridgeConfig.ts
// v4 - 24-09-2026 - Add Phase 4 mission polling configuration

import { readFile } from "node:fs/promises";
import path from "node:path";

export interface KnoxBridgeConfig {
  connectorVersion: string;
  exchangeDirectory: string;
  pollIntervalMs: number;
  stableFileAgeMs: number;
  httpTimeoutMs: number;
  retryInitialMs: number;
  retryMaxMs: number;
  syncEndpoint: string;
  telemetryEndpoint: string;
  missionSyncEndpoint: string;
  missionPollIntervalMs: number;
  networkId: string;
  connectorToken: string;
}

const DEFAULT_EXCHANGE_DIRECTORY = path.join(process.env.USERPROFILE ?? ".", "Zomboid", "Lua", "KnoxRelay");

export const DEFAULT_CONFIG: KnoxBridgeConfig = {
  connectorVersion: "0.1.0",
  exchangeDirectory: DEFAULT_EXCHANGE_DIRECTORY,
  pollIntervalMs: 1000,
  stableFileAgeMs: 750,
  httpTimeoutMs: 5000,
  retryInitialMs: 2000,
  retryMaxMs: 60000,
  syncEndpoint: "",
  telemetryEndpoint: "",
  missionSyncEndpoint: "",
  missionPollIntervalMs: 5000,
  networkId: "",
  connectorToken: "",
};

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

export async function loadConfig(configPath = path.resolve("config.json")): Promise<KnoxBridgeConfig> {
  let raw: Partial<KnoxBridgeConfig> = {};

  try {
    raw = JSON.parse(await readFile(configPath, "utf8")) as Partial<KnoxBridgeConfig>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(`Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    ...DEFAULT_CONFIG,
    ...raw,
    exchangeDirectory: path.resolve(raw.exchangeDirectory || DEFAULT_CONFIG.exchangeDirectory),
    pollIntervalMs: positiveInteger(raw.pollIntervalMs, DEFAULT_CONFIG.pollIntervalMs),
    stableFileAgeMs: positiveInteger(raw.stableFileAgeMs, DEFAULT_CONFIG.stableFileAgeMs),
    httpTimeoutMs: positiveInteger(raw.httpTimeoutMs, DEFAULT_CONFIG.httpTimeoutMs),
    missionPollIntervalMs: positiveInteger(raw.missionPollIntervalMs, DEFAULT_CONFIG.missionPollIntervalMs),
    retryInitialMs: positiveInteger(raw.retryInitialMs, DEFAULT_CONFIG.retryInitialMs),
    retryMaxMs: positiveInteger(raw.retryMaxMs, DEFAULT_CONFIG.retryMaxMs),
  };
}
