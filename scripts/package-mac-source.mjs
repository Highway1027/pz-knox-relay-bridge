// scripts/package-mac-source.mjs
// v1 - 26-09-2026 - Produce a secret-free source ZIP with Unix executable metadata

import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'release', 'Knox Relay Bridge Source.zip');
const helper = 'BUILD KNOX RELAY BRIDGE.command';
const files = ['package.json', 'package-lock.json', 'tsconfig.json', helper, 'MAC START HERE.txt'];
async function collect(directory) {
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), `Refusing source symlink: ${entry.name}`);
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await collect(relative);
    else files.push(relative);
  }
}
for (const directory of ['src', 'desktop', 'tests']) await collect(directory);
await mkdir(path.dirname(output), { recursive: true });
const zip = new yazl.ZipFile();
const finished = pipeline(zip.outputStream, createWriteStream(output));
for (const file of files) {
  let bytes = await readFile(path.join(root, file));
  if (file === helper) bytes = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'));
  zip.addBuffer(bytes, `Knox Relay Bridge/${file}`, { mode: file === helper ? 0o100755 : 0o100644 });
}
zip.end();
await finished;

// Inspect the actual central directory, not just the options passed to the writer.
const bytes = await readFile(output);
const eocd = bytes.length - 22;
assert.equal(bytes.readUInt32LE(eocd), 0x06054b50);
const count = bytes.readUInt16LE(eocd + 10);
let offset = bytes.readUInt32LE(eocd + 16);
const names = [];
let executableVerified = false;
for (let index = 0; index < count; index++) {
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
  const nameLength = bytes.readUInt16LE(offset + 28);
  const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
  names.push(name);
  if (name.endsWith(`/${helper}`)) {
    assert.equal(bytes[offset + 5], 3, 'ZIP creator must be Unix');
    assert.equal(bytes.readUInt32LE(offset + 38) >>> 16, 0o100755, 'Mac helper must retain executable mode');
    executableVerified = true;
  }
  offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
}
assert.ok(executableVerified);
assert.equal(names.length, files.length);
assert.ok(!names.some(name => /\/(node_modules|release|temp|\.git)\/|\/(config|secrets|connections)\.json$|\/\.env/.test(name)));
assert.ok(names.includes('Knox Relay Bridge/desktop/preload.cjs'));
console.log(`Created: ${output}\nVerified ${count} files, Unix 0755 helper, CommonJS preload, and no local credentials/dependencies/build output.`);
