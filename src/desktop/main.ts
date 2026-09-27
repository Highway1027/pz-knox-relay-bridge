// src/desktop/main.ts
// v4 - 27-09-2026 - Load UI from the launcher-selected code root; Settings update install and restart

import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { ConnectionStore, type SecretVault } from "./ConnectionStore.js";
import { parseConnectionImport } from "./ConnectionTypes.js";
import { BridgeRuntimeManager } from "./BridgeRuntimeManager.js";
import { DEFAULT_CONFIG } from "../config/KnoxBridgeConfig.js";

// Set by desktop/launcher.cjs. Absent when main.js is started directly (npm run desktop without the launcher).
type Launcher = { apiVersion: number; codeRoot: string; version: string; source: "built-in" | "update"; builtInVersion: string; notes: string[];
  markHealthy(): void; installUpdate(file: string): { ok: boolean; version?: string; reason?: string }; revertToBuiltIn(): void };
const launcher = (globalThis as { knoxLauncher?: Launcher }).knoxLauncher;
// The UI (preload + renderer) comes from the same code root as this file, so updates can change it too.
const codeRoot = launcher?.codeRoot ?? app.getAppPath();
let window: BrowserWindow | undefined; let store: ConnectionStore; let runtime: BridgeRuntimeManager; let shuttingDown = false; let smokeInProgress = false;
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
  ipcMain.handle("connections:add", async (_event, json: string, name: string) => store.add(parseConnectionImport(json), name));
  ipcMain.handle("connections:update", (_event, id: string, changes, token?: string) => store.update(id, changes, token));
  ipcMain.handle("connections:remove", async (_event, id: string) => { runtime.stop(id); await store.remove(id); });
  ipcMain.handle("runtime:start", async (_event, id: string) => runtime.start(await connection(id)));
  ipcMain.handle("runtime:stop", (_event, id: string) => runtime.stop(id)); ipcMain.handle("runtime:status", async (_event, id: string) => runtime.describe(await connection(id)));
  ipcMain.handle("runtime:doctor", async (_event, id: string) => runtime.doctor(await connection(id)));
  ipcMain.handle("legacy:read", async () => Boolean(await legacy()));
  ipcMain.handle("app:info", () => ({ version: launcher?.version ?? app.getVersion(), source: launcher?.source ?? "built-in",
    builtInVersion: launcher?.builtInVersion ?? app.getVersion(), updatesSupported: Boolean(launcher), notes: launcher?.notes ?? [] }));
  ipcMain.handle("update:install", async () => {
    if (!launcher) return { ok: false, reason: "This build has no update launcher; rebuild the Bridge once." };
    const picked = window ? await dialog.showOpenDialog(window, { title: "Install Knox Relay Bridge update", properties: ["openFile"], filters: [{ name: "Bridge update", extensions: ["zip"] }] }) : undefined;
    if (!picked || picked.canceled || picked.filePaths.length === 0) return { ok: false, cancelled: true };
    return launcher.installUpdate(picked.filePaths[0] as string);
  });
  ipcMain.handle("update:revert", () => { launcher?.revertToBuiltIn(); return { ok: true }; });
  ipcMain.handle("app:restart", () => { shuttingDown = true; runtime?.stopAll(); app.relaunch(); app.quit(); });
  ipcMain.handle("legacy:import", async (_event, name: string) => { const raw = await legacy(); if (!raw) throw new Error("Legacy config.json was not found"); return store.add(parseConnectionImport({ telemetryEndpoint: DEFAULT_CONFIG.telemetryEndpoint, missionSyncEndpoint: DEFAULT_CONFIG.missionSyncEndpoint, ...raw }), name); });
}
async function createWindow(): Promise<void> {
  window = new BrowserWindow({ width: 980, height: 720, minWidth: 760, minHeight: 560, backgroundColor: "#101418", webPreferences: { preload: path.join(codeRoot, "desktop", "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  window.on("close", () => { shuttingDown = true; runtime?.stopAll(); });
  window.on("closed", () => { window = undefined; });
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
      const methods = ["list","add","update","remove","start","stop","status","doctor","legacy","importLegacy","onLog"];
      if (!window.knox || !methods.every((name) => typeof window.knox[name] === "function")) throw new Error("preload API contract incomplete");
      document.getElementById("add-button").click();
      if (!document.getElementById("add-dialog").open) throw new Error("Add Connection did not open");
      document.getElementById("setup-json").value = JSON.stringify({ telemetryEndpoint:"https://example.test/telemetry", missionSyncEndpoint:"https://example.test/missions", networkId:"smoke-network", connectorToken:"smoke-token" });
      document.getElementById("connection-name").value = "Smoke Test";
      document.getElementById("save-connection").click();
      await until(() => document.querySelector("[data-open]"));
      document.querySelector('[data-view="debug"]').click(); if (!document.getElementById("debug").classList.contains("active")) throw new Error("Debug navigation failed");
      document.querySelector('[data-view="settings"]').click(); if (!document.getElementById("settings").classList.contains("active")) throw new Error("Settings navigation failed");
      document.querySelector('[data-view="overview"]').click(); if (!document.getElementById("overview").classList.contains("active")) throw new Error("Overview navigation failed");
      document.querySelector("[data-open]").click();
      await until(() => document.getElementById("run-doctor")); document.getElementById("run-doctor").click();
      await until(() => document.getElementById("doctor-output").textContent.includes("Knox Relay Bridge Doctor"));
      document.getElementById("detail-toggle").click();
      await until(() => document.querySelector(".startup-error"));
      const failure = document.querySelector(".startup-error").textContent;
      if (!failure.includes("Zomboid") || !failure.includes("Expected")) throw new Error("Missing-PZ failure was not actionable");
      document.getElementById("open-debug").click();
      await until(() => document.getElementById("logs").textContent.includes("Cannot start Bridge connection"));
      const debugFailure = document.getElementById("logs").textContent;
      document.querySelector('[data-view="overview"]').click(); document.querySelector('[data-start]').click();
      await until(() => document.querySelector(".error-state"));
      document.getElementById("add-button").click();
      const connectionCountBeforeActive = document.querySelectorAll("[data-start]").length;
      document.getElementById("setup-json").value = JSON.stringify({ telemetryEndpoint:"https://example.test/telemetry", missionSyncEndpoint:"https://example.test/missions", networkId:"running-network", connectorToken:"running-token", exchangeRoot:${JSON.stringify(exchangeRoot)} });
      document.getElementById("connection-name").value = "Active Close Test"; document.getElementById("save-connection").click();
      await until(() => document.querySelectorAll("[data-start]").length > connectionCountBeforeActive);
      const startButtons = document.querySelectorAll("[data-start]"); startButtons[startButtons.length - 1].click();
      await until(() => [...document.querySelectorAll(".card")].some((card) => card.textContent.includes("Active Close Test") && card.querySelector(".status")?.textContent.includes("Running")));
      return { ok:true, api:methods, addConnection:true, overview:true, debug:true, settings:true, doctor:true, missingPzActionable:true, startFailureInDebug:debugFailure.includes("Zomboid"), retryPossible:true, runningClosePrepared:true, fatalVisible:Boolean(document.querySelector(".fatal")) };
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
  runtime = new BridgeRuntimeManager(store, (id, event) => {
    const target = window;
    if (shuttingDown || !target || target.isDestroyed() || target.webContents.isDestroyed()) return;
    try { target.webContents.send("runtime:log", id, event); } catch (error) { console.error("Renderer log delivery failed safely:", error instanceof Error ? error.message : String(error)); }
  });
  registerIpc(); await createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
}).catch((error) => { console.error(error); app.quit(); });
app.on("window-all-closed", () => { if (!smokeInProgress) app.quit(); });
app.on("before-quit", () => { shuttingDown = true; runtime?.stopAll(); });
