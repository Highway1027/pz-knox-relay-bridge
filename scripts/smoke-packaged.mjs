// scripts/smoke-packaged.mjs
// v1 - 26-09-2026 - Verify standalone Windows UI, persistence, and real automatic PZ paths

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(repo, 'release', 'win-unpacked', 'Knox Relay Bridge.exe');
const pzRoot = path.join(os.homedir(), 'Zomboid');
const exchangeRoot = path.join(pzRoot, 'Lua', 'KnoxRelay');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const token = 'packaged-smoke-test-token';
const report = { executable, pzRoot, exchangeRoot, launches: [], backend: 'local HTTP 503 fixture; no production traffic' };

// Real paths are opt-in. Never consume live pending events or launch the game.
assert.equal(process.platform, 'win32', 'This packaged smoke runner targets Windows.');
assert.ok(process.argv.includes('--real-pz'), 'Pass --real-pz to check the existing, idle PZ filesystem.');
assert.ok(!process.env.KNOX_EXCHANGE_ROOT, 'Clear KNOX_EXCHANGE_ROOT to verify automatic detection.');
assert.ok((await stat(pzRoot)).isDirectory(), 'Start PZ once yourself before this filesystem check.');
await access(executable);
const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
execFileSync(powershell, ['-NoProfile', '-Command', "if (Get-Process | Where-Object { $_.ProcessName -match 'ProjectZomboid|Knox Relay Bridge|electron|^java(w)?$' }) { throw 'Close PZ, Java servers, and other Bridge instances before this check.' }"], { windowsHide: true, stdio: 'pipe' });

async function entries(directory) {
  try { return await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function assertIdleExchange() {
  for (const folder of ['game-to-bridge/pending', 'game-to-bridge/telemetry', 'bridge-to-game/pending']) {
    assert.equal((await entries(path.join(exchangeRoot, folder))).length, 0, `${folder} is not empty; preserve it and use the manual checklist.`);
  }
}
async function snapshot(directory, prefix = '') {
  const files = {};
  for (const entry of await entries(directory)) {
    const relative = path.join(prefix, entry.name);
    assert.ok(!entry.isSymbolicLink(), 'Smoke test does not traverse exchange symlinks.');
    if (entry.isDirectory()) Object.assign(files, await snapshot(path.join(directory, entry.name), relative));
    else files[relative] = createHash('sha256').update(await readFile(path.join(directory, entry.name))).digest('hex');
  }
  return files;
}
await assertIdleExchange();
const before = await snapshot(exchangeRoot);
await mkdir(path.join(repo, 'temp'), { recursive: true });
const artifacts = await mkdtemp(path.join(repo, 'temp', 'packaged-smoke-'));
const profile = path.join(artifacts, 'profile');
await mkdir(profile);
let requests = 0;
const server = createServer((request, response) => {
  requests += 1;
  request.resume();
  response.writeHead(503, { 'Content-Type': 'application/json' });
  response.end('{"error":"intentional smoke-test outage"}');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const setup = { networkId: 'packaged-smoke-network', connectorToken: token, telemetryEndpoint: `${endpoint}/telemetry`, missionSyncEndpoint: `${endpoint}/missions`, audioSyncEndpoint: `${endpoint}/audio`, syncEndpoint: `${endpoint}/ping` };

async function launch(phase, action) {
  // The packaged child gets only Windows utilities on PATH, no Node/npm or Electron development flags.
  const environment = { ...process.env, KNOX_SMOKE_USER_DATA: profile };
  for (const key of Object.keys(environment)) {
    if (/^(path|node_options|electron_run_as_node|knox_smoke_report|knox_exchange_root|knox_network_id|knox_connector_token)$/i.test(key)) delete environment[key];
  }
  environment.PATH = path.join(process.env.SystemRoot, 'System32');
  const child = spawn(executable, ['--remote-debugging-port=0'], { cwd: artifacts, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const exited = new Promise((resolve) => { child.once('error', (error) => resolve({ error: error.message })); child.once('exit', (code, signal) => resolve({ code, signal })); });
  let ws;
  try {
    let tab;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        // stderr belongs to this launch; do not reuse a stale DevToolsActivePort file.
        const port = output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1];
        if (port) tab = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === 'page' && item.url.startsWith('file:'));
        if (tab) break;
      } catch { /* Renderer may still be starting. */ }
      if (child.exitCode !== null) throw new Error(`Packaged app exited during ${phase}: ${output}`);
      await delay(100);
    }
    assert.ok(tab, `Packaged renderer did not open: ${output}`);
    ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    let nextId = 0;
    const pending = new Map();
    const errors = [];
    ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject, timer } = pending.get(message.id);
        pending.delete(message.id); clearTimeout(timer);
        message.error ? reject(new Error(message.error.message)) : resolve(message.result);
      }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map((arg) => arg.value || arg.description).join(' '));
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools timeout: ${method}`)); }, 20000);
      pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
    });
    await send('Runtime.enable');
    const evaluated = await send('Runtime.evaluate', {
      expression: `(${action.toString()})(${JSON.stringify({ setup, exchangeRoot, secondRoot: path.join(artifacts, 'secondary-exchange') })})`,
      awaitPromise: true, returnByValue: true,
    });
    assert.ok(!evaluated.exceptionDetails, evaluated.exceptionDetails?.exception?.description || 'UI evaluation failed');
    assert.deepEqual(errors, [], 'Renderer errors');
    report.launches.push({ phase, ...evaluated.result.value });
    await send('Runtime.evaluate', { expression: 'setTimeout(() => window.close(), 100)' });
    const result = await Promise.race([exited, delay(10000).then(() => ({ timeout: true }))]);
    assert.deepEqual(result, { code: 0, signal: null }, 'Packaged app must close cleanly');
    assert.doesNotMatch(output, /Object has been destroyed|Uncaught Exception|Cannot use import statement|preload.*(?:failed|error)/i);
    await writeFile(path.join(artifacts, `${phase}.log`), output);
    console.log(`PASS ${phase}`);
  } finally {
    ws?.close();
    if (child.exitCode === null) child.kill();
  }
}

try {
  await launch('add-and-close', async ({ setup, secondRoot }) => {
    const until = async (test) => { for (let i = 0; i < 120; i++) { if (await test()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('UI wait timed out'); };
    const require = (value, message) => { if (!value) throw new Error(message); };
    const methods = ['list', 'add', 'update', 'remove', 'start', 'stop', 'status', 'doctor', 'legacy', 'importLegacy', 'onLog'];
    await until(() => window.knox && document.getElementById('add-button'));
    require(methods.every((method) => typeof window.knox[method] === 'function'), 'Preload API incomplete');
    require(typeof window.require === 'undefined' && typeof window.process === 'undefined', 'Renderer Node isolation failed');
    require((await window.knox.list()).length === 0, 'Profile must be isolated');
    for (const [index, name] of ['Ally Filesystem Smoke', 'Secondary Smoke'].entries()) {
      document.getElementById('add-button').click();
      require(document.getElementById('add-dialog').open, 'Add dialog did not open');
      document.getElementById('setup-json').value = JSON.stringify({ ...setup, ...(index ? { networkId: 'secondary-smoke', exchangeRoot: secondRoot } : {}) });
      document.getElementById('connection-name').value = name;
      document.getElementById('save-connection').click();
      await until(() => document.querySelectorAll('[data-open]').length === index + 1);
    }
    for (const view of ['debug', 'settings', 'overview']) {
      document.querySelector(`[data-view="${view}"]`).click();
      require(document.getElementById(view).classList.contains('active'), `${view} failed`);
    }
    document.querySelector('[data-open]').click();
    document.getElementById('edit-name').value = 'Ally Persistence Smoke';
    document.getElementById('save-settings').click();
    await until(async () => (await window.knox.list())[0]?.name === 'Ally Persistence Smoke');
    return { api: methods, addConnection: true, multipleConnections: true, navigation: true, saveSettings: true, rendererIsolated: true };
  });
  const saved = JSON.parse(await readFile(path.join(profile, 'connections.json'), 'utf8'));
  const secrets = await readFile(path.join(profile, 'secrets.json'), 'utf8');
  assert.equal(saved.connections.length, 2);
  assert.ok(!JSON.stringify(saved).includes(token) && !secrets.includes(token), 'No plaintext test token on disk');
  const ids = saved.connections.map((item) => item.id);
  await assertIdleExchange();
  await launch('reopen-start-stop-restart-close-running', async ({ exchangeRoot }) => {
    const until = async (test) => { for (let i = 0; i < 200; i++) { if (await test()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('Runtime UI wait timed out'); };
    const require = (value, message) => { if (!value) throw new Error(message); };
    await until(() => document.querySelectorAll('[data-open]').length === 2);
    const connection = (await window.knox.list())[0];
    require(connection.name === 'Ally Persistence Smoke', 'Settings did not persist');
    require(!connection.exchangeRootOverride, 'Automatic path was overridden');
    document.querySelector('[data-open]').click();
    document.getElementById('detail-toggle').click();
    await until(() => document.querySelector('#detail-content .status')?.textContent === 'Running');
    require((await window.knox.status(connection.id)).exchangeDirectory === exchangeRoot, 'Wrong automatic exchange root');
    document.getElementById('open-debug').click();
    await until(() => document.getElementById('logs').textContent.includes('retry in'));
    const logs = document.getElementById('logs').textContent;
    for (const expected of ['Starting desktop', exchangeRoot, 'source: automatic', 'Watching', 'connection started', 'mission sync OFFLINE', 'HTTP 503']) require(logs.includes(expected), `Missing Debug entry: ${expected}`);
    document.querySelector('[data-view="overview"]').click(); document.querySelector('[data-open]').click();
    document.getElementById('run-doctor').click();
    await until(() => document.getElementById('doctor-output').textContent.includes('Knox Relay Bridge Doctor'));
    const doctor = document.getElementById('doctor-output').textContent;
    require(!doctor.includes('FAIL'), doctor);
    document.getElementById('detail-toggle').click();
    await until(() => document.querySelector('#detail-content .status')?.textContent === 'Offline');
    document.getElementById('detail-toggle').click();
    await until(() => document.querySelector('#detail-content .status')?.textContent === 'Running');
    return { persisted: true, automaticPath: true, running: true, stop: true, restart: true, closeWhileRunning: true, doctor, debug: logs };
  });
  await launch('reopen-after-running-close', async () => {
    const until = async (test) => { for (let i = 0; i < 120; i++) { if (await test()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('Reopen wait timed out'); };
    await until(() => document.querySelectorAll('[data-open]').length === 2);
    const connections = await window.knox.list();
    for (const connection of connections) if ((await window.knox.status(connection.id)).state !== 'offline') throw new Error('Unexpected runtime after reopen');
    return { connections: connections.length, offlineAfterReopen: true };
  });
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, 'connections.json'), 'utf8')).connections.map((item) => item.id), ids);
  for (const folder of ['game-to-bridge/pending', 'game-to-bridge/processed', 'game-to-bridge/failed', 'game-to-bridge/telemetry', 'bridge-to-game/pending', 'bridge-to-game/processed', 'state']) assert.ok((await stat(path.join(exchangeRoot, folder))).isDirectory());
  assert.deepEqual(await snapshot(exchangeRoot), before, 'Existing exchange files must remain unchanged');
  assert.ok(requests > 0, 'Runtime must actually contact the local outage fixture');
  report.ok = true;
  report.localRequests = requests;
  report.exchangeFilesUnchanged = true;
  report.encryptedPersistence = true;
} catch (error) {
  report.ok = false; report.error = error.stack; process.exitCode = 1;
} finally {
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  await writeFile(path.join(artifacts, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Smoke report: ${path.join(artifacts, 'report.json')}`);
  if (!report.ok) console.error(report.error);
}
