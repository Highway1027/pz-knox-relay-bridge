// src/desktop/main.ts
// v7 - 27-09-2026 - Security: unknown-backend confirmation, ZIP guard for manual installs, navigation guards

import { app, BrowserWindow, dialog, ipcMain, safeStorage, screen } from "electron";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { ConnectionStore, type SecretVault } from "./ConnectionStore.js";
import { parseConnectionImport, unknownEndpointHosts } from "./ConnectionTypes.js";
import { checkZipFile } from "./ZipGuard.js";
import { BridgeRuntimeManager } from "./BridgeRuntimeManager.js";
import { DEFAULT_CONFIG, automaticPzDirectory, resolveExchangeDirectory } from "../config/KnoxBridgeConfig.js";
import { BridgeDirector, type DirectorStatus } from "./BridgeDirector.js";
import { stat } from "node:fs/promises";
import { AutoUpdater, type CheckResult } from "./AutoUpdater.js";
import { AFTER_UPDATE_ARG, gameRunning, shouldRestart, type UpdateTrigger } from "./UpdatePolicy.js";
import { MIN_CONTENT_HEIGHT, fittedContentHeight, keptOnScreen } from "./WindowFit.js";

// Set by desktop/launcher.cjs. Absent when main.js is started directly (npm run desktop without the launcher).
type Launcher = { apiVersion: number; codeRoot: string; version: string; source: "built-in" | "update"; builtInVersion: string; notes: string[];
  markHealthy(): void; installUpdate(file: string): { ok: boolean; version?: string; reason?: string }; revertToBuiltIn(): void };
const launcher = (globalThis as { knoxLauncher?: Launcher }).knoxLauncher;
// The UI (preload + renderer) comes from the same code root as this file, so updates can change it too.
const codeRoot = launcher?.codeRoot ?? app.getAppPath();
let window: BrowserWindow | undefined;
// Bridge 0.3.2: the window fits the page it shows (WindowFit) until the player resizes it by hand.
let resizedByHand = false;
function fitWindow(wanted: number): boolean {
  const target = window;
  if (!target || target.isDestroyed() || resizedByHand || target.isMaximized() || target.isFullScreen() || typeof wanted !== "number") return false;
  const area = screen.getDisplayMatching(target.getBounds()).workArea;
  const [width, current] = target.getContentSize() as [number, number];
  const height = fittedContentHeight(wanted, area, target.getBounds().height - current);
  if (height === current) return false;
  target.setContentSize(width, height);
  const place = keptOnScreen(target.getBounds(), area);
  target.setPosition(place.x, place.y);
  return true;
}
const UPDATE_FIRST_CHECK_MS = 3000;
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let updater: AutoUpdater | undefined; let lastUpdate: (CheckResult & { checkedAt: string }) | undefined;
// Local preferences of this installation (not synced anywhere).
function settingsPath(): string { return path.join(app.getPath("userData"), "bridge-settings.json"); }
async function readSettings(): Promise<{ autoUpdate: boolean }> {
  try { const value = JSON.parse(await readFile(settingsPath(), "utf8")) as { autoUpdate?: unknown }; return { autoUpdate: value.autoUpdate !== false }; }
  catch { return { autoUpdate: true }; }
}
// Bridge 0.3.6: an update installed this session waits here until UpdatePolicy allows the restart.
let pendingVersion: string | undefined; let gameWasRunning = false; let restarting = false;
const afterUpdateRestart = process.argv.includes(AFTER_UPDATE_ARG);
async function checkForUpdate(trigger: UpdateTrigger = "interval"): Promise<CheckResult | undefined> {
  if (!updater) return undefined;
  const result = await updater.check();
  if (result.status === "installed") pendingVersion = result.version;
  lastUpdate = { ...result, checkedAt: new Date().toISOString() };
  const target = window;
  if (target && !target.isDestroyed() && !target.webContents.isDestroyed()) target.webContents.send("update:status", lastUpdate);
  if (shouldRestart({ trigger, pendingVersion, gameRunning: gameRunning(bridgeStatuses().map((status) => status.state)), afterUpdateRestart })) {
    console.log(`[Knox Relay Bridge] Restarting into update ${pendingVersion} (${trigger}).`);
    await restartApp(true);
  }
  return result;
}
async function automaticCheck(trigger: UpdateTrigger): Promise<void> { if (updater && (await readSettings()).autoUpdate) await checkForUpdate(trigger); }
// A game that just closed checks for an update (and restarts into a waiting one).
function noteGameState(): void {
  const running = gameRunning(bridgeStatuses().map((status) => status.state));
  if (gameWasRunning && !running) void automaticCheck("game-closed").catch((error) => console.error(error));
  gameWasRunning = running;
}
// afterUpdate marks the new process, so its open check does not restart again (UpdatePolicy).
async function restartApp(afterUpdate: boolean): Promise<void> {
  if (restarting) return;
  restarting = true;
  await stopDirectors(); shuttingDown = true; runtime?.stopAll();
  const args = process.argv.slice(1).filter((item) => item !== AFTER_UPDATE_ARG);
  app.relaunch({ args: afterUpdate ? [...args, AFTER_UPDATE_ARG] : args });
  app.quit();
}
async function scheduleUpdates(): Promise<void> {
  if (!launcher || process.env.KNOX_SMOKE_REPORT || process.env.KNOX_DISABLE_AUTO_UPDATE) return;
  const active = launcher;
  updater = new AutoUpdater({
    currentVersion: () => active.version,
    install: (file) => active.installUpdate(file),
    downloadDir: path.join(app.getPath("userData"), "app-code", "downloads"),
    feedUrl: process.env.KNOX_UPDATE_FEED_URL,
    log: (message) => console.log(`[Knox Relay Bridge] ${message}`),
  });
  setTimeout(() => { void automaticCheck("open"); }, UPDATE_FIRST_CHECK_MS);
  setInterval(() => { void automaticCheck("interval"); }, UPDATE_INTERVAL_MS);
} let store: ConnectionStore; let runtime: BridgeRuntimeManager; let shuttingDown = false; let smokeInProgress = false;
// Bridge 0.3.0: the Bridge follows the game (BridgeDirector), one director per exchange folder. Log lines of the
// directors go to the Debug tab under BRIDGE_LOG_ID.
const BRIDGE_LOG_ID = "bridge";
const DIRECTOR_REFRESH_MS = 5000;
const directors = new Map<string, BridgeDirector>(); let directorTimer: NodeJS.Timeout | undefined; let directorsStopped: Promise<void> | undefined;
function sendToWindow(channel: string, ...args: unknown[]): void {
  const target = window;
  if (shuttingDown || !target || target.isDestroyed() || target.webContents.isDestroyed()) return;
  try { target.webContents.send(channel, ...args); } catch (error) { console.error("Renderer delivery failed safely:", error instanceof Error ? error.message : String(error)); }
}
function exchangeOf(override?: string): { directory: string; automatic: boolean } {
  const exchange = resolveExchangeDirectory(override ? { exchangeRoot: override } : {});
  return { directory: exchange.directory, automatic: exchange.source === "automatic" };
}
async function isDirectory(directory: string): Promise<boolean> { try { return (await stat(directory)).isDirectory(); } catch { return false; } }
// The automatic folder always gets a director (the game sees a Bridge even before a connection is added); a custom
// exchange root gets one while a connection uses it.
async function refreshDirectors(): Promise<void> {
  if (shuttingDown) return;
  const wanted = new Map<string, boolean>([[exchangeOf().directory, true]]);
  for (const connection of await store.list()) { const exchange = exchangeOf(connection.exchangeRootOverride); if (!wanted.has(exchange.directory)) wanted.set(exchange.directory, exchange.automatic); }
  for (const [directory, automatic] of wanted) {
    if (directors.has(directory)) continue;
    const director = new BridgeDirector({
      exchangeDirectory: directory, runner: runtime, bridgeVersion: launcher?.version ?? app.getVersion(),
      connections: async () => (await store.list()).filter((connection) => exchangeOf(connection.exchangeRootOverride).directory === directory),
      ready: async () => !automatic || isDirectory(automaticPzDirectory()),
      log: (level, message) => sendToWindow("runtime:log", BRIDGE_LOG_ID, { timestamp: new Date().toISOString(), level, message }),
      onChange: () => { sendToWindow("bridge:status", bridgeStatuses()); noteGameState(); },
    });
    directors.set(directory, director); director.start();
  }
  for (const [directory, director] of directors) if (!wanted.has(directory)) { directors.delete(directory); void director.stop(); }
}
function bridgeStatuses(): DirectorStatus[] { return [...directors.values()].map((director) => director.current()); }
function stopDirectors(): Promise<void> {
  if (directorTimer) clearInterval(directorTimer);
  directorsStopped ??= Promise.all([...directors.values()].map((director) => director.stop().catch(() => undefined))).then(() => undefined);
  return directorsStopped;
}
const legacyPath = path.resolve("config.json");
if (process.env.KNOX_SMOKE_USER_DATA) app.setPath("userData", process.env.KNOX_SMOKE_USER_DATA);
const vault: SecretVault = {
  async encrypt(value) { if (!safeStorage.isEncryptionAvailable()) throw new Error("OS secure storage is unavailable; the token was not saved"); return safeStorage.encryptString(value).toString("base64"); },
  async decrypt(value) { if (!safeStorage.isEncryptionAvailable()) throw new Error("OS secure storage is unavailable; the token cannot be read"); return safeStorage.decryptString(Buffer.from(value, "base64")); },
};
async function connection(id: string) { const found = (await store.list()).find((item) => item.id === id); if (!found) throw new Error("Connection not found"); return found; }
async function legacy(): Promise<Record<string, unknown> | undefined> { try { return JSON.parse(await readFile(legacyPath, "utf8")) as Record<string, unknown>; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }

function registerIpc(): void {
  ipcMain.handle("connections:list", () => store.list());
  ipcMain.handle("connections:add", async (_event, json: string, name: string, allowUnknownHosts?: boolean) => {
    const imported = parseConnectionImport(json);
    const unknown = unknownEndpointHosts(imported);
    // Setup text normally comes from the Knox Relay webapp; any other server would receive the token.
    if (unknown.length > 0 && allowUnknownHosts !== true) {
      throw new Error(`UNKNOWN_HOST: This setup text sends your connector token to ${unknown.join(", ")}, not to the Knox Relay backend. Only continue if you trust whoever gave it to you.`);
    }
    return store.add(imported, name);
  });
  ipcMain.handle("connections:update", (_event, id: string, changes, token?: string) => store.update(id, changes, token));
  // A running connection is stopped by its director on the next tick, after the call in flight.
  ipcMain.handle("connections:remove", async (_event, id: string) => { await store.remove(id); });
  ipcMain.handle("connections:changed", async () => { await refreshDirectors(); return bridgeStatuses(); });
  ipcMain.handle("bridge:status", () => bridgeStatuses());
  ipcMain.handle("window:fit", (_event, height: number) => fitWindow(height));
  ipcMain.handle("runtime:status", async (_event, id: string) => runtime.describe(await connection(id)));
  ipcMain.handle("runtime:doctor", async (_event, id: string) => runtime.doctor(await connection(id)));
  ipcMain.handle("legacy:read", async () => Boolean(await legacy()));
  ipcMain.handle("app:info", () => ({ version: launcher?.version ?? app.getVersion(), source: launcher?.source ?? "built-in",
    builtInVersion: launcher?.builtInVersion ?? app.getVersion(), updatesSupported: Boolean(launcher), notes: launcher?.notes ?? [] }));
  ipcMain.handle("update:install", async () => {
    if (!launcher) return { ok: false, reason: "This build has no update launcher; rebuild the Bridge once." };
    const picked = window ? await dialog.showOpenDialog(window, { title: "Install Knox Relay Bridge update", properties: ["openFile"], filters: [{ name: "Bridge update", extensions: ["zip"] }] }) : undefined;
    if (!picked || picked.canceled || picked.filePaths.length === 0) return { ok: false, cancelled: true };
    const file = picked.filePaths[0] as string;
    // Bounded check before the launcher unpacks it (older launchers have no size limits).
    try { await checkZipFile(file); } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
    return launcher.installUpdate(file);
  });
  ipcMain.handle("update:auto:get", async () => (await readSettings()).autoUpdate);
  ipcMain.handle("update:auto:set", async (_event, enabled: boolean) => { await writeFile(settingsPath(), `${JSON.stringify({ autoUpdate: enabled === true }, null, 2)}\n`, "utf8"); return enabled === true; });
  ipcMain.handle("update:check", async () => (await checkForUpdate()) ?? { status: "error", reason: "Automatic updates need the update launcher; rebuild the Bridge once." });
  // Bridge 0.3.6: Settings > Force update: newest version now, restart at once even during a game (hotfix).
  ipcMain.handle("update:force", async () => (await checkForUpdate("force")) ?? { status: "error", reason: "Updates need the update launcher; rebuild the Bridge once." });
  ipcMain.handle("update:last", () => lastUpdate ?? null);
  ipcMain.handle("update:revert", () => { launcher?.revertToBuiltIn(); return { ok: true }; });
  // A restart by hand opens like a fresh start: its open check may restart once more into a new update.
  ipcMain.handle("app:restart", () => restartApp(false));
  ipcMain.handle("legacy:import", async (_event, name: string) => { const raw = await legacy(); if (!raw) throw new Error("Legacy config.json was not found"); return store.add(parseConnectionImport({ telemetryEndpoint: DEFAULT_CONFIG.telemetryEndpoint, missionSyncEndpoint: DEFAULT_CONFIG.missionSyncEndpoint, ...raw }), name); });
}
async function createWindow(): Promise<void> {
  window = new BrowserWindow({ width: 640, height: 360, minWidth: 520, minHeight: MIN_CONTENT_HEIGHT, useContentSize: true, backgroundColor: "#101418", webPreferences: { preload: path.join(codeRoot, "desktop", "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  // The window only ever shows the Bridge's own pages: no new windows, no navigating away.
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => { event.preventDefault(); });
  window.webContents.on("will-attach-webview", (event) => { event.preventDefault(); });
  window.on("close", () => { void stopDirectors(); shuttingDown = true; });
  window.on("closed", () => { window = undefined; });
  // Only a resize by the player fires this (setContentSize does not).
  window.on("will-resize", () => { resizedByHand = true; });
  await window.loadFile(path.join(codeRoot, "desktop", "renderer", "index.html"));
  // The window loaded from this code: tell the launcher this version starts correctly.
  launcher?.markHealthy();
  const smokeArgument = process.argv.find((item) => item.startsWith("--smoke-test="));
  const smokeReport = process.env.KNOX_SMOKE_REPORT ?? smokeArgument?.slice("--smoke-test=".length);
  if (smokeReport) await runSmokeTest(window, smokeReport);
}

async function runSmokeTest(target: BrowserWindow, reportPath: string): Promise<void> {
  smokeInProgress = true;
  try {
    const exchangeRoot = app.getPath("userData");
    const result = await target.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const until = async (test) => { for (let i = 0; i < 80; i += 1) { if (test()) return; await wait(50); } throw new Error("UI smoke timeout"); };
      const methods = ["list","add","update","remove","connectionsChanged","bridgeStatus","onBridgeStatus","status","doctor","legacy","importLegacy","onLog"];
      if (!window.knox || !methods.every((name) => typeof window.knox[name] === "function")) throw new Error("preload API contract incomplete");
      document.getElementById("add-button").click();
      if (!document.getElementById("add-dialog").open) throw new Error("Add Connection did not open");
      document.getElementById("setup-json").value = JSON.stringify({ telemetryEndpoint:"https://example.test/telemetry", missionSyncEndpoint:"https://example.test/missions", networkId:"smoke-network", connectorToken:"smoke-token" });
      document.getElementById("connection-name").value = "Smoke Test";
      document.getElementById("save-connection").click(); await wait(300); if (document.getElementById("save-connection").textContent === "Save anyway") document.getElementById("save-connection").click();
      await until(() => document.querySelector("[data-open]"));
      document.querySelector('[data-view="debug"]').click(); if (!document.getElementById("debug").classList.contains("active")) throw new Error("Debug navigation failed");
      document.querySelector('[data-view="settings"]').click(); if (!document.getElementById("settings").classList.contains("active")) throw new Error("Settings navigation failed");
      document.querySelector('[data-view="overview"]').click(); if (!document.getElementById("overview").classList.contains("active")) throw new Error("Overview navigation failed");
      document.querySelector("[data-open]").click();
      await until(() => document.getElementById("run-doctor")); document.getElementById("run-doctor").click();
      await until(() => document.getElementById("doctor-output").textContent.includes("Knox Relay Bridge Doctor"));
      if (document.getElementById("detail-toggle") || document.querySelector("[data-start]")) throw new Error("Start/Stop is gone in 0.3.0");
      document.getElementById("open-debug").click();
      if (![...document.getElementById("debug-connection").options].some((option) => option.value === "bridge")) throw new Error("Bridge log missing in Debug");
      document.querySelector('[data-view="overview"]').click();
      if (!document.getElementById("game-status")) throw new Error("Game status line missing");
      const statuses = await window.knox.bridgeStatus(); if (!Array.isArray(statuses)) throw new Error("bridgeStatus is not a list");
      return { ok:true, api:methods, addConnection:true, overview:true, debug:true, settings:true, doctor:true, gameStatus:true, bridgeLog:true, fatalVisible:Boolean(document.querySelector(".fatal")) };
    })()`);
    await new Promise<void>((resolve) => { target.once("closed", resolve); target.close(); });
    await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  } catch (error) {
    await writeFile(reportPath, `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`, "utf8");
    process.exitCode = 1;
  } finally { smokeInProgress = false; app.quit(); }
}
app.whenReady().then(async () => {
  store = new ConnectionStore(app.getPath("userData"), vault);
  runtime = new BridgeRuntimeManager(store, (id, event) => sendToWindow("runtime:log", id, event));
  registerIpc(); await createWindow(); await scheduleUpdates();
  if (!process.env.KNOX_SMOKE_REPORT && !process.argv.some((item) => item.startsWith("--smoke-test="))) {
    await refreshDirectors(); directorTimer = setInterval(() => { void refreshDirectors().catch((error) => console.error(error)); }, DIRECTOR_REFRESH_MS);
  }
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
}).catch((error) => { console.error(error); app.quit(); });
app.on("window-all-closed", () => { if (!smokeInProgress) app.quit(); });
// Quit waits (at most 3 s) for the directors: the running call finishes and the game reads "stopped" at once.
let quitReady = false;
app.on("before-quit", (event) => {
  if (quitReady) { shuttingDown = true; runtime?.stopAll(); return; }
  event.preventDefault();
  void Promise.race([stopDirectors(), new Promise((resolve) => setTimeout(resolve, 3000))]).finally(() => { quitReady = true; shuttingDown = true; runtime?.stopAll(); app.quit(); });
});
