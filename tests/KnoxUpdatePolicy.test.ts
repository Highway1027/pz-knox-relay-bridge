// tests/KnoxUpdatePolicy.test.ts

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { gameRunning, shouldRestart } from "../src/desktop/UpdatePolicy.js";

test("a game runs in every director state but idle, no game folder and stopped", () => {
  assert.equal(gameRunning([]), false);
  assert.equal(gameRunning(["idle", "no_game_folder", "stopped"]), false);
  for (const state of ["active", "unlinked", "no_connection", "error"]) assert.equal(gameRunning(["idle", state]), true, state);
});

test("no waiting update never restarts", () => {
  for (const trigger of ["open", "interval", "game-closed", "force"] as const) {
    assert.equal(shouldRestart({ trigger, gameRunning: false, afterUpdateRestart: false }), false, trigger);
  }
});

test("the first open restarts into an update even while a game runs", () => {
  assert.equal(shouldRestart({ trigger: "open", pendingVersion: "0.3.7", gameRunning: true, afterUpdateRestart: false }), true);
});

test("after a restart made by an update, the open check waits for no game (no restart loop)", () => {
  assert.equal(shouldRestart({ trigger: "open", pendingVersion: "0.3.7", gameRunning: true, afterUpdateRestart: true }), false);
  assert.equal(shouldRestart({ trigger: "open", pendingVersion: "0.3.7", gameRunning: false, afterUpdateRestart: true }), true);
});

test("later checks and a closed game restart only while no game runs", () => {
  for (const trigger of ["interval", "game-closed"] as const) {
    assert.equal(shouldRestart({ trigger, pendingVersion: "0.3.7", gameRunning: true, afterUpdateRestart: false }), false, trigger);
    assert.equal(shouldRestart({ trigger, pendingVersion: "0.3.7", gameRunning: false, afterUpdateRestart: false }), true, trigger);
  }
});

test("Force update restarts at once, also during a game", () => {
  assert.equal(shouldRestart({ trigger: "force", pendingVersion: "0.3.7", gameRunning: true, afterUpdateRestart: true }), true);
});

test("main wires the triggers: open, interval, game closed, Force update and the after-update flag", async () => {
  const main = await readFile(path.resolve("src", "desktop", "main.ts"), "utf8");
  assert.match(main, /automaticCheck\("open"\)/);
  assert.match(main, /automaticCheck\("interval"\)/);
  assert.match(main, /automaticCheck\("game-closed"\)/);
  assert.match(main, /checkForUpdate\("force"\)/);
  assert.match(main, /AFTER_UPDATE_ARG/);
  const html = await readFile(path.resolve("desktop", "renderer", "index.html"), "utf8");
  assert.match(html, /id="force-update"/);
  const preload = await readFile(path.resolve("desktop", "preload.cjs"), "utf8");
  assert.match(preload, /forceUpdate: \(\) => ipcRenderer\.invoke\("update:force"\)/);
});
