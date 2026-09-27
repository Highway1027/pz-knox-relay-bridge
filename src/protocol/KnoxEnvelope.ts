// src/protocol/KnoxEnvelope.ts
// v1 - 27-09-2026 - Bounded envelope checks for open content (snapshot, knox_ missions)

// The Bridge is transport only. For open content it checks the envelope (shape, ids, size, depth)
// and leaves the meaning to the backend and the Connector, which validate every field they use.

export interface JsonLimits {
  maxBytes: number;
  maxDepth: number;
  maxStringLength: number;
  maxArrayLength: number;
  maxObjectKeys: number;
}

export const SNAPSHOT_LIMITS: JsonLimits = { maxBytes: 64 * 1024, maxDepth: 8, maxStringLength: 1000, maxArrayLength: 256, maxObjectKeys: 256 };
export const ENVELOPE_MISSION_LIMITS: JsonLimits = { maxBytes: 32 * 1024, maxDepth: 10, maxStringLength: 4000, maxArrayLength: 64, maxObjectKeys: 64 };

export const ENVELOPE_MISSION_ID = /^knox_[a-z0-9_]{1,96}$/;
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

// Plain JSON data only (no functions, no special objects), within the limits. Throws on the first problem.
export function assertBoundedJson(value: unknown, limits: JsonLimits, label: string): void {
  const visit = (node: unknown, depth: number): void => {
    if (depth > limits.maxDepth) throw new Error(`${label} is nested too deeply`);
    if (node === null || typeof node === "boolean") return;
    if (typeof node === "number") {
      if (!Number.isFinite(node)) throw new Error(`${label} contains a non-finite number`);
      return;
    }
    if (typeof node === "string") {
      if (node.length > limits.maxStringLength) throw new Error(`${label} contains a string that is too long`);
      return;
    }
    if (Array.isArray(node)) {
      if (node.length > limits.maxArrayLength) throw new Error(`${label} contains a list that is too long`);
      for (const entry of node) visit(entry, depth + 1);
      return;
    }
    if (isPlainObject(node)) {
      const keys = Object.keys(node);
      if (keys.length > limits.maxObjectKeys) throw new Error(`${label} contains an object with too many keys`);
      for (const key of keys) {
        if (!KEY_PATTERN.test(key)) throw new Error(`${label} contains an invalid key`);
        visit(node[key], depth + 1);
      }
      return;
    }
    throw new Error(`${label} contains a value that is not JSON data`);
  };
  visit(value, 1);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > limits.maxBytes) throw new Error(`${label} is too large`);
}

// The world/player snapshot that rides along with telemetry (Connector 0.13.0+).
export function validateSnapshot(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error("snapshot must be an object");
  if (!Number.isInteger(value.schemaVersion) || Number(value.schemaVersion) < 1 || Number(value.schemaVersion) > 1000) throw new Error("invalid snapshot schemaVersion");
  assertBoundedJson(value, SNAPSHOT_LIMITS, "snapshot");
  return value;
}

// Open missions from the mission engine (ids knox_...). Envelope only; content is the Connector's job.
export function validateEnvelopeMission(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error("mission must be an object");
  if (value.protocolVersion !== 1) throw new Error("unsupported mission protocolVersion");
  if (typeof value.missionId !== "string" || !ENVELOPE_MISSION_ID.test(value.missionId)) throw new Error("invalid mission ID");
  if (!Number.isInteger(value.missionVersion) || Number(value.missionVersion) < 1 || Number(value.missionVersion) > 100000) throw new Error("invalid missionVersion");
  if (typeof value.title !== "string" || value.title.length < 1 || value.title.length > 120) throw new Error("invalid mission title");
  assertBoundedJson(value, ENVELOPE_MISSION_LIMITS, "mission");
  return value;
}
