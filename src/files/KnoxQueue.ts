// src/files/KnoxQueue.ts
// v1 - 23-09-2026 - Implement durable directory queue reads, moves, and atomic writes

import { mkdir, open, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";

export interface KnoxQueuePaths {
  gamePending: string;
  gameProcessed: string;
  gameFailed: string;
  gameTelemetry: string;
  bridgePending: string;
  bridgeProcessed: string;
  state: string;
}

export function queuePaths(exchangeDirectory: string): KnoxQueuePaths {
  return {
    gamePending: path.join(exchangeDirectory, "game-to-bridge", "pending"),
    gameProcessed: path.join(exchangeDirectory, "game-to-bridge", "processed"),
    gameFailed: path.join(exchangeDirectory, "game-to-bridge", "failed"),
    gameTelemetry: path.join(exchangeDirectory, "game-to-bridge", "telemetry"),
    bridgePending: path.join(exchangeDirectory, "bridge-to-game", "pending"),
    bridgeProcessed: path.join(exchangeDirectory, "bridge-to-game", "processed"),
    state: path.join(exchangeDirectory, "state"),
  };
}

export async function ensureQueueDirectories(paths: KnoxQueuePaths): Promise<void> {
  await Promise.all(Object.values(paths).map((directory) => mkdir(directory, { recursive: true })));
}

export async function listStableJsonFiles(directory: string, stableFileAgeMs: number): Promise<string[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const now = Date.now();
  const stable: string[] = [];

  for (const name of names) {
    const filePath = path.join(directory, name);
    const details = await stat(filePath);
    if (details.isFile() && details.size > 0 && now - details.mtimeMs >= stableFileAgeMs) stable.push(filePath);
  }

  return stable;
}

export async function readJsonFile(filePath: string): Promise<unknown> {
  const file = await open(filePath, "r");
  try {
    return JSON.parse(await file.readFile({ encoding: "utf8" }));
  } finally {
    await file.close();
  }
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  const file = await open(temporaryPath, "wx");
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporaryPath, filePath);
}

export async function moveQueueFile(source: string, destinationDirectory: string): Promise<void> {
  await rename(source, path.join(destinationDirectory, path.basename(source)));
}
