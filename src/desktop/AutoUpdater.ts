// src/desktop/AutoUpdater.ts
// v2 - 27-09-2026 - Bounded download and ZIP guard before the launcher unpacks the update

// Updatable code: it only downloads. Verification and installation stay in the launcher
// (desktop/updater-core.cjs), which rejects anything not signed with the publisher key.

import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkZipBuffer } from "./ZipGuard.js";

// GitHub's stable "latest release" address; releases are published by .github/workflows/release.yml.
export const DEFAULT_FEED_URL = "https://github.com/Highway1027/pz-knox-relay-bridge/releases/latest/download/latest.json";
const MAX_UPDATE_BYTES = 30 * 1024 * 1024;
const TIMEOUT_MS = 20000;

export type LatestInfo = { version: string; file: string; sha256: string; size: number; publishedAt?: string };
export type InstallResult = { ok: boolean; version?: string; reason?: string };
export type CheckResult =
  | { status: "up-to-date"; version: string }
  | { status: "installed"; version: string }
  | { status: "error"; reason: string };

export type AutoUpdaterOptions = {
  feedUrl?: string;
  currentVersion: () => string;
  install: (file: string) => InstallResult;
  downloadDir: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
};

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

export function parseLatest(value: unknown): LatestInfo {
  const info = value as Partial<LatestInfo> | null;
  if (!info || typeof info !== "object") throw new Error("latest.json is not an object");
  if (typeof info.version !== "string" || !/^\d+\.\d+\.\d+$/.test(info.version)) throw new Error("latest.json has no valid version");
  if (typeof info.file !== "string" || !/^[\w.-]+\.zip$/.test(info.file)) throw new Error("latest.json has no valid file name");
  if (typeof info.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(info.sha256)) throw new Error("latest.json has no valid sha256");
  if (typeof info.size !== "number" || info.size <= 0 || info.size > MAX_UPDATE_BYTES) throw new Error("latest.json has an invalid size");
  return { version: info.version, file: info.file, sha256: info.sha256, size: info.size, publishedAt: info.publishedAt };
}

export class AutoUpdater {
  private readonly feedUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (message: string) => void;
  private installedThisSession: string | undefined;
  private running = false;

  constructor(private readonly options: AutoUpdaterOptions) {
    this.feedUrl = options.feedUrl ?? DEFAULT_FEED_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? (() => undefined);
  }

  private async get(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal, redirect: "follow", headers: { "User-Agent": "Knox-Relay-Bridge" } });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return response;
    } finally { clearTimeout(timer); }
  }

  // Reads a response body, stopping as soon as it exceeds the size latest.json announced.
  private async readBounded(response: Response, expected: number): Promise<Buffer> {
    if (!response.body) throw new Error("download has no body");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > expected) { await reader.cancel(); throw new Error(`download is larger than the announced ${expected} bytes`); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  // One check: newer release? download, verify its checksum, hand it to the launcher to install.
  async check(): Promise<CheckResult> {
    if (this.running) return { status: "error", reason: "a check is already running" };
    this.running = true;
    try {
      const latest = parseLatest(await (await this.get(this.feedUrl)).json());
      const current = this.installedThisSession ?? this.options.currentVersion();
      if (compareVersions(latest.version, current) <= 0) return { status: "up-to-date", version: current };
      const response = await this.get(new URL(latest.file, this.feedUrl).href);
      const bytes = await this.readBounded(response, latest.size);
      if (bytes.length !== latest.size) throw new Error(`download size ${bytes.length} does not match ${latest.size}`);
      if (createHash("sha256").update(bytes).digest("hex") !== latest.sha256) throw new Error("download checksum does not match");
      checkZipBuffer(bytes);
      await mkdir(this.options.downloadDir, { recursive: true });
      const file = path.join(this.options.downloadDir, latest.file);
      await writeFile(file, bytes);
      try {
        const result = this.options.install(file);
        if (!result.ok || !result.version) throw new Error(result.reason ?? "install failed");
        this.installedThisSession = result.version;
        this.log(`Update ${result.version} downloaded and installed; it runs after a restart.`);
        return { status: "installed", version: result.version };
      } finally { await rm(file, { force: true }); }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.log(`Update check failed: ${reason}`);
      return { status: "error", reason };
    } finally { this.running = false; }
  }
}
