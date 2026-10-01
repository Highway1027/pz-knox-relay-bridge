// src/files/KnoxQueue.ts
// v1 - 23-09-2026 - Implement durable directory queue reads, moves, and atomic writes

import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
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

let temporaryCounter = 0;
// Windows refuses to replace a file another program has open (PZ reading the index or a mission file).
const LOCKED_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 6;

// The reader sees the old file or the complete new one, never a half-written file: the content goes to a
// temporary name (never *.json, so neither PZ nor the index sees it) and is renamed into place. The temporary
// name is unique per write, so a leftover can never block later writes; a failed write removes its own.
export interface AtomicWriteOptions {
  renameFile?: (from: string, to: string) => Promise<void>;
  waitMs?: (ms: number) => Promise<void>;
}

export async function atomicWriteJson(filePath: string, value: unknown, options: AtomicWriteOptions = {}): Promise<void> {
  const renameFile = options.renameFile ?? rename;
  const waitMs = options.waitMs ?? delay;
  temporaryCounter = (temporaryCounter + 1) % 1_000_000;
  const temporaryPath = `${filePath}.${process.pid}-${Date.now()}-${temporaryCounter}.tmp`;
  try {
    const file = await open(temporaryPath, "wx");
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        await renameFile(temporaryPath, filePath);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (!LOCKED_CODES.has(code) || attempt >= RENAME_ATTEMPTS) throw error;
        await waitMs(25 * attempt);
      }
    }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function moveQueueFile(source: string, destinationDirectory: string): Promise<void> {
  await rename(source, path.join(destinationDirectory, path.basename(source)));
}
