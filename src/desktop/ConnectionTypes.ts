// src/desktop/ConnectionTypes.ts
// v2 - 27-09-2026 - HTTPS-only endpoints (localhost excepted) and Knox backend host check

export interface ConnectionMetadata {
  id: string; name: string; networkId: string; telemetryEndpoint: string; missionSyncEndpoint: string;
  syncEndpoint?: string; exchangeRootOverride?: string; createdAt: string; updatedAt: string;
}
export interface ImportedConnection {
  name?: string; networkId: string; connectorToken: string; telemetryEndpoint: string; missionSyncEndpoint: string;
  syncEndpoint?: string; exchangeRootOverride?: string;
}
function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}
// The connector token travels with every request, so it must never go over plain HTTP.
// Plain HTTP is only allowed to this computer itself (local test fixtures).
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
export function assertSecureEndpoint(value: string, field: string): void {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${field} must be a valid URL`); }
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && LOCAL_HOSTS.has(parsed.hostname)) return;
  throw new Error(`${field} must use HTTPS so the connector token stays encrypted in transit`);
}
function endpoint(value: unknown, field: string): string {
  const text = requiredString(value, field);
  assertSecureEndpoint(text, field);
  return new URL(text).toString();
}
// Hosts of the official Knox Relay backend. Setup text pointing elsewhere needs explicit confirmation,
// because the connector token would be sent to that server.
export const KNOX_BACKEND_HOSTS = new Set(["europe-west1-wildshape-tracker.cloudfunctions.net"]);
export function unknownEndpointHosts(connection: ImportedConnection): string[] {
  const hosts = [connection.telemetryEndpoint, connection.missionSyncEndpoint, connection.syncEndpoint]
    .filter((value): value is string => typeof value === "string")
    .map((value) => new URL(value).hostname);
  return [...new Set(hosts.filter((host) => !KNOX_BACKEND_HOSTS.has(host) && !LOCAL_HOSTS.has(host)))];
}
export function parseConnectionImport(input: string | Record<string, unknown>): ImportedConnection {
  let raw: Record<string, unknown>;
  try { raw = typeof input === "string" ? JSON.parse(input) as Record<string, unknown> : input; }
  catch { throw new Error("Setup JSON is malformed"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Setup JSON must be an object");
  return {
    ...(typeof raw.name === "string" && raw.name.trim() ? { name: raw.name.trim() } : {}),
    networkId: requiredString(raw.networkId, "networkId"), connectorToken: requiredString(raw.connectorToken, "connectorToken"),
    telemetryEndpoint: endpoint(raw.telemetryEndpoint, "telemetryEndpoint"), missionSyncEndpoint: endpoint(raw.missionSyncEndpoint, "missionSyncEndpoint"),
    ...(raw.syncEndpoint ? { syncEndpoint: endpoint(raw.syncEndpoint, "syncEndpoint") } : {}),
    ...((raw.exchangeRoot ?? raw.exchangeDirectory) ? { exchangeRootOverride: requiredString(raw.exchangeRoot ?? raw.exchangeDirectory, "exchangeRoot") } : {}),
  };
}
