// desktop/renderer/renderer.js
// v8 - 11-10-2026 - Smaller window: connection rows with a cog, Debug and Doctor inside Settings

if (!window.knox) {
  document.body.innerHTML = `<main class="fatal"><h1>Knox Relay Bridge failed to initialize.</h1><p>The desktop bridge API could not be loaded.</p><p>Open Developer Tools for diagnostics.</p></main>`;
  console.error("Knox Relay Bridge preload API is unavailable");
} else {
  const api = window.knox;
  const state = { connections: [], statuses: new Map(), logs: new Map(), selected: null, paused: false, bridge: [] };
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const short = (id) => id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
  const status = (id) => state.statuses.get(id) || { state: "offline", backend: "unknown" };
  const phaseLabel = (phase) => phase === "starting" ? "Starting…" : phase === "stopping" ? "Stopping…" : `${phase[0].toUpperCase()}${phase.slice(1)}`;
  const ago = (value) => value ? `${Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000))} sec ago` : "Unknown";

  function show(view) {
    document.querySelectorAll(".view").forEach((element) => element.classList.toggle("active", element.id === view));
    $("settings-button").hidden = view === "settings";
  }

  async function refresh() {
    state.connections = await api.list();
    await Promise.all(state.connections.map(async (connection) => state.statuses.set(connection.id, await api.status(connection.id))));
    renderConnections(); renderDebugSelect();
  }

  // Bridge 0.3.0: connections run by themselves for the save being played; no Start or Stop.
  const runLabel = (runtime) => runtime.state === "running" ? "Active for this game" : runtime.state === "starting" ? "Starting…" : runtime.state === "stopping" ? "Stopping…" : runtime.state === "error" ? "Could not start" : "Standby";
  const saveLabel = (bridge) => bridge.saveId ? `save ${escapeHtml(short(bridge.saveId))}` : "this save";
  const modeLabel = (bridge) => bridge.mode === "mp" ? " (multiplayer)" : bridge.mode === "sp" ? " (singleplayer)" : "";
  function bridgeText(bridge) {
    const network = bridge.networkId ? (state.connections.find((item) => item.networkId === bridge.networkId)?.name ?? `network ${short(bridge.networkId)}`) : "";
    switch (bridge.state) {
      case "no_game_folder": return ["warn", "Project Zomboid's user folder was not found.", "Start Project Zomboid once on this account."];
      case "idle": return ["", "Waiting for Project Zomboid.", "No web calls until a save with Knox Mission Board is loaded."];
      case "unlinked": return ["warn", `Game running: ${saveLabel(bridge)}${modeLabel(bridge)} is not linked to a Knox network yet.`, "Pick the network in game: Mission Board window, “Link this save to”."];
      case "no_connection": if (bridge.legacy && !bridge.networkId) return ["warn", "An older Knox Mission Board is running; it does not say which Knox network this save uses.", "Update Knox Mission Board to 0.37.0 or later. Until then the Bridge runs a connection only when there is just one, or one this save used before."];
        return ["warn", `Game running: ${saveLabel(bridge)} is linked to ${escapeHtml(network || "a network")}, but no connection here has it.`, "Add that network's setup text from the Knox webapp, or unlink the save in game."];
      case "error": return ["error", `Cannot start ${escapeHtml(bridge.activeName ?? network)}.`, escapeHtml(String(bridge.lastError ?? "").split("\n")[0])];
      case "stopped": return ["", "Bridge stopped.", ""];
      default: return ["active", `Running ${escapeHtml(bridge.activeName ?? network)} for ${saveLabel(bridge)}${modeLabel(bridge)}.`, bridge.legacy ? "Older Mission Board without a heartbeat: update the mod for save linking." : "The Bridge follows the save: another save switches the connection by itself."];
    }
  }
  function renderBridge() {
    const bridge = state.bridge[0];
    if (!bridge) return;
    const [kind, title, detail] = bridgeText(bridge);
    $("game-status").className = `game-status ${kind}`;
    $("game-status").innerHTML = `${title}${detail ? `<small>${detail}</small>` : ""}`;
  }

  function renderConnections() {
    const root = $("connections");
    root.innerHTML = state.connections.map((connection) => {
      const runtime = status(connection.id);
      const error = runtime.lastError ? `<p class="error">${escapeHtml(String(runtime.lastError).split("\n")[0])}</p>` : "";
      return `<article class="row ${runtime.state} ${runtime.state === "error" ? "error-state" : ""}"><div class="name"><strong>${escapeHtml(connection.name)}</strong><p class="status"><i class="dot"></i>${escapeHtml(runLabel(runtime))}${runtime.state === "running" ? ` · backend ${escapeHtml(runtime.backend)}` : ""}</p>${error}</div><button class="icon-button" data-open="${connection.id}" title="Settings of ${escapeHtml(connection.name)}" aria-label="Settings of ${escapeHtml(connection.name)}">⚙</button></article>`;
    }).join("");
    $("empty").hidden = state.connections.length > 0;
    root.querySelectorAll("[data-open]").forEach((button) => { button.onclick = () => openDetail(button.dataset.open); });
  }

  // Only the status part refreshes while the page is open, so typing in the settings fields is never lost.
  function renderDetailStatus(id) {
    const runtime = status(id); const running = runtime.state === "running";
    const failure = runtime.lastError ? `<section class="startup-error"><h3>Cannot start</h3><pre>${escapeHtml(runtime.lastError)}</pre><p class="muted">Fix the issue; the Bridge tries again by itself within half a minute.</p></section>` : "";
    const facts = running ? `<dl class="facts"><dt>Backend</dt><dd>${escapeHtml(runtime.backend)}</dd><dt>Last telemetry</dt><dd>${ago(runtime.lastTelemetrySync)} · ${runtime.playerCount ?? "unknown"} players</dd><dt>Last mission sync</dt><dd>${ago(runtime.lastMissionSync)}</dd></dl>` : "";
    $("detail-status").className = `panel ${runtime.state} ${runtime.state === "error" ? "error-state" : ""}`;
    $("detail-status").innerHTML = `<p class="status"><i class="dot"></i>${escapeHtml(runLabel(runtime))}</p>${running ? "" : `<p class="muted">Runs by itself while a save linked to this network is loaded.</p>`}${facts}${failure}`;
  }

  function openDetail(id) {
    state.selected = id; const connection = state.connections.find((item) => item.id === id);
    show("detail");
    $("detail-content").innerHTML = `<h2>${escapeHtml(connection.name)}</h2><div id="detail-status"></div><div class="panel"><h3>Connection settings</h3>`
      + `<label title="Only for you, to tell connections apart. The game shows the network name from the webapp.">Name<input id="edit-name" value="${escapeHtml(connection.name)}"></label>`
      + `<label title="The folder where the game and the Bridge swap files. Leave empty: the Bridge finds Zomboid/Lua/KnoxRelay in your user folder by itself.">Exchange folder <span class="hint">Leave empty unless Project Zomboid uses a different user folder.</span><input id="edit-root" placeholder="Automatic" value="${escapeHtml(connection.exchangeRootOverride || "")}"></label>`
      + `<label title="The connector token from the webapp's setup text. Paste a new one only when the webapp made a new token; the old one then stops working.">Replace token <span class="hint">Leave empty to keep the saved token.</span><input id="edit-token" type="password" autocomplete="off"></label>`
      + `<div class="detail-actions"><button id="save-settings" class="primary" title="Save the name, folder and token">Save</button><button id="open-debug" title="Show this connection's log, network id and Doctor">Debug</button><button id="remove-connection" class="danger" title="Delete this connection and its saved token from this computer">Remove</button></div></div>`;
    renderDetailStatus(id);
    $("open-debug").onclick = () => { $("debug-connection").value = id; $("debug-connection").onchange(); show("settings"); $("debug").scrollIntoView(); };
    $("save-settings").onclick = async () => { await api.update(id, { name: $("edit-name").value, exchangeRootOverride: $("edit-root").value }, $("edit-token").value || undefined); await api.connectionsChanged(); await refresh(); openDetail(id); };
    $("remove-connection").onclick = async () => { if (confirm(`Remove ${connection.name}?`)) { await api.remove(id); await api.connectionsChanged(); state.selected = null; await refresh(); show("overview"); } };
  }

  // "Bridge (game link)": what the Bridge saw of the game and which connection it ran, for every connection.
  const BRIDGE_LOG_ID = "bridge";
  function renderDebugSelect() {
    const current = $("debug-connection").value;
    $("debug-connection").innerHTML = `<option value="${BRIDGE_LOG_ID}">Bridge (game link)</option>` + state.connections.map((connection) => `<option value="${connection.id}">${escapeHtml(connection.name)}</option>`).join("");
    if (current === BRIDGE_LOG_ID || state.connections.some((connection) => connection.id === current)) $("debug-connection").value = current;
    renderDebugInfo(); renderLogs();
  }
  // Network id, exchange folder and Doctor live here, not on the start screen.
  function renderDebugInfo() {
    const connection = state.connections.find((item) => item.id === $("debug-connection").value);
    $("run-doctor").disabled = !connection;
    if (!connection) { $("debug-network").textContent = "What the Bridge saw of the game, and which connection it ran."; return; }
    const runtime = status(connection.id);
    $("debug-network").textContent = `Network ${connection.networkId} · exchange folder ${runtime.exchangeDirectory || connection.exchangeRootOverride || "automatic"}`;
  }
  $("run-doctor").onclick = async () => {
    const id = $("debug-connection").value; if (id === BRIDGE_LOG_ID) return;
    $("doctor-output").hidden = false; $("doctor-output").textContent = "Running Doctor…";
    $("doctor-output").textContent = (await api.doctor(id)).join("\n");
  };

  const ranks = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
  function renderLogs() {
    if (state.paused) return;
    const id = $("debug-connection").value; const minimum = ranks[$("level").value]; const items = (state.logs.get(id) || []).filter((event) => ranks[event.level] >= minimum);
    $("logs").textContent = items.map((event) => `${event.timestamp.slice(11, 19)}  ${event.level.padEnd(5)}  ${event.message}${event.context ? ` ${JSON.stringify(event.context)}` : ""}`).join("\n");
    if ($("autoscroll").checked) $("logs").scrollTop = $("logs").scrollHeight;
  }

  api.onLog((id, event) => {
    const items = state.logs.get(id) || []; items.push(event); if (items.length > 2000) items.shift(); state.logs.set(id, items);
    if (id !== BRIDGE_LOG_ID) api.status(id).then((next) => { state.statuses.set(id, next); renderConnections(); if (state.selected === id && $("detail").classList.contains("active")) renderDetailStatus(id); }).catch(() => {});
    renderLogs();
  });
  api.onBridgeStatus((statuses) => { state.bridge = statuses; renderBridge(); refresh().catch(() => {}); });
  api.bridgeStatus().then((statuses) => { state.bridge = statuses; renderBridge(); }).catch(() => {});
  document.querySelectorAll("button[data-view]").forEach((button) => { button.onclick = () => show(button.dataset.view); });
  $("add-button").onclick = () => $("add-dialog").showModal();
  // A setup text for a server other than the Knox Relay backend needs a second, deliberate click.
  let allowUnknownHosts = false;
  const resetAddDialog = () => { allowUnknownHosts = false; $("save-connection").textContent = "Validate & Save"; $("add-error").textContent = ""; };
  $("setup-json").oninput = resetAddDialog;
  $("save-connection").onclick = async () => {
    try {
      $("add-error").textContent = "";
      await api.add($("setup-json").value, $("connection-name").value, allowUnknownHosts);
      $("add-dialog").close(); $("setup-json").value = ""; $("connection-name").value = ""; resetAddDialog(); await api.connectionsChanged(); await refresh();
    } catch (error) {
      const message = String(error.message || error);
      const unknownHost = message.indexOf("UNKNOWN_HOST: ");
      if (unknownHost >= 0) {
        allowUnknownHosts = true;
        $("save-connection").textContent = "Save anyway";
        $("add-error").textContent = message.slice(unknownHost + "UNKNOWN_HOST: ".length);
      } else {
        $("add-error").textContent = message;
      }
    }
  };
  $("debug-connection").onchange = () => { $("doctor-output").hidden = true; renderDebugInfo(); renderLogs(); }; $("level").onchange = renderLogs;
  $("pause").onclick = () => { state.paused = !state.paused; $("pause").textContent = state.paused ? "Resume" : "Pause"; renderLogs(); };
  $("clear").onclick = () => { state.logs.set($("debug-connection").value, []); renderLogs(); };
  $("copy").onclick = () => navigator.clipboard.writeText($("logs").textContent);
  $("legacy").onclick = async () => { const found = await api.legacy(); if (!found) { $("legacy-result").textContent = "No legacy config.json found."; return; } if (confirm("Existing Knox Relay Bridge configuration found. Import as a saved connection?")) { await api.importLegacy("Imported Legacy Connection"); $("legacy-result").textContent = "Legacy config imported. The original was not changed."; await api.connectionsChanged(); await refresh(); } };
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
  // Update notice at the top of every page. Check results close by themselves after
  // OK_NOTICE_MS ("up to date") or WARN_NOTICE_MS; a ready update stays until the player chooses Restart now or Later.
  const OK_NOTICE_MS = 3000; const WARN_NOTICE_MS = 8000;
  let noticeTimer;
  function showNotice(kind, text, autoClose) {
    clearTimeout(noticeTimer);
    const banner = $("update-banner");
    banner.className = `update-banner ${kind}`;
    $("update-banner-text").textContent = text;
    $("banner-restart").hidden = kind !== "ready";
    $("banner-later").hidden = kind !== "ready";
    banner.hidden = false;
    if (autoClose) noticeTimer = setTimeout(() => { banner.hidden = true; }, kind === "ok" ? OK_NOTICE_MS : WARN_NOTICE_MS);
  }
  function showUpdateStatus(status) {
    if (!status) return;
    const when = status.checkedAt ? ` (checked ${new Date(status.checkedAt).toLocaleTimeString()})` : "";
    if (status.status === "installed") {
      const running = [...state.statuses.values()].some((item) => item.state === "running");
      showNotice("ready", `Knox Relay Bridge ${status.version} is ready.` + (running ? " Restarting stops running connections; otherwise it applies the next time you start the Bridge." : " Restart to use it."), false);
      $("update-result").textContent = `Update ${status.version} is installed and runs after a restart.`;
      $("restart-app").hidden = false;
    } else if (status.status === "up-to-date") {
      showNotice("ok", `Checked for updates: Knox Relay Bridge ${status.version} is up to date.`, true);
      $("update-result").textContent = `Up to date${when}.`;
    } else if (status.status === "error") {
      showNotice("warn", `Could not check for updates: ${status.reason}`, true);
      $("update-result").textContent = `Could not check for updates${when}: ${status.reason}`;
    }
  }
  $("banner-restart").onclick = () => api.restart();
  $("banner-later").onclick = () => { clearTimeout(noticeTimer); $("update-banner").hidden = true; };
  $("banner-close").onclick = () => { clearTimeout(noticeTimer); $("update-banner").hidden = true; };
  $("check-update").onclick = async () => { $("update-result").textContent = "Checking for updates…"; showUpdateStatus({ ...(await api.checkForUpdate()), checkedAt: new Date().toISOString() }); };
  $("auto-update").onchange = async () => { await api.setAutoUpdate($("auto-update").checked); };
  api.onUpdateStatus(showUpdateStatus);
  (async () => { $("auto-update").checked = await api.getAutoUpdate(); showUpdateStatus(await api.lastUpdate()); })();
  renderVersion();
  refresh();
}
