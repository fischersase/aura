// UI smoke test for the installed Windows app (CI, windows-build.yml).
// Starts the installed Aura with a DevTools port, opens the corner chat and the Zentrale settings page via the
// command line (--toggle / --settings, like the hotkey and the tray), and checks over the Chrome DevTools Protocol
// that both windows get answers from the main process (IPC). Writes aura-smoke/ (log, JSON report, screenshots).
// Usage: node scripts/win-ui-smoke.js <path-to-Aura.exe>
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const exe = process.argv[2];
const PORT = 9333;
const OUT = path.resolve('aura-smoke');
fs.mkdirSync(OUT, { recursive: true });
const report = { exe, checks: {}, errors: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function prepareSettings() {
  // Skip the setup wizard; provider "ollama" is ready without an API key.
  const dir = path.join(process.env.APPDATA, 'Aura');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  fs.writeFileSync(file, JSON.stringify({ ...cur, setupDone: true, provider: 'ollama', autostart: false }, null, 2));
}

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}

async function waitTarget(match, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const t = (await targets()).find((x) => x.type === 'page' && x.url.includes(match));
      if (t) return t;
    } catch {}
    await sleep(500);
  }
  throw new Error(`target ${match} not found`);
}

// Minimal CDP client over the global WebSocket (Node 22).
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) events.push(msg);
  };
  const ready = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ready, send, events, close: () => ws.close() };
}

async function evaluate(client, expression, timeoutMs = 8000) {
  const r = await Promise.race([
    client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    sleep(timeoutMs).then(() => ({ timeout: true }))
  ]);
  if (r.timeout) return { timeout: true };
  if (r.result && r.result.exceptionDetails) return { exception: r.result.exceptionDetails.text, details: r.result };
  return r.result && r.result.result ? r.result.result.value : r;
}

const SAFE = (expr) =>
  `(async () => { try { const t0 = Date.now(); const v = await (${expr}); return { ok: true, ms: Date.now() - t0, v }; } ` +
  `catch (e) { return { ok: false, error: String(e && e.message || e) }; } })()`;

async function screenshot(client, name) {
  try {
    const r = await client.send('Page.captureScreenshot', { format: 'png' });
    if (r.result && r.result.data) fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
  } catch {}
}

function desktopShot(name) {
  try {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ' +
        '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; ' +
        '$g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); ' +
        `$bmp.Save('${path.join(OUT, name)}')`
    ]);
  } catch (e) {
    report.errors.push('desktop screenshot: ' + e.message);
  }
}

async function main() {
  prepareSettings();
  const log = fs.openSync(path.join(OUT, 'aura.log'), 'w');
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(exe, [`--remote-debugging-port=${PORT}`], { env, stdio: ['ignore', log, log], detached: false });
  await sleep(8000);

  // Corner chat, like the hotkey
  spawn(exe, ['--toggle'], { env, stdio: 'ignore' });
  const panelT = await waitTarget('panel.html');
  const panel = cdp(panelT.webSocketDebuggerUrl);
  await panel.ready;
  await panel.send('Runtime.enable');
  await panel.send('Log.enable');
  await sleep(3000);
  report.checks.panelVersionText = await evaluate(panel, `document.getElementById('appVer').textContent`);
  report.checks.panelGetSettings = await evaluate(panel, SAFE(`window.api.getSettings().then(s => s.version)`));
  report.checks.panelListChats = await evaluate(panel, SAFE(`window.api.listChats().then(c => c.length)`));
  report.checks.panelGetUsage = await evaluate(panel, SAFE(`window.api.getUsage().then(u => !!u)`));
  report.checks.panelCardClasses = await evaluate(panel, `document.getElementById('card').className`);
  await screenshot(panel, 'panel.png');
  desktopShot('desktop-panel.png');

  // Zentrale settings, like the tray / settings button
  spawn(exe, ['--settings'], { env, stdio: 'ignore' });
  const zT = await waitTarget('zentrale.html');
  const z = cdp(zT.webSocketDebuggerUrl);
  await z.ready;
  await z.send('Runtime.enable');
  await z.send('Log.enable');
  await sleep(3000);
  report.checks.zGetSettings = await evaluate(z, SAFE(`window.api.z.getSettings().then(s => s.version)`));
  report.checks.zTestKeyInvalid = await evaluate(
    z,
    SAFE(`window.api.z.testKey('AIzaSyINVALID_smoke_test_000000000000')`)
  );
  report.checks.zKeyStatusText = await evaluate(z, `(document.getElementById('cfgKeyStatus')||{}).textContent`);
  await screenshot(z, 'zentrale.png');
  desktopShot('desktop-zentrale.png');

  // Main process still responsive after both windows?
  report.checks.panelGetSettingsAfter = await evaluate(panel, SAFE(`window.api.getSettings().then(s => s.version)`));

  const pickEvents = (c) =>
    c.events
      .filter((e) => ['Runtime.exceptionThrown', 'Runtime.consoleAPICalled', 'Log.entryAdded'].includes(e.method))
      .map((e) =>
        e.method === 'Runtime.exceptionThrown'
          ? { exception: e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text }
          : e.method === 'Log.entryAdded'
            ? { log: e.params.entry.level, text: e.params.entry.text }
            : { console: e.params.type, args: e.params.args.map((a) => a.value ?? a.description) }
      );
  report.panelEvents = pickEvents(panel);
  report.zentraleEvents = pickEvents(z);
  panel.close();
  z.close();
  app.kill();
  try {
    execFileSync('taskkill', ['/F', '/T', '/IM', 'Aura.exe']);
  } catch {}
}

main()
  .catch((e) => report.errors.push(String(e && e.stack ? e.stack : e)))
  .finally(() => {
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    try {
      console.log('----- aura.log (tail) -----');
      console.log(fs.readFileSync(path.join(OUT, 'aura.log'), 'utf8').split('\n').slice(-80).join('\n'));
    } catch {}
    const c = report.checks;
    const ok = c.panelGetSettings && c.panelGetSettings.ok && c.zGetSettings && c.zGetSettings.ok && c.panelVersionText;
    process.exit(ok ? 0 : 1);
  });
