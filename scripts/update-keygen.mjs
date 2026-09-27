// scripts/update-keygen.mjs
// v1 - 27-09-2026 - Create the Ed25519 key pair that signs Bridge drop-in updates (run once)

// The private key stays on the publisher's PC, outside the repository. The public key is
// written to desktop/update-public-key.pem and is built into the app's launcher: only ZIPs
// signed with the matching private key can be installed. Losing the private key means every
// user must rebuild the Bridge once with a new public key, so back it up.

import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const privateKeyPath = process.env.KNOX_UPDATE_PRIVATE_KEY ?? path.join(homedir(), ".knox-relay", "bridge-update-private.pem");
const publicKeyPath = path.resolve("desktop", "update-public-key.pem");

if (existsSync(privateKeyPath) && !process.argv.includes("--force")) {
  console.error(`A private key already exists at ${privateKeyPath}. Keep using it; pass --force only to replace it (every user must then rebuild once).`);
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
mkdirSync(path.dirname(privateKeyPath), { recursive: true });
writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
writeFileSync(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }));
console.log(`Private key (keep safe, back it up, never share): ${privateKeyPath}`);
console.log(`Public key (commit, ships in the app):             ${publicKeyPath}`);
