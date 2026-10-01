// src/config/KnoxBridgeConfig.ts
// v5 - 26-09-2026 - Add portable defaults, environment precedence, and legacy overrides

import os from "node:os";
import { readFile } from "node:fs/promises";
import path from "node:path";

export type ExchangeDirectorySource = "environment" | "config override" | "automatic";

export interface KnoxBridgeConfig {
  connectorVersion: string;
  exchangeDirectory: string;
  exchangeDirectorySource: ExchangeDirectorySource;
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
  // Name of the connection in the desktop app; written into mission files for the save link notice.
  connectionName: string;
  connectorToken: string;
  // Old ack_ files in bridge-to-game/pending (PZ Lua cannot delete them) are removed after this age.
  acknowledgementMaxAgeMs: number;
}

export interface RuntimeEnvironment {
  KNOX_NETWORK_ID?: string;
  KNOX_CONNECTOR_TOKEN?: string;
  KNOX_EXCHANGE_ROOT?: string;
}

type ConfigFile = Partial<KnoxBridgeConfig> & { exchangeRoot?: string };

export function automaticPzDirectory(homeDirectory = os.homedir(), platform = process.platform): string {
  // PZ currently uses the same home-relative user-data layout on all supported desktop platforms.
  return (platform === "win32" ? path.win32 : path.posix).join(homeDirectory, "Zomboid");
}

export function automaticExchangeDirectory(homeDirectory = os.homedir(), platform = process.platform): string {
  return (platform === "win32" ? path.win32 : path.posix).join(automaticPzDirectory(homeDirectory, platform), "Lua", "KnoxRelay");
}

export const DEFAULT_CONFIG: KnoxBridgeConfig = {
  connectorVersion: "0.1.0",
  exchangeDirectory: automaticExchangeDirectory(),
  exchangeDirectorySource: "automatic",
  pollIntervalMs: 1000,
  stableFileAgeMs: 750,
  httpTimeoutMs: 5000,
  retryInitialMs: 2000,
  retryMaxMs: 60000,
  syncEndpoint: "https://europe-west1-wildshape-tracker.cloudfunctions.net/knoxConnectorPing",
  telemetryEndpoint: "https://europe-west1-wildshape-tracker.cloudfunctions.net/knoxTelemetryIngest",
  missionSyncEndpoint: "https://europe-west1-wildshape-tracker.cloudfunctions.net/knoxMissionSync",
  missionPollIntervalMs: 5000,
  networkId: "",
  connectionName: "",
  connectorToken: "",
  acknowledgementMaxAgeMs: 24 * 60 * 60 * 1000,
};

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveExchangeDirectory(
  raw: ConfigFile = {},
  environment: RuntimeEnvironment = process.env,
  homeDirectory = os.homedir(),
  platform = process.platform,
): { directory: string; source: ExchangeDirectorySource } {
  const environmentOverride = nonEmpty(environment.KNOX_EXCHANGE_ROOT);
  const configOverride = nonEmpty(raw.exchangeRoot) ?? nonEmpty(raw.exchangeDirectory);
  if (environmentOverride) return { directory: path.resolve(environmentOverride), source: "environment" };
  if (configOverride) return { directory: path.resolve(configOverride), source: "config override" };
  return { directory: automaticExchangeDirectory(homeDirectory, platform), source: "automatic" };
}

export async function readLocalConfig(configPath = path.resolve("config.json")): Promise<ConfigFile> {
  try {
    return JSON.parse(await readFile(configPath, "utf8")) as ConfigFile;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw new Error(`Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function loadConfig(
  configPath = path.resolve("config.json"),
  environment: RuntimeEnvironment = process.env,
  homeDirectory = os.homedir(),
  platform = process.platform,
): Promise<KnoxBridgeConfig> {
  const raw = await readLocalConfig(configPath);
  const exchange = resolveExchangeDirectory(raw, environment, homeDirectory, platform);
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    exchangeDirectory: exchange.directory,
    exchangeDirectorySource: exchange.source,
    networkId: nonEmpty(environment.KNOX_NETWORK_ID) ?? nonEmpty(raw.networkId) ?? "",
    connectionName: nonEmpty(raw.connectionName) ?? "",
    connectorToken: nonEmpty(environment.KNOX_CONNECTOR_TOKEN) ?? nonEmpty(raw.connectorToken) ?? "",
    acknowledgementMaxAgeMs: positiveInteger(raw.acknowledgementMaxAgeMs, DEFAULT_CONFIG.acknowledgementMaxAgeMs),
    pollIntervalMs: positiveInteger(raw.pollIntervalMs, DEFAULT_CONFIG.pollIntervalMs),
    stableFileAgeMs: positiveInteger(raw.stableFileAgeMs, DEFAULT_CONFIG.stableFileAgeMs),
    httpTimeoutMs: positiveInteger(raw.httpTimeoutMs, DEFAULT_CONFIG.httpTimeoutMs),
    missionPollIntervalMs: positiveInteger(raw.missionPollIntervalMs, DEFAULT_CONFIG.missionPollIntervalMs),
    retryInitialMs: positiveInteger(raw.retryInitialMs, DEFAULT_CONFIG.retryInitialMs),
    retryMaxMs: positiveInteger(raw.retryMaxMs, DEFAULT_CONFIG.retryMaxMs),
  };
}
