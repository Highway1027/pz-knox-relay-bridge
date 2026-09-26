// src/setup/KnoxSetup.ts
// v1 - 26-09-2026 - Add first-run credential setup and safe local persistence

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readLocalConfig, type RuntimeEnvironment } from "../config/KnoxBridgeConfig.js";

async function promptVisible(label: string): Promise<string> {
  const terminal = createInterface({ input: stdin, output: stdout });
  try { return (await terminal.question(`${label}: `)).trim(); }
  finally { terminal.close(); }
}

async function promptSecret(label: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") return promptVisible(label);
  stdout.write(`${label}: `);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const onData = (key: string): void => {
      if (key === "\r" || key === "\n") {
        stdin.off("data", onData);
        stdin.setRawMode(false);
        stdout.write("\n");
        resolve(value.trim());
      } else if (key === "\u0003") {
        stdin.setRawMode(false);
        process.kill(process.pid, "SIGINT");
      } else if (key === "\b" || key === "\u007f") {
        if (value) { value = value.slice(0, -1); stdout.write("\b \b"); }
      } else if (key >= " ") {
        value += key;
        stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

export function credentialsConfigured(networkId: string, connectorToken: string): boolean {
  return Boolean(networkId.trim() && connectorToken.trim());
}

export async function ensureCredentials(
  configPath = path.resolve("config.json"),
  environment: RuntimeEnvironment = process.env,
): Promise<void> {
  const raw = await readLocalConfig(configPath);
  if (credentialsConfigured(environment.KNOX_NETWORK_ID ?? raw.networkId ?? "", environment.KNOX_CONNECTOR_TOKEN ?? raw.connectorToken ?? "")) return;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Network ID and connector token are required. Run npm start in an interactive terminal, or set KNOX_NETWORK_ID and KNOX_CONNECTOR_TOKEN.");
  }
  stdout.write("\nKnox Relay Bridge - First Run\n\n");
  let networkId = "";
  let connectorToken = "";
  while (!networkId) networkId = await promptVisible("Network ID");
  while (!connectorToken) connectorToken = await promptSecret("Connector token");
  await writeFile(configPath, `${JSON.stringify({ ...raw, networkId, connectorToken }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  stdout.write(`Setup saved to ${path.basename(configPath)}.\n\n`);
}
