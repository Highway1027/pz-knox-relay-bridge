// src/desktop/ConnectionStore.ts
// v1 - 26-09-2026 - Persist multi-connection metadata separately from encrypted tokens

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ConnectionMetadata, ImportedConnection } from "./ConnectionTypes.js";

export interface SecretVault { encrypt(value: string): Promise<string>; decrypt(value: string): Promise<string> }
interface StoreDocument { version: 1; connections: ConnectionMetadata[] }
interface SecretDocument { version: 1; tokens: Record<string, string> }
async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(filePath, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}
export class ConnectionStore {
  private readonly metadataPath: string; private readonly secretsPath: string;
  constructor(private readonly directory: string, private readonly vault: SecretVault) {
    this.metadataPath = path.join(directory, "connections.json"); this.secretsPath = path.join(directory, "secrets.json");
  }
  async list(): Promise<ConnectionMetadata[]> { return (await readJson<StoreDocument>(this.metadataPath, { version: 1, connections: [] })).connections; }
  async add(imported: ImportedConnection, requestedName?: string): Promise<ConnectionMetadata> {
    await mkdir(this.directory, { recursive: true });
    const connections = await this.list(); const now = new Date().toISOString();
    const connection: ConnectionMetadata = {
      id: randomUUID(), name: requestedName?.trim() || imported.name || `Knox Network ${imported.networkId.slice(0, 8)}`,
      networkId: imported.networkId, telemetryEndpoint: imported.telemetryEndpoint, missionSyncEndpoint: imported.missionSyncEndpoint,
      ...(imported.syncEndpoint ? { syncEndpoint: imported.syncEndpoint } : {}), ...(imported.exchangeRootOverride ? { exchangeRootOverride: imported.exchangeRootOverride } : {}), createdAt: now, updatedAt: now,
    };
    const secrets = await readJson<SecretDocument>(this.secretsPath, { version: 1, tokens: {} });
    secrets.tokens[connection.id] = await this.vault.encrypt(imported.connectorToken);
    await writeFile(this.metadataPath, `${JSON.stringify({ version: 1, connections: [...connections, connection] }, null, 2)}\n`, { mode: 0o600 });
    await writeFile(this.secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
    return connection;
  }
  async token(id: string): Promise<string> {
    const encrypted = (await readJson<SecretDocument>(this.secretsPath, { version: 1, tokens: {} })).tokens[id];
    if (!encrypted) throw new Error("Connector token is not configured"); return this.vault.decrypt(encrypted);
  }
  async update(id: string, changes: { name: string; exchangeRootOverride?: string }, replacementToken?: string): Promise<ConnectionMetadata> {
    const document = await readJson<StoreDocument>(this.metadataPath, { version: 1, connections: [] }); const index = document.connections.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("Connection not found"); const current = document.connections[index]!;
    const updated: ConnectionMetadata = { ...current, name: changes.name.trim() || current.name, updatedAt: new Date().toISOString() };
    if (changes.exchangeRootOverride?.trim()) updated.exchangeRootOverride = changes.exchangeRootOverride.trim(); else delete updated.exchangeRootOverride;
    document.connections[index] = updated; await writeFile(this.metadataPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    if (replacementToken) { const secrets = await readJson<SecretDocument>(this.secretsPath, { version: 1, tokens: {} }); secrets.tokens[id] = await this.vault.encrypt(replacementToken); await writeFile(this.secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 }); }
    return updated;
  }
  async remove(id: string): Promise<void> {
    const document = await readJson<StoreDocument>(this.metadataPath, { version: 1, connections: [] }); document.connections = document.connections.filter((item) => item.id !== id);
    const secrets = await readJson<SecretDocument>(this.secretsPath, { version: 1, tokens: {} }); delete secrets.tokens[id];
    await mkdir(this.directory, { recursive: true }); await writeFile(this.metadataPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 }); await writeFile(this.secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  }
}
