const {
  app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, clipboard,
  desktopCapturer, session, nativeImage, shell
} = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const gemini = require('./gemini');
const ollama = require('./ollama');
const keys = require('./keys');
const usage = require('./usage');
const agent = require('./agent/loop');
const agentTools = require('./agent/tools');
const agentSkills = require('./agent/skills');
const agentMcp = require('./agent/mcp');

const R = (f) => path.join(__dirname, 'renderer', f);
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const PANEL_W = 440;
const PANEL_H = 620;
const MARGIN = 4; // + 12 px Schattenrand im Panel-Fenster = 16 px Abstand
const RAMBLER_W = 420;
const RAMBLER_H = 92;

const IS_LINUX = process.platform === 'linux';

// Bis v0.3 hieß die App „Gemini Overlay“: Einstellungen, Kostenstand und den Schlüssel für
// die Verschlüsselung (Local State) einmalig in den neuen Ordner übernehmen.
function migrateFromGeminiOverlay() {
  try {
    const next = app.getPath('userData');
    const prev = path.join(app.getPath('appData'), 'Gemini Overlay');
    if (prev === next || fs.existsSync(path.join(next, 'settings.json'))) return;
    if (!fs.existsSync(path.join(prev, 'settings.json'))) return;
    fs.mkdirSync(next, { recursive: true });
    for (const f of ['settings.json', 'usage.json', 'Local State']) {
      if (fs.existsSync(path.join(prev, f))) fs.copyFileSync(path.join(prev, f), path.join(next, f));
    }
  } catch (err) {
    console.warn('Übernahme der alten Einstellungen fehlgeschlagen:', err.message);
  }
}
migrateFromGeminiOverlay();

// SharedArrayBuffer: Whisper rechnet mit mehreren Threads.
// GlobalShortcutsPortal: globale Kürzel unter Wayland (GNOME/KDE fragen einmal nach).
const features = ['SharedArrayBuffer'];
if (IS_LINUX) {
  features.push('GlobalShortcutsPortal');
  app.commandLine.appendSwitch('enable-speech-dispatcher'); // Vorlesen bei lokalem Live
}
app.commandLine.appendSwitch('enable-features', features.join(','));

let overlay, panel, ramblerBar, settingsWin, setupWin, sttWin, tray;
let panelOpen = false;
let liveActive = false;
let currentDisplay = null;
const ramblerState = { recording: false, busy: false, saved: null, selection: '', last: null };

if (!app.requestSingleInstanceLock()) app.quit();

// Befehle per Kommandozeile, z. B. für eigene Tastenkürzel in GNOME/KDE:
//   aura --toggle | --live | --rambler | --settings
function handleArgs(argv) {
  const has = (f) => argv.includes(f);
  if (has('--toggle')) toggleGemini();
  else if (has('--live')) toggleLive();
  else if (has('--rambler')) toggleRambler();
  else if (has('--settings')) openSettings();
  else return false;
  return true;
}

app.on('second-instance', (_e, argv) => {
  if (!app.isReady() || handleArgs(argv)) return;
  if (store.load().setupDone) openSettings();
  else openSetup();
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function displayUnderCursor() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function baseWindow(opts) {
  return new BrowserWindow({
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    },
    ...opts
  });
}

// ---------- Fenster ----------

function createOverlay() {
  overlay = baseWindow({ focusable: false, alwaysOnTop: true });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  // Eigene Fenster nicht mit aufnehmen (Live-Bildschirmfreigabe, Screenshots).
  overlay.setContentProtection(true);
  overlay.loadFile(R('overlay.html'));
}

function placeOverlay(display) {
  overlay.setBounds(display.bounds);
  if (!overlay.isVisible()) overlay.showInactive();
}

function createPanel() {
  panel = baseWindow({ width: PANEL_W, height: PANEL_H, alwaysOnTop: true });
  panel.setAlwaysOnTop(true, 'pop-up-menu');
  panel.setContentProtection(true);
  panel.loadFile(R('panel.html'));
  panel.on('blur', () => {
    // Wie auf dem Googlebook: Klick daneben schließt das Fenster, außer Live oder der Agent läuft.
    if (panelOpen && !liveActive && !agentRuns && !panel.webContents.isDevToolsOpened()) closePanel();
  });
}

function placePanel(display) {
  const wa = display.workArea;
  const corner = store.load().panelCorner;
  const x = corner.endsWith('left') ? wa.x + MARGIN : wa.x + wa.width - PANEL_W - MARGIN;
  const y = corner.startsWith('top') ? wa.y + MARGIN : wa.y + wa.height - PANEL_H - MARGIN;
  panel.setBounds({ x, y, width: PANEL_W, height: PANEL_H });
}

function createRamblerBar() {
  ramblerBar = baseWindow({ width: RAMBLER_W, height: RAMBLER_H, focusable: false, alwaysOnTop: true });
  ramblerBar.setAlwaysOnTop(true, 'screen-saver');
  ramblerBar.setContentProtection(true);
  ramblerBar.loadFile(R('rambler.html'));
}

function placeRamblerBar() {
  const d = displayUnderCursor();
  const wa = d.workArea;
  ramblerBar.setBounds({
    x: Math.round(wa.x + (wa.width - RAMBLER_W) / 2),
    y: wa.y + wa.height - RAMBLER_H - 24,
    width: RAMBLER_W,
    height: RAMBLER_H
  });
}

function openSetup() {
  if (setupWin && !setupWin.isDestroyed()) { setupWin.show(); setupWin.focus(); return; }
  setupWin = new BrowserWindow({
    width: 620,
    height: 720,
    title: 'Aura – Einrichtung',
    icon: ICON,
    autoHideMenuBar: true,
    backgroundColor: '#1f1f1f',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  setupWin.loadFile(R('setup.html'));
  setupWin.on('focus', () => globalShortcut.unregisterAll());
  setupWin.on('blur', () => registerHotkeys());
  setupWin.on('closed', () => { setupWin = null; registerHotkeys(); });
}

ipcMain.on('setup:done', () => {
  store.save({ setupDone: true });
  if (setupWin && !setupWin.isDestroyed()) setupWin.close();
  registerHotkeys();
  setTimeout(() => openPanel(), 400);
});

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 760,
    title: 'Aura – Einstellungen',
    icon: ICON,
    autoHideMenuBar: true,
    backgroundColor: '#1f1f1f',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  settingsWin.loadFile(R('settings.html'));
  // Beim Aufnehmen neuer Kürzel sollen die alten nicht auslösen.
  settingsWin.on('focus', () => globalShortcut.unregisterAll());
  settingsWin.on('blur', () => registerHotkeys());
  settingsWin.on('closed', () => { settingsWin = null; registerHotkeys(); });
}

// ---------- Glow und Panel ----------

function idleGlow() {
  if (liveActive) return 'live';
  return store.load().glowStay ? 'hold' : 'intro';
}

function glow(mode) {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('glow:mode', mode);
}

function openPanel({ startLive = false } = {}) {
  if (!store.ready()) {
    openSetup();
    return;
  }
  currentDisplay = displayUnderCursor();
  placeOverlay(currentDisplay);
  placePanel(currentDisplay);
  glow(idleGlow());
  panel.show();
  panel.focus();
  panelOpen = true;
  panel.webContents.send('panel:open', { startLive, corner: store.load().panelCorner });
}

function closePanel() {
  if (!panelOpen) return;
  panelOpen = false;
  if (liveActive) panel.webContents.send('live:stop');
  glow('outro');
  panel.webContents.send('panel:close');
  // Fenster erst nach der Schließ-Animation verstecken.
  setTimeout(() => { if (!panelOpen) panel.hide(); }, 260);
}

function toggleGemini() {
  if (panelOpen) closePanel();
  else openPanel();
}

function toggleLive() {
  if (panelOpen) {
    panel.webContents.send(liveActive ? 'live:stop' : 'live:start');
    if (!liveActive) { panel.show(); panel.focus(); }
  } else {
    openPanel({ startLive: true });
  }
}

// ---------- Rambler ----------

function saveClipboard() {
  const formats = clipboard.availableFormats();
  return {
    text: clipboard.readText(),
    html: formats.includes('text/html') ? clipboard.readHTML() : '',
    image: formats.some((f) => f.startsWith('image/')) ? clipboard.readImage() : null
  };
}

function restoreClipboard(saved) {
  if (!saved) return;
  if (saved.image && !saved.image.isEmpty()) clipboard.writeImage(saved.image);
  else if (saved.html) clipboard.write({ text: saved.text, html: saved.html });
  else if (saved.text) clipboard.writeText(saved.text);
  else clipboard.clear();
}

function ramblerSend(channel, data) {
  if (ramblerBar && !ramblerBar.isDestroyed()) ramblerBar.webContents.send(channel, data);
}

async function toggleRambler() {
  if (ramblerState.busy) return;
  if (!store.ready()) { openSetup(); return; }
  if (ramblerState.recording) {
    ramblerState.recording = false;
    ramblerSend('rambler:stop');
    return;
  }
  ramblerState.busy = true;
  try {
    // Markierten Text holen: Zwischenablage sichern, Strg+C senden, lesen, wiederherstellen.
    const saved = saveClipboard();
    clipboard.clear();
    const sent = await keys.send('^c');
    await sleep(120);
    const selection = sent ? clipboard.readText() : '';
    ramblerState.canType = sent;
    restoreClipboard(saved);
    ramblerState.selection = selection;
    placeRamblerBar();
    ramblerBar.showInactive();
    ramblerState.recording = true;
    ramblerSend('rambler:start', { selection: !!selection });
  } finally {
    ramblerState.busy = false;
  }
}

// Fügt Text ins aktive Feld ein. Ohne Tastenwerkzeug (Linux ohne xdotool/wtype)
// bleibt er in der Zwischenablage; Rückgabe false = selbst einfügen.
async function pasteText(text) {
  const saved = saveClipboard();
  clipboard.writeText(text);
  const sent = await keys.send('^v');
  if (!sent) return false;
  await sleep(350);
  restoreClipboard(saved);
  return true;
}

function hideRamblerBarSoon(ms) {
  clearTimeout(ramblerState.hideTimer);
  ramblerState.hideTimer = setTimeout(() => {
    if (!ramblerState.recording) ramblerBar.hide();
  }, ms);
}

ipcMain.on('rambler:audio', async (_e, { wavBase64 }) => {
  ramblerState.recording = false;
  if (!wavBase64) { ramblerBar.hide(); return; }
  ramblerSend('rambler:state', { state: 'processing' });
  try {
    const over = budgetError();
    if (over) throw new Error(over);
    const s = store.load();
    let out;
    if (store.isLocal()) {
      const transcript = await transcribe(wavBase64);
      if (!transcript) throw new Error('Nichts verstanden.');
      out = await ollama.rambler({ url: s.ollamaUrl, model: s.ollamaModel, transcript, selection: ramblerState.selection, language: s.language });
    } else {
      out = await gemini.rambler({
        apiKey: store.getApiKey(),
        model: s.ramblerModel,
        wavBase64,
        selection: ramblerState.selection,
        language: s.language
      });
      usage.addTokens(s.ramblerModel, out.usage);
      broadcastUsage();
    }
    if (!out.text) throw new Error('Nichts verstanden.');
    const pasted = await pasteText(out.text);
    ramblerState.last = { ...out, fullAvailable: !ramblerState.selection };
    if (!pasted) {
      ramblerSend('rambler:state', { state: 'error', message: 'In der Zwischenablage – mit Strg+V einfügen (xdotool/wtype fehlt)' });
      hideRamblerBarSoon(7000);
      return;
    }
    ramblerSend('rambler:state', { state: 'done', fullAvailable: !ramblerState.selection });
    hideRamblerBarSoon(7000);
  } catch (err) {
    ramblerSend('rambler:state', { state: 'error', message: String(err.message || err) });
    hideRamblerBarSoon(5000);
  }
});

ipcMain.on('rambler:cancel', () => {
  ramblerState.recording = false;
  ramblerBar.hide();
});

ipcMain.on('rambler:undo', async () => {
  await keys.send('^z');
  ramblerBar.hide();
});

ipcMain.on('rambler:full', async () => {
  if (!ramblerState.last) return;
  await keys.send('^z');
  await pasteText(ramblerState.last.transcript);
  ramblerBar.hide();
});

ipcMain.on('rambler:error', (_e, message) => {
  ramblerState.recording = false;
  ramblerSend('rambler:state', { state: 'error', message });
  hideRamblerBarSoon(5000);
});

// ---------- Bildschirm ----------

// Unter Wayland liefert desktopCapturer keine brauchbaren Vorschaubilder; dann über eine
// dauerhafte Bildschirmfreigabe im Panel (fragt das System einmal, nicht bei jedem Bild).
const USE_STREAM_CAPTURE = IS_LINUX && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY || process.env.AURA_SCREEN_STREAM === '1');

async function grabViaPanel(maxWidth) {
  if (!panel || panel.isDestroyed()) throw new Error('Aura-Fenster nicht bereit.');
  const r = await panel.webContents.executeJavaScript(`window.__grabScreen(${Number(maxWidth) || 1600})`, true);
  if (!r || r.error) throw new Error('Bildschirmaufnahme fehlgeschlagen: ' + ((r && r.error) || 'unbekannt') +
    (IS_LINUX ? ' (Unter Wayland muss die Freigabe im System-Dialog bestätigt werden.)' : ''));
  return r.jpeg;
}

async function screenshotJpeg(display, maxWidth = 1600) {
  if (USE_STREAM_CAPTURE) return grabViaPanel(maxWidth);
  const d = display || displayUnderCursor();
  const scale = Math.min(1, maxWidth / d.size.width);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(d.size.width * d.scaleFactor * scale),
      height: Math.round(d.size.height * d.scaleFactor * scale)
    }
  });
  const src = sources.find((s) => s.display_id === String(d.id)) || sources[0];
  if (!src || src.thumbnail.isEmpty()) {
    if (IS_LINUX) return grabViaPanel(maxWidth);
    throw new Error('Bildschirmaufnahme fehlgeschlagen.');
  }
  return src.thumbnail.toJPEG(75).toString('base64');
}

// ---------- Kosten ----------

function usageSummary() {
  return { ...usage.summary(store.load().monthlyBudgetUsd), local: store.isLocal() };
}

function broadcastUsage() {
  const u = usageSummary();
  for (const w of [panel, settingsWin]) if (w && !w.isDestroyed()) w.webContents.send('usage:update', u);
  return u;
}

function budgetError() {
  if (store.isLocal()) return null; // lokale Modelle kosten nichts
  const u = usageSummary();
  if (!u.overBudget) return null;
  return `Monatsbudget von ${u.budgetUsd.toFixed(2)} $ erreicht (geschätzt ${u.costUsd.toFixed(2)} $). ` +
    'Du kannst es in den Einstellungen erhöhen.';
}

// ---------- IPC ----------

const CHAT_SYSTEM = (lang) =>
  `Du bist Aura, ein Assistent in einem kompakten Overlay auf einem ${IS_LINUX ? 'Linux-' : 'Windows-'}PC. Antworte kurz, klar und freundlich, ` +
  `standardmäßig auf ${lang}. Nutze Markdown sparsam (kurze Listen, **fett**, \`code\`). ` +
  'Wenn ein Screenshot beiliegt, beziehe dich konkret auf das, was zu sehen ist.';

const chatAborts = new Map();

ipcMain.handle('settings:get', () => store.publicSettings());

ipcMain.handle('settings:save', (_e, patch) => {
  const { apiKey, ...rest } = patch || {};
  if (apiKey !== undefined) store.setApiKey(apiKey);
  store.save(rest);
  ollama.setContextSize(store.load().ollamaContext);
  const failed = registerHotkeys();
  applyAutostart();
  broadcastUsage();
  preloadStt().catch(() => {});
  return { settings: store.publicSettings(), failedHotkeys: failed };
});

ipcMain.handle('settings:testKey', async (_e, key) => {
  try {
    await gemini.testKey((key || '').trim() || store.getApiKey());
    return { ok: true };
  } catch (err) {
    return { ok: false, message: String(err.message || err) };
  }
});

ipcMain.on('settings:open', () => openSettings());
ipcMain.on('open:external', (_e, url) => {
  if (/^https:\/\//.test(url)) shell.openExternal(url);
});

ipcMain.on('chat:send', async (e, { id, history, includeScreen }) => {
  const ctrl = new AbortController();
  chatAborts.set(id, ctrl);
  try {
    const over = budgetError();
    if (over) throw new Error(over);
    const s = store.load();
    const contents = JSON.parse(JSON.stringify(history));
    if (includeScreen) {
      const jpeg = await screenshotJpeg(currentDisplay);
      contents[contents.length - 1].parts.unshift({ inlineData: { mimeType: 'image/jpeg', data: jpeg } });
      e.sender.send('chat:screen', { id, jpeg });
    }
    const onText = (t) => e.sender.send('chat:chunk', { id, text: t });
    if (s.agentEnabled) {
      await runAgent(e.sender, id, ctrl, contents, onText);
    } else if (store.isLocal()) {
      await ollama.streamChat({ url: s.ollamaUrl, model: s.ollamaModel, history: contents, system: CHAT_SYSTEM(s.language), signal: ctrl.signal, onText });
    } else {
      const res = await gemini.streamChat({
        apiKey: store.getApiKey(),
        model: s.chatModel,
        history: contents,
        system: CHAT_SYSTEM(s.language),
        signal: ctrl.signal,
        onText
      });
      usage.addTokens(s.chatModel, res.usage);
      broadcastUsage();
    }
    e.sender.send('chat:done', { id });
  } catch (err) {
    if (err.name === 'AbortError') e.sender.send('chat:done', { id });
    else e.sender.send('chat:error', { id, message: String(err.message || err) });
  } finally {
    chatAborts.delete(id);
  }
});

ipcMain.on('chat:abort', (_e, id) => {
  const c = chatAborts.get(id);
  if (c) c.abort();
});

// ---------- Agent ----------

const approvals = new Map(); // Schritt-ID → resolve(true/false)
let agentRuns = 0;

async function runAgent(sender, id, ctrl, contents, onText) {
  const s = store.load();
  const send = (ch, data) => { if (!sender.isDestroyed()) sender.send(ch, data); };
  let allowAll = false; // „Alle erlauben“ gilt bis zum Ende dieses Auftrags
  const approve = (step) => new Promise((resolve) => {
    if (ctrl.signal.aborted) return resolve(false);
    if (allowAll) return resolve(true);
    approvals.set(step.id, (ok) => { if (ok === 'all') allowAll = true; resolve(!!ok); });
    ctrl.signal.addEventListener('abort', () => { approvals.delete(step.id); resolve(false); }, { once: true });
    send('agent:approve', { chatId: id, ...step });
    if (panel && !panelOpen) openPanel();
  });
  const opts = {
    history: contents,
    language: s.language,
    onText,
    onStep: (step) => send('agent:step', { chatId: id, ...step }),
    approve,
    signal: ctrl.signal,
    ctx: {
      screenshot: () => screenshotJpeg(currentDisplay),
      // 0–1000 im Bildschirmfoto → echte Bildschirm-Pixel
      toScreen: (x, y) => {
        const d = currentDisplay || displayUnderCursor();
        const dip = { x: d.bounds.x + (x / 1000) * d.bounds.width, y: d.bounds.y + (y / 1000) * d.bounds.height };
        if (process.platform === 'win32') return screen.dipToScreenPoint(dip);
        return { x: dip.x * d.scaleFactor, y: dip.y * d.scaleFactor };
      }
    }
  };
  agentRuns++;
  registerStopHotkey();
  try {
    if (store.isLocal()) {
      await agent.runOllama({ ...opts, url: s.ollamaUrl, model: s.ollamaModel });
    } else {
      await agent.runGemini({
        ...opts,
        apiKey: store.getApiKey(),
        model: s.chatModel,
        onUsage: (u) => { usage.addTokens(s.chatModel, u); broadcastUsage(); }
      });
    }
  } finally {
    agentRuns--;
    registerStopHotkey();
  }
}

ipcMain.on('agent:approval', (_e, { stepId, ok }) => {
  const r = approvals.get(stepId);
  if (r) { approvals.delete(stepId); r(ok === 'all' ? 'all' : !!ok); }
});

// Notbremse: alle laufenden Aufträge abbrechen und gestartete Befehle beenden.
function stopAgent() {
  for (const c of chatAborts.values()) c.abort();
  agentTools.killAll();
  if (panel && !panel.isDestroyed()) panel.webContents.send('agent:stopped');
}
ipcMain.on('agent:stop', () => stopAgent());
ipcMain.on('agent:openLog', () => {
  const f = agent.logFile();
  if (!fs.existsSync(f)) fs.writeFileSync(f, '');
  shell.openPath(f);
});

// Erweiterungen: AGENTS.md, Skills-Ordner, MCP-Server.
ipcMain.handle('agent:extensions', async (_e, force) => {
  try { await agentMcp.sync(!!force); } catch {}
  return {
    builtin: agentTools.TOOLS.map((t) => t.name),
    skills: agentSkills.list().map((x) => ({ name: x.name, description: x.description })),
    mcp: agentMcp.status(),
    hasAgentsMd: !!agentSkills.promptAddon().includes('AGENTS.md'),
    auraDir: agentSkills.auraDir()
  };
});
ipcMain.on('agent:openFile', (_e, which) => {
  agentSkills.ensureFiles();
  if (which === 'agents') shell.openPath(agentSkills.agentsFile());
  else if (which === 'skills') shell.openPath(path.join(agentSkills.auraDir(), 'skills'));
  else if (which === 'mcp') {
    const f = agentMcp.configFile();
    if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({ mcpServers: {} }, null, 2) + '\n');
    shell.openPath(f);
  }
});
app.on('will-quit', () => agentMcp.closeAll());

// Das Notbremse-Kürzel ist nur aktiv, solange der Agent arbeitet.
let stopKeyOn = null;
function registerStopHotkey() {
  const acc = store.load().hotkeyStop;
  if (stopKeyOn) { try { globalShortcut.unregister(stopKeyOn); } catch {} stopKeyOn = null; }
  if (agentRuns > 0 && acc) {
    try { if (globalShortcut.register(acc, stopAgent)) stopKeyOn = acc; } catch {}
  }
}

ipcMain.handle('usage:get', () => usageSummary());

ipcMain.on('live:usage', (_e, secs) => {
  usage.addLive(secs || {});
  const u = broadcastUsage();
  if (u.overBudget && liveActive && panel) panel.webContents.send('live:stop', budgetError());
});

ipcMain.handle('live:config', () => {
  const over = budgetError();
  if (over) return { error: over };
  const s = store.load();
  if (store.isLocal()) return { provider: 'ollama', model: s.ollamaModel, language: s.language };
  return {
    provider: 'gemini',
    apiKey: store.getApiKey(),
    model: s.liveModel,
    voice: s.liveVoice,
    language: s.language,
    fps: Number(s.liveFps) || 1
  };
});

ipcMain.on('live:active', (_e, active) => {
  liveActive = !!active;
  glow(liveActive ? 'live' : panelOpen ? idleGlow() : 'outro');
  if (!liveActive && overlay) overlay.webContents.send('pointer:clear');
});

ipcMain.on('glow:level', (_e, level) => {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('glow:level', level);
});

ipcMain.on('pointer:show', (_e, p) => {
  if (!overlay || overlay.isDestroyed()) return;
  if (currentDisplay) placeOverlay(currentDisplay);
  overlay.webContents.send('pointer:show', p);
});

ipcMain.on('pointer:clear', () => overlay && overlay.webContents.send('pointer:clear'));

ipcMain.on('panel:hide', () => closePanel());

// Overlay meldet, dass weder Glow noch Hinweise sichtbar sind: ganz ausblenden.
ipcMain.on('overlay:idle', () => {
  if (overlay && !overlay.isDestroyed() && !panelOpen && !liveActive) overlay.hide();
});

ipcMain.on('panel:ignoreMouse', (_e, ignore) => {
  if (panel && !panel.isDestroyed()) panel.setIgnoreMouseEvents(!!ignore, { forward: true });
});

// ---------- Lokal: Whisper und Ollama ----------

let sttReady = null;
const sttJobs = new Map();
let sttSeq = 0;

function ensureStt() {
  if (sttWin && !sttWin.isDestroyed()) return sttReady;
  sttWin = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, backgroundThrottling: false }
  });
  sttReady = new Promise((resolve) => ipcMain.once('stt:ready', resolve));
  sttWin.loadFile(R('stt.html'));
  sttWin.on('closed', () => {
    sttWin = null;
    sttJobs.forEach((j) => j.reject(new Error('Spracherkennung beendet.')));
    sttJobs.clear();
  });
  return sttReady;
}

// Lädt das Whisper-Modell vorab, damit die erste Spracheingabe nicht warten muss.
async function preloadStt() {
  if (!store.isLocal()) return;
  await ensureStt();
  sttWin.webContents.send('stt:preload', { model: store.load().whisperModel });
}

async function transcribe(wavBase64) {
  await ensureStt();
  const id = ++sttSeq;
  return new Promise((resolve, reject) => {
    sttJobs.set(id, { resolve, reject });
    sttWin.webContents.send('stt:request', { id, wavBase64, model: store.load().whisperModel });
  });
}

ipcMain.on('stt:result', (_e, { id, text, error }) => {
  const job = sttJobs.get(id);
  if (!job) return;
  sttJobs.delete(id);
  if (error) job.reject(new Error('Spracherkennung: ' + error));
  else job.resolve(text);
});

// Fortschritt beim ersten Laden des Whisper-Modells an Rambler und Panel weitergeben.
ipcMain.on('stt:progress', (_e, p) => {
  for (const w of [ramblerBar, panel, settingsWin, setupWin]) if (w && !w.isDestroyed()) w.webContents.send('stt:progress', p);
});

const liveAborts = new Map();

// Ein Durchgang von lokalem Live: Sprache → Text (Whisper) → Antwort mit Bildschirmfoto (Ollama).
ipcMain.handle('live:turn', async (_e, { id, wavBase64, history, screen: withScreen }) => {
  const ctrl = new AbortController();
  liveAborts.set(id, ctrl);
  try {
    const question = await transcribe(wavBase64);
    if (!question || question.length < 2) return { empty: true };
    if (panel && !panel.isDestroyed()) panel.webContents.send('live:heard', { id, text: question });
    const jpeg = withScreen ? await screenshotJpeg(currentDisplay, 1280) : null;
    const s = store.load();
    const out = await ollama.liveTurn({ url: s.ollamaUrl, model: s.ollamaModel, language: s.language, history, question, jpeg, signal: ctrl.signal });
    return { question, ...out };
  } catch (err) {
    if (err.name === 'AbortError') return { aborted: true };
    return { error: String(err.message || err) };
  } finally {
    liveAborts.delete(id);
  }
});

ipcMain.on('live:abortTurn', () => liveAborts.forEach((c) => c.abort()));

ipcMain.handle('ollama:status', async (_e, url) => {
  const u = url || store.load().ollamaUrl;
  try {
    const v = await ollama.version(u);
    const models = await ollama.listModels(u);
    return { ok: true, version: v, models, recommended: ollama.RECOMMENDED };
  } catch (err) {
    return { ok: false, message: String(err.message || err), recommended: ollama.RECOMMENDED };
  }
});

let pullCtrl = null;
ipcMain.handle('ollama:pull', async (e, { url, name }) => {
  pullCtrl = new AbortController();
  try {
    await ollama.pull(url || store.load().ollamaUrl, name, (p) => {
      if (!e.sender.isDestroyed()) e.sender.send('ollama:progress', { name, status: p.status, completed: p.completed, total: p.total });
    }, pullCtrl.signal);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.name === 'AbortError' ? 'Abgebrochen.' : String(err.message || err) };
  } finally {
    pullCtrl = null;
  }
});
ipcMain.on('ollama:abortPull', () => pullCtrl && pullCtrl.abort());

// ---------- Hotkeys, Tray, Autostart ----------

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const s = store.load();
  const failed = [];
  const reg = (acc, fn, name) => {
    if (!acc) return;
    try {
      if (!globalShortcut.register(acc, fn)) failed.push(`${name} (${acc})`);
    } catch {
      failed.push(`${name} (${acc})`);
    }
  };
  reg(s.hotkeyGemini, toggleGemini, 'Aura');
  reg(s.hotkeyRambler, toggleRambler, 'Rambler');
  reg(s.hotkeyLive, toggleLive, 'Live');
  stopKeyOn = null;
  registerStopHotkey();
  return failed;
}

// Linux: Eintrag in ~/.config/autostart (AppImage-Pfad, sonst das installierte Programm).
function applyAutostartLinux(on) {
  const dir = path.join(app.getPath('appData'), 'autostart');
  const file = path.join(dir, 'aura.desktop');
  fs.rmSync(path.join(dir, 'gemini-overlay.desktop'), { force: true }); // Name bis v0.3
  if (!on) { fs.rmSync(file, { force: true }); return; }
  const exe = process.env.APPIMAGE || process.execPath;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Aura',
    `Exec="${exe}"`,
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n'));
}

function applyAutostart() {
  if (!app.isPackaged) return; // Im Entwicklungsmodus nicht die electron.exe eintragen.
  if (IS_LINUX) {
    try { applyAutostartLinux(!!store.load().autostart); } catch (err) { console.warn('Autostart:', err.message); }
    return;
  }
  // Die portable .exe entpackt sich in einen Temp-Ordner; eingetragen wird die Original-Datei.
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  // Autostart-Einträge der alten „Gemini Overlay“ entfernen, sonst startet die alte Version mit.
  for (const name of ['electron.app.Gemini Overlay', 'Gemini Overlay']) {
    app.setLoginItemSettings({ openAtLogin: false, name });
  }
  app.setLoginItemSettings({ openAtLogin: !!store.load().autostart, path: exe });
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'));
  tray = new Tray(img);
  tray.setToolTip('Aura');
  const s = () => store.load();
  const menu = () => Menu.buildFromTemplate([
    { label: `Aura öffnen\t${s().hotkeyGemini}`, click: () => openPanel() },
    { label: `Live\t${s().hotkeyLive}`, click: () => toggleLive() },
    { label: `Rambler: ${s().hotkeyRambler} im Textfeld`, enabled: false },
    { type: 'separator' },
    store.isLocal()
      ? { label: `Lokal über Ollama: ${s().ollamaModel}`, enabled: false }
      : { label: `Diesen Monat: ≈ ${usageSummary().costUsd.toFixed(2)} $ von ${Number(s().monthlyBudgetUsd).toFixed(2)} $`, enabled: false },
    ...(agentRuns > 0 ? [{ label: `Agent stoppen\t${s().hotkeyStop}`, click: () => stopAgent() }] : []),
    { label: 'Aktionsprotokoll öffnen', click: () => ipcMain.emit('agent:openLog') },
    { label: 'Einstellungen …', click: () => openSettings() },
    { label: 'Einrichtung erneut starten …', click: () => openSetup() },
    { label: 'Beenden', click: () => app.quit() }
  ]);
  tray.on('click', () => openPanel());
  tray.on('right-click', () => tray.popUpContextMenu(menu()));
}

app.whenReady().then(() => {
  ollama.setContextSize(store.load().ollamaContext);
  // Mikrofon für Live/Rambler erlauben.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media' || perm === 'display-capture'));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'media' || perm === 'display-capture');
  // Bildschirmfreigabe ohne Auswahldialog: der Bildschirm, auf dem das Panel offen ist.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    const d = currentDisplay || displayUnderCursor();
    cb({ video: sources.find((x) => x.display_id === String(d.id)) || sources[0] });
  });

  createOverlay();
  createPanel();
  createRamblerBar();
  createTray();
  keys.ensure();
  const failed = registerHotkeys();
  applyAutostart();

  if (!store.load().setupDone || !store.ready()) openSetup();
  else if (!handleArgs(process.argv) && failed.length) openSettings();
  preloadStt().catch(() => {});
  screen.on('display-removed', () => { currentDisplay = null; });
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  keys.shutdown();
});
