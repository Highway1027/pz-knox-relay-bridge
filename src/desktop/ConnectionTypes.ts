// src/desktop/ConnectionTypes.ts
// v1 - 26-09-2026 - Define desktop connection import and persistence contracts

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
function endpoint(value: unknown, field: string): string {
  const text = requiredString(value, field);
  let parsed: URL;
  try { parsed = new URL(text); } catch { throw new Error(`${field} must be a valid URL`); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`${field} must use HTTP or HTTPS`);
  return parsed.toString();
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
