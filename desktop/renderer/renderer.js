// desktop/renderer/renderer.js
// v5 - 27-09-2026 - Automatic updates: setting, check now, ready banner

if (!window.knox) {
  document.body.innerHTML = `<main class="fatal"><h1>Knox Relay Bridge failed to initialize.</h1><p>The desktop bridge API could not be loaded.</p><p>Open Developer Tools for diagnostics.</p></main>`;
  console.error("Knox Relay Bridge preload API is unavailable");
} else {
  const api = window.knox;
  const state = { connections: [], statuses: new Map(), logs: new Map(), selected: null, paused: false };
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const short = (id) => id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
  const status = (id) => state.statuses.get(id) || { state: "offline", backend: "unknown" };
  const phaseLabel = (phase) => phase === "starting" ? "Starting…" : phase === "stopping" ? "Stopping…" : `${phase[0].toUpperCase()}${phase.slice(1)}`;
  const ago = (value) => value ? `${Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000))} sec ago` : "Unknown";

  function show(view) {
    document.querySelectorAll(".view").forEach((element) => element.classList.toggle("active", element.id === view));
    document.querySelectorAll("nav button").forEach((element) => element.classList.toggle("active", element.dataset.view === view));
  }

  async function refresh() {
    state.connections = await api.list();
    await Promise.all(state.connections.map(async (connection) => state.statuses.set(connection.id, await api.status(connection.id))));
    renderConnections(); renderDebugSelect();
  }

  function renderConnections() {
    const root = $("connections");
    root.innerHTML = state.connections.map((connection) => {
      const runtime = status(connection.id); const busy = runtime.state === "starting" || runtime.state === "stopping";
      const error = runtime.lastError ? `<p class="error compact-error">${escapeHtml(runtime.lastError)}</p>` : "";
      const action = runtime.state === "running" ? "Stop" : runtime.state === "starting" ? "Starting…" : runtime.state === "stopping" ? "Stopping…" : "Start";
      return `<article class="card ${runtime.state} ${runtime.state === "error" ? "error-state" : ""}"><div><h3>${escapeHtml(connection.name)}</h3><small>Network ${escapeHtml(short(connection.networkId))}</small><p class="status"><i class="dot"></i>${escapeHtml(phaseLabel(runtime.state))} · Backend ${escapeHtml(runtime.backend)}</p>${error}</div><div><button data-start="${connection.id}" ${busy ? "disabled" : ""}>${action}</button> <button data-open="${connection.id}">Open</button></div></article>`;
    }).join("");
    $("empty").hidden = state.connections.length > 0;
    root.querySelectorAll("[data-start]").forEach((button) => { button.onclick = () => toggle(button.dataset.start); });
    root.querySelectorAll("[data-open]").forEach((button) => { button.onclick = () => openDetail(button.dataset.open); });
  }

  async function toggle(id) {
    const current = status(id); const stopping = current.state === "running";
    state.statuses.set(id, { ...current, state: stopping ? "stopping" : "starting", lastError: stopping ? current.lastError : undefined });
    renderConnections(); if (state.selected === id) openDetail(id);
    try { state.statuses.set(id, stopping ? await api.stop(id) : await api.start(id)); }
    catch (error) { state.statuses.set(id, { ...current, state: "error", lastError: error.message || String(error) }); }
    renderConnections(); if (state.selected === id) openDetail(id);
  }

  function openDetail(id) {
    state.selected = id; const connection = state.connections.find((item) => item.id === id); const runtime = status(id); const busy = runtime.state === "starting" || runtime.state === "stopping";
    show("detail");
    const failure = runtime.lastError ? `<section class="startup-error"><h3>Cannot start</h3><pre>${escapeHtml(runtime.lastError)}</pre><p>Fix the issue, then select Start Bridge to retry.</p></section>` : "";
    $("detail-content").innerHTML = `<p class="eyebrow">CONNECTION</p><h2>${escapeHtml(connection.name)}</h2><div class="panel"><p class="status ${runtime.state}"><i class="dot"></i>${escapeHtml(phaseLabel(runtime.state))}</p>${failure}<div class="detail-grid"><div class="metric"><span>Network ID</span>${escapeHtml(connection.networkId)}</div><div class="metric"><span>Backend</span>${escapeHtml(runtime.backend)}</div><div class="metric"><span>Exchange root</span>${escapeHtml(runtime.exchangeDirectory || connection.exchangeRootOverride || "Automatic")}</div><div class="metric"><span>Connector token</span>Configured</div><div class="metric"><span>Last telemetry</span>${ago(runtime.lastTelemetrySync)} · ${runtime.playerCount ?? "Unknown"} players</div><div class="metric"><span>Last mission sync</span>${ago(runtime.lastMissionSync)}</div></div><div class="detail-actions"><button id="detail-toggle" class="primary" ${busy ? "disabled" : ""}>${runtime.state === "running" ? "Stop Bridge" : busy ? phaseLabel(runtime.state) : "Start Bridge"}</button><button id="run-doctor">Run Doctor</button><button id="open-debug">Open Debug Console</button></div><pre id="doctor-output" class="doctor"></pre><hr><h3>Connection settings</h3><label>Name<input id="edit-name" value="${escapeHtml(connection.name)}"></label><label>Custom exchange root (optional)<input id="edit-root" value="${escapeHtml(connection.exchangeRootOverride || "")}"></label><label>Replace token (leave blank to keep configured token)<input id="edit-token" type="password"></label><div class="detail-actions"><button id="save-settings">Save settings</button><button id="remove-connection" class="danger">Remove connection</button></div></div>`;
    $("detail-toggle").onclick = () => toggle(id);
    $("run-doctor").onclick = async () => { $("doctor-output").textContent = (await api.doctor(id)).join("\n"); };
    $("open-debug").onclick = () => { $("debug-connection").value = id; renderLogs(); show("debug"); };
    $("save-settings").onclick = async () => { await api.update(id, { name: $("edit-name").value, exchangeRootOverride: $("edit-root").value }, $("edit-token").value || undefined); await refresh(); openDetail(id); };
    $("remove-connection").onclick = async () => { if (confirm(`Remove ${connection.name}?`)) { await api.remove(id); state.selected = null; await refresh(); show("overview"); } };
  }

  function renderDebugSelect() {
    const current = $("debug-connection").value;
    $("debug-connection").innerHTML = state.connections.map((connection) => `<option value="${connection.id}">${escapeHtml(connection.name)}</option>`).join("");
    if (state.connections.some((connection) => connection.id === current)) $("debug-connection").value = current;
    renderLogs();
  }

  const ranks = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
  function renderLogs() {
    if (state.paused) return;
    const id = $("debug-connection").value; const minimum = ranks[$("level").value]; const items = (state.logs.get(id) || []).filter((event) => ranks[event.level] >= minimum);
    $("logs").textContent = items.map((event) => `${event.timestamp.slice(11, 19)}  ${event.level.padEnd(5)}  ${event.message}${event.context ? ` ${JSON.stringify(event.context)}` : ""}`).join("\n");
    if ($("autoscroll").checked) $("logs").scrollTop = $("logs").scrollHeight;
  }

  api.onLog((id, event) => {
    const items = state.logs.get(id) || []; items.push(event); if (items.length > 2000) items.shift(); state.logs.set(id, items);
    api.status(id).then((next) => { state.statuses.set(id, next); renderConnections(); if (state.selected === id && $("detail").classList.contains("active")) openDetail(id); }).catch(() => {});
    renderLogs();
  });
  document.querySelectorAll("nav button").forEach((button) => { button.onclick = () => show(button.dataset.view); });
  $("back").onclick = () => show("overview"); $("add-button").onclick = () => $("add-dialog").showModal();
  $("save-connection").onclick = async () => { try { $("add-error").textContent = ""; await api.add($("setup-json").value, $("connection-name").value); $("add-dialog").close(); $("setup-json").value = ""; $("connection-name").value = ""; await refresh(); } catch (error) { $("add-error").textContent = error.message; } };
  $("debug-connection").onchange = renderLogs; $("level").onchange = renderLogs;
  $("pause").onclick = () => { state.paused = !state.paused; $("pause").textContent = state.paused ? "Resume" : "Pause"; renderLogs(); };
  $("clear").onclick = () => { state.logs.set($("debug-connection").value, []); renderLogs(); };
  $("copy").onclick = () => navigator.clipboard.writeText($("logs").textContent);
  $("legacy").onclick = async () => { const found = await api.legacy(); if (!found) { $("legacy-result").textContent = "No legacy config.json found."; return; } if (confirm("Existing Knox Relay Bridge configuration found. Import as a saved connection?")) { await api.importLegacy("Imported Legacy Connection"); $("legacy-result").textContent = "Legacy config imported. The original was not changed."; await refresh(); } };
  async function renderVersion() {
    const info = await api.appInfo();
    const source = info.source === "update" ? `installed update (built-in ${info.builtInVersion})` : "built-in";
    $("app-version").textContent = `Version ${info.version}, ${source}.` + (info.notes.length ? ` ${info.notes.join(" ")}` : "");
    $("install-update").disabled = !info.updatesSupported;
    $("revert-update").hidden = info.source !== "update";
    if (!info.updatesSupported) $("update-result").textContent = "This build cannot install updates. Rebuild the Bridge once to enable them.";
  }
  $("install-update").onclick = async () => {
    $("update-result").textContent = "Checking the update…";
    const result = await api.installUpdate();
    if (result.cancelled) { $("update-result").textContent = ""; return; }
    if (!result.ok) { $("update-result").textContent = `Update not installed: ${result.reason}`; return; }
    $("update-result").textContent = `Update ${result.version} is installed. Restart the Bridge to use it; running connections stop and can be started again.`;
    $("restart-app").hidden = false;
  };
  $("restart-app").onclick = () => api.restart();
  $("revert-update").onclick = async () => {
    await api.revertUpdate();
    $("update-result").textContent = "The built-in version runs after a restart.";
    $("restart-app").hidden = false;
  };
  // Automatic updates: a ready update shows a banner; it also applies at the next start.
  function showUpdateStatus(status) {
    if (!status) return;
    const when = status.checkedAt ? ` (checked ${new Date(status.checkedAt).toLocaleTimeString()})` : "";
    if (status.status === "installed") {
      const running = [...state.statuses.values()].some((item) => item.state === "running");
      $("update-banner-text").textContent = `Knox Relay Bridge ${status.version} is ready.` + (running ? " Restarting stops running connections; otherwise it applies the next time you start the Bridge." : " Restart to use it.");
      $("update-banner").hidden = false;
      $("update-result").textContent = `Update ${status.version} is installed and runs after a restart.`;
      $("restart-app").hidden = false;
    } else if (status.status === "up-to-date") {
      $("update-result").textContent = `Up to date${when}.`;
    } else if (status.status === "error") {
      $("update-result").textContent = `Could not check for updates${when}: ${status.reason}`;
    }
  }
  $("banner-restart").onclick = () => api.restart();
  $("banner-later").onclick = () => { $("update-banner").hidden = true; };
  $("check-update").onclick = async () => { $("update-result").textContent = "Checking for updates…"; showUpdateStatus({ ...(await api.checkForUpdate()), checkedAt: new Date().toISOString() }); };
  $("auto-update").onchange = async () => { await api.setAutoUpdate($("auto-update").checked); };
  api.onUpdateStatus(showUpdateStatus);
  (async () => { $("auto-update").checked = await api.getAutoUpdate(); showUpdateStatus(await api.lastUpdate()); })();
  renderVersion();
  refresh();
}
