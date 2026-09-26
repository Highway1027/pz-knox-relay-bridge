// desktop/preload.cjs
// v1 - 26-09-2026 - Expose sandbox-compatible CommonJS desktop IPC bridge

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("knox", {
  list: () => ipcRenderer.invoke("connections:list"),
  add: (json, name) => ipcRenderer.invoke("connections:add", json, name),
  update: (id, changes, token) => ipcRenderer.invoke("connections:update", id, changes, token),
  remove: (id) => ipcRenderer.invoke("connections:remove", id),
  start: (id) => ipcRenderer.invoke("runtime:start", id),
  stop: (id) => ipcRenderer.invoke("runtime:stop", id),
  status: (id) => ipcRenderer.invoke("runtime:status", id),
  doctor: (id) => ipcRenderer.invoke("runtime:doctor", id),
  legacy: () => ipcRenderer.invoke("legacy:read"),
  importLegacy: (name) => ipcRenderer.invoke("legacy:import", name),
  onLog: (listener) => {
    const handler = (_event, id, item) => listener(id, item);
    ipcRenderer.on("runtime:log", handler);
    return () => ipcRenderer.removeListener("runtime:log", handler);
  },
});
