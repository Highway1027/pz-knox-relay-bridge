// scripts/package-update.mjs
// v1 - 27-09-2026 - Build a signed drop-in update ZIP: release/Knox Relay Bridge Update <version>.zip

// Contains the updatable code only (dist/src, desktop/preload.cjs, desktop/renderer, a minimal
// package.json), a manifest with the SHA-256 of every file, and the manifest's Ed25519 signature.
// The launcher files (desktop/launcher.cjs, updater-core.cjs, update-public-key.pem) are never
// part of an update: changing them needs one app rebuild.
// Run `npm run build` first (npm run update:package does).

import { createRequire } from "node:module";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import yazl from "yazl";

const require = createRequire(import.meta.url);
const core = require("../desktop/updater-core.cjs");

const LAUNCHER_ONLY = new Set(["desktop/launcher.cjs", "desktop/updater-core.cjs", "desktop/update-public-key.pem"]);
const privateKeyPath = process.env.KNOX_UPDATE_PRIVATE_KEY ?? path.join(homedir(), ".knox-relay", "bridge-update-private.pem");
if (!existsSync(privateKeyPath)) {
  console.error(`No signing key at ${privateKeyPath}. Run "npm run update:keygen" once first.`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;
const files = {};
const contents = new Map();

function add(relative, buffer) {
  files[relative] = core.sha256(buffer);
  contents.set(relative, buffer);
}

function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    const relative = full.split(path.sep).join("/");
    if (entry.isDirectory()) collect(full);
    else if (!LAUNCHER_ONLY.has(relative)) add(relative, readFileSync(full));
  }
}

if (!existsSync(path.join("dist", "src", "desktop", "main.js"))) {
  console.error("dist/src/desktop/main.js is missing; run npm run build first.");
  process.exit(1);
}
collect(path.join("dist", "src"));
collect("desktop");
// Makes Node treat the update's .js files as ES modules, like the app's own package.json does.
add("package.json", Buffer.from(`${JSON.stringify({ name: pkg.name, version, type: "module" }, null, 2)}\n`));

const manifest = {
  format: core.MANIFEST_FORMAT, product: core.PRODUCT, version, minLauncher: core.LAUNCHER_API_VERSION,
  createdAt: new Date().toISOString(), files,
};
const signature = core.signManifest(manifest, readFileSync(privateKeyPath, "utf8"));

// Self-check with the public key that ships in the app, before anything is written.
const publicKeyPem = readFileSync(path.join("desktop", "update-public-key.pem"), "utf8");
const { verify } = await import("node:crypto");
if (!verify(null, Buffer.from(core.canonicalJson(manifest)), publicKeyPem, Buffer.from(signature, "base64"))) {
  console.error("The signing key does not match desktop/update-public-key.pem. Updates would be rejected.");
  process.exit(1);
}

mkdirSync("release", { recursive: true });
const output = path.join("release", `Knox Relay Bridge Update ${version}.zip`);
const zip = new yazl.ZipFile();
for (const [relative, buffer] of contents) zip.addBuffer(buffer, relative);
zip.addBuffer(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), "manifest.json");
zip.addBuffer(Buffer.from(`${signature}\n`), "manifest.sig");
zip.end();
await new Promise((resolve, reject) => zip.outputStream.pipe(createWriteStream(output)).on("close", resolve).on("error", reject));
console.log(`Created ${output}: version ${version}, ${Object.keys(files).length} files, ${statSync(output).size} bytes, signed.`);
