// src/desktop/ZipGuard.ts
// v1 - 27-09-2026 - Bounded pre-check of update ZIPs before the launcher unpacks them

// The launcher (desktop/updater-core.cjs) unpacks an update before checking its signature. Launchers
// built before 0.2.3 do that without size limits, so this updatable guard inflates every entry with
// hard caps first. A file that passes here cannot exhaust memory or disk in the launcher either,
// because the launcher inflates exactly the same bytes.

import { readFile, stat } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

export const ZIP_LIMITS = { maxZipBytes: 30 * 1024 * 1024, maxEntries: 500, maxTotalBytes: 60 * 1024 * 1024 };

function safeName(name: string): boolean {
  const normalised = name.replace(/\\/g, "/");
  if (normalised === "" || normalised.startsWith("/") || /^[a-zA-Z]:/.test(normalised)) return false;
  return !normalised.split("/").some((part) => part === "..");
}

// Throws a readable error when the ZIP is not a plausible, bounded update package.
export function checkZipBuffer(buffer: Buffer, limits = ZIP_LIMITS): void {
  if (buffer.length > limits.maxZipBytes) throw new Error(`update file is larger than ${limits.maxZipBytes} bytes`);
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw new Error("not a ZIP file");
  const count = buffer.readUInt16LE(end + 10);
  if (count > limits.maxEntries) throw new Error(`update has more than ${limits.maxEntries} files`);
  let pointer = buffer.readUInt32LE(end + 16);
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error("corrupt ZIP directory");
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString("utf8", pointer + 46, pointer + 46 + nameLength);
    pointer += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (!safeName(name)) throw new Error(`unsafe path in update: ${name}`);
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("corrupt ZIP entry");
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > buffer.length) throw new Error("corrupt ZIP entry size");
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const remaining = limits.maxTotalBytes - total;
    let size: number;
    if (method === 0) size = raw.length;
    else if (method === 8) {
      try { size = inflateRawSync(raw, { maxOutputLength: remaining + 1 }).length; }
      catch { throw new Error("update unpacks to more than the allowed size or is corrupt"); }
    } else throw new Error(`unsupported ZIP compression ${method}`);
    total += size;
    if (total > limits.maxTotalBytes) throw new Error("update unpacks to more than the allowed size");
  }
}

export async function checkZipFile(file: string, limits = ZIP_LIMITS): Promise<void> {
  // Size first, so a huge file picked by hand is never read into memory.
  if ((await stat(file)).size > limits.maxZipBytes) throw new Error(`update file is larger than ${limits.maxZipBytes} bytes`);
  checkZipBuffer(await readFile(file), limits);
}
