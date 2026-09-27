// desktop/preload.cjs
// v4 - 27-09-2026 - add() accepts explicit confirmation for a non-Knox backend

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("knox", {
  list: () => ipcRenderer.invoke("connections:list"),
  add: (json, name, allowUnknownHosts) => ipcRenderer.invoke("connections:add", json, name, allowUnknownHosts === true),
  update: (id, changes, token) => ipcRenderer.invoke("connections:update", id, changes, token),
  remove: (id) => ipcRenderer.invoke("connections:remove", id),
  start: (id) => ipcRenderer.invoke("runtime:start", id),
  stop: (id) => ipcRenderer.invoke("runtime:stop", id),
  status: (id) => ipcRenderer.invoke("runtime:status", id),
  doctor: (id) => ipcRenderer.invoke("runtime:doctor", id),
  legacy: () => ipcRenderer.invoke("legacy:read"),
  importLegacy: (name) => ipcRenderer.invoke("legacy:import", name),
  appInfo: () => ipcRenderer.invoke("app:info"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  revertUpdate: () => ipcRenderer.invoke("update:revert"),
  restart: () => ipcRenderer.invoke("app:restart"),
  getAutoUpdate: () => ipcRenderer.invoke("update:auto:get"),
  setAutoUpdate: (enabled) => ipcRenderer.invoke("update:auto:set", enabled),
  checkForUpdate: () => ipcRenderer.invoke("update:check"),
  lastUpdate: () => ipcRenderer.invoke("update:last"),
  onUpdateStatus: (listener) => {
    const handler = (_event, status) => listener(status);
    ipcRenderer.on("update:status", handler);
    return () => ipcRenderer.removeListener("update:status", handler);
  },
  onLog: (listener) => {
    const handler = (_event, id, item) => listener(id, item);
    ipcRenderer.on("runtime:log", handler);
    return () => ipcRenderer.removeListener("runtime:log", handler);
  },
});
