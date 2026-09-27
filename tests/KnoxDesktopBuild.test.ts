// tests/KnoxDesktopBuild.test.ts
// v2 - 27-09-2026 - Preload path comes from the launcher-selected code root

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const expectedMethods = ["list", "add", "update", "remove", "start", "stop", "status", "doctor", "legacy", "importLegacy", "onLog"];

test("desktop preload is CommonJS, exists, and exposes the renderer API contract", async () => {
  const preloadPath = path.resolve("desktop", "preload.cjs");
  await access(preloadPath);
  const preload = await readFile(preloadPath, "utf8");
  assert.doesNotMatch(preload, /^\s*import\s/m);
  assert.match(preload, /require\("electron"\)/);
  assert.match(preload, /exposeInMainWorld\("knox"/);
  for (const method of expectedMethods) assert.match(preload, new RegExp(`\\b${method}:`));
});

test("BrowserWindow points at packaged CommonJS preload with isolation and sandbox enabled", async () => {
  const main = await readFile(path.resolve("src", "desktop", "main.ts"), "utf8");
  // The preload comes from the launcher-selected code root (built-in or installed update).
  assert.match(main, /path\.join\(codeRoot, "desktop", "preload\.cjs"\)/);
  assert.match(main, /const codeRoot = launcher\?\.codeRoot \?\? app\.getAppPath\(\)/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /nodeIntegration: false/);
  const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as { build: { files: string[] } };
  assert.ok(packageJson.build.files.includes("desktop/**/*"));
});

test("renderer shows a fatal initialization state when preload API is missing", async () => {
  const renderer = await readFile(path.resolve("desktop", "renderer", "renderer.js"), "utf8");
  assert.match(renderer, /if \(!window\.knox\)/);
  assert.match(renderer, /failed to initialize/);
  assert.match(renderer, /desktop bridge API could not be loaded/);
});

test("main process guards renderer log delivery during idempotent shutdown", async () => {
  const main = await readFile(path.resolve("src", "desktop", "main.ts"), "utf8");
  assert.match(main, /target\.isDestroyed\(\)/); assert.match(main, /target\.webContents\.isDestroyed\(\)/);
  assert.match(main, /window\.on\("close".*runtime\?\.stopAll\(\)/s);
});

test("renderer presents startup transitions and retained errors", async () => {
  const renderer = await readFile(path.resolve("desktop", "renderer", "renderer.js"), "utf8");
  assert.match(renderer, /Starting…/); assert.match(renderer, /Stopping…/); assert.match(renderer, /runtime\.lastError/); assert.match(renderer, /Cannot start/);
});
