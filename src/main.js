const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  Tray,
  Menu,
  clipboard,
  desktopCapturer,
  session,
  nativeImage,
  shell,
  Notification,
  safeStorage
} = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const gemini = require('./gemini');
const ollama = require('./ollama');
const keys = require('./keys');
const usage = require('./usage');
const chats = require('./chats');
const zentrale = require('./zentrale');
const agent = require('./agent/loop');
const agentTools = require('./agent/tools');
const agentInput = require('./agent/input');
const agentSkills = require('./agent/skills');
const agentMcp = require('./agent/mcp');
const secrets = require('./secrets');
const connectors = require('./connectors');
const { createScheduler, runPrompt, isNothingNew } = require('./scheduler');
const { createInbox } = require('./inbox');
const sandbox = require('./sandbox');
const web = require('./web');
const { createOAuthClient } = require('./oauth');
const { enableWeakIfAllowed } = require('./keystore');
const security = require('./security');
const { LiveRelay } = require('./live-relay');
security.guardIpc(ipcMain); // vor der ersten IPC-Registrierung (AURA-18)
const { AgentBridge, defaultAuraDir } = require('./agent2/bridge');
const zentraleV2 = require('./agent2/zentrale-v2');
// Secrets filled in, then catalog/registry servers wrapped in the sandbox (AURA-97).
agentMcp.setResolver((c, name) => sandbox.wrap(name, builtinConfig(secrets.resolveServerConfig(c))));
// Connectors shipped with Aura run with Aura's Python (AURA-98); agentV2 is defined further down, used lazily.
function builtinConfig(cfg) {
  if (!cfg || !cfg.builtin) return cfg;
  const dev = !app.isPackaged ? path.join(app.getAppPath(), 'agent', 'src') : undefined;
  return connectors.resolveBuiltin(cfg, agentV2.pythonPath(), dev);
}

const R = (f) => path.join(__dirname, 'renderer', f);
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const PANEL_W = 440;
const PANEL_H = 620;
const PANEL_MIN_W = 304;
const PANEL_MIN_H = 68;
const MARGIN = 4; // + 12 px Schattenrand im Panel-Fenster = 16 px Abstand
const RAMBLER_W = 420;
const RAMBLER_H = 92;

const IS_LINUX = process.platform === 'linux';
const WAYLAND = IS_LINUX && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);

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
let panelMinimized = false;
let liveActive = false;
let currentDisplay = null;
const ramblerState = { recording: false, busy: false, saved: null, selection: '', last: null };

if (!app.requestSingleInstanceLock()) app.quit();

// Befehle per Kommandozeile, z. B. für eigene Tastenkürzel in GNOME/KDE:
//   aura --toggle | --live | --rambler | --settings | --zentrale | --zentrale-web
function handleArgs(argv) {
  const has = (f) => argv.includes(f);
  if (has('--toggle')) toggleGemini();
  else if (has('--live')) toggleLive();
  else if (has('--rambler')) toggleRambler();
  else if (has('--settings')) openSettings();
  else if (has('--zentrale-web')) web.open();
  else if (has('--zentrale')) zentrale.open(ICON);
  else return false;
  return true;
}

app.on('second-instance', (_e, argv) => {
  if (!app.isReady() || handleArgs(argv)) return;
  if (store.load().setupDone) openSettings();
  else openSetup();
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function displayUnderCursor() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

// preload: jedes Fenster bekommt nur die Funktionen, die es braucht (AURA-18).
function baseWindow({ preload = 'preload.js', ...opts }) {
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
      preload: path.join(__dirname, preload),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    },
    ...opts
  });
}

// ---------- Fenster ----------

function createOverlay() {
  overlay = baseWindow({ focusable: false, alwaysOnTop: true, preload: 'preload-overlay.js' });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  // Eigene Fenster nicht mit aufnehmen (Live-Bildschirmfreigabe, Screenshots).
  overlay.setContentProtection(true);
  overlay.loadFile(R('overlay.html'));
}

function placeOverlay(display) {
  // Unter Wayland lässt sich ein Fenster nicht zuverlässig klick-durchlässig machen und nicht
  // „immer im Vordergrund“ halten: das bildschirmgroße Leucht-Fenster würde dort Klicks und
  // Mausrad im Aura-Fenster abfangen. Deshalb gibt es dort keinen leuchtenden Rand.
  if (WAYLAND) return;
  overlay.setBounds(display.bounds);
  if (!overlay.isVisible()) overlay.showInactive();
}

function createPanel() {
  panel = baseWindow({ width: PANEL_W, height: PANEL_H, alwaysOnTop: true });
  panel.setAlwaysOnTop(true, 'pop-up-menu');
  panel.setContentProtection(true);
  panel.loadFile(R('panel.html'));
  panel.on('blur', () => {
    // Klick daneben minimiert das Fenster in die untere rechte Ecke, statt es ganz verschwinden zu lassen.
    if (
      panelOpen &&
      !panelMinimized &&
      !liveActive &&
      !agentRuns &&
      !panelBusy &&
      !panel.webContents.isDevToolsOpened()
    )
      minimizePanel();
  });
}

// Panel size: default or what the user dragged/toggled, kept inside the work area.
function panelDims(wa) {
  const s = store.load().panelSize || {};
  const w = Math.round(Math.min(Math.max(Number(s.w) || PANEL_W, 380), wa.width - 2 * MARGIN));
  const h = Math.round(Math.min(Math.max(Number(s.h) || PANEL_H, 420), wa.height - 2 * MARGIN));
  return { w, h };
}

function placePanel(display) {
  const wa = display.workArea;
  const corner = store.load().panelCorner;
  const { w, h } = panelMinimized ? { w: PANEL_MIN_W, h: PANEL_MIN_H } : panelDims(wa);
  // Anchored to its corner: a bigger panel grows towards the middle of the screen.
  const x = corner.endsWith('left') ? wa.x + MARGIN : wa.x + wa.width - w - MARGIN;
  const y = corner.startsWith('top') ? wa.y + MARGIN : wa.y + wa.height - h - MARGIN;
  panel.setBounds({ x, y, width: w, height: h });
}

// Resize from the panel (grip or enlarge button).
ipcMain.handle('panel:setSize', (_e, size) => {
  const d = screen.getDisplayMatching(panel.getBounds());
  if (size === 'default') store.save({ panelSize: null });
  else if (size === 'large')
    store.save({ panelSize: { w: Math.min(820, d.workArea.width - 2 * MARGIN), h: d.workArea.height - 2 * MARGIN } });
  else if (size && Number.isFinite(Number(size.w)) && Number.isFinite(Number(size.h)))
    store.save({ panelSize: { w: Number(size.w), h: Number(size.h) } });
  placePanel(d);
  const b = panel.getBounds();
  return { w: b.width, h: b.height, large: b.width > PANEL_W + 40 || b.height > PANEL_H + 40 };
});
ipcMain.handle('panel:getSize', () => {
  const b = panel.getBounds();
  return { w: b.width, h: b.height, large: b.width > PANEL_W + 40 || b.height > PANEL_H + 40 };
});

function createRamblerBar() {
  ramblerBar = baseWindow({
    width: RAMBLER_W,
    height: RAMBLER_H,
    focusable: false,
    alwaysOnTop: true,
    preload: 'preload-rambler.js'
  });
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
  if (setupWin && !setupWin.isDestroyed()) {
    setupWin.show();
    setupWin.focus();
    return;
  }
  setupWin = new BrowserWindow({
    width: 620,
    height: 720,
    title: 'Aura – Einrichtung',
    icon: ICON,
    autoHideMenuBar: true,
    backgroundColor: '#131314',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  setupWin.loadFile(R('setup.html'));
  setupWin.on('focus', () => globalShortcut.unregisterAll());
  setupWin.on('blur', () => registerHotkeys());
  setupWin.on('closed', () => {
    setupWin = null;
    registerHotkeys();
  });
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
    width: 620,
    height: 780,
    title: 'Aura – Einstellungen',
    icon: ICON,
    autoHideMenuBar: true,
    backgroundColor: '#131314',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  settingsWin.loadFile(R('settings.html'));
  // Beim Aufnehmen neuer Kürzel sollen die alten nicht auslösen.
  settingsWin.on('focus', () => globalShortcut.unregisterAll());
  settingsWin.on('blur', () => registerHotkeys());
  settingsWin.on('closed', () => {
    settingsWin = null;
    registerHotkeys();
  });
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
  panelMinimized = false;
  currentDisplay = displayUnderCursor();
  placeOverlay(currentDisplay);
  placePanel(currentDisplay);
  glow(idleGlow());
  panel.show();
  panel.focus();
  panelOpen = true;
  panel.webContents.send('panel:open', { startLive, corner: store.load().panelCorner });
}

function minimizePanel() {
  if (!panelOpen || panelMinimized) return;
  panelMinimized = true;
  if (liveActive) panel.webContents.send('live:stop');
  glow('outro');
  const d = currentDisplay || screen.getDisplayMatching(panel.getBounds());
  placePanel(d);
  panel.webContents.send('panel:minimize', { corner: store.load().panelCorner });
  if (!panel.isVisible()) panel.showInactive();
}

function restorePanel() {
  if (!panelOpen) {
    openPanel();
    return;
  }
  if (!panelMinimized) {
    panel.show();
    panel.focus();
    return;
  }
  panelMinimized = false;
  currentDisplay = currentDisplay || displayUnderCursor();
  placeOverlay(currentDisplay);
  placePanel(currentDisplay);
  glow(idleGlow());
  panel.show();
  panel.focus();
  panel.webContents.send('panel:restore', { corner: store.load().panelCorner });
}

function closePanel() {
  if (!panelOpen) return;
  panelOpen = false;
  panelMinimized = false;
  if (liveActive) panel.webContents.send('live:stop');
  glow('outro');
  panel.webContents.send('panel:close');
  // Fenster erst nach der Schließ-Animation verstecken.
  setTimeout(() => {
    if (!panelOpen) panel.hide();
  }, 260);
}

function toggleGemini() {
  if (!panelOpen) openPanel();
  else if (panelMinimized) restorePanel();
  else minimizePanel();
}

function toggleLive() {
  if (panelOpen && !panelMinimized) {
    panel.webContents.send(liveActive ? 'live:stop' : 'live:start');
    if (!liveActive) {
      panel.show();
      panel.focus();
    }
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
  if (!store.ready()) {
    openSetup();
    return;
  }
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
  if (!wavBase64) {
    ramblerBar.hide();
    return;
  }
  ramblerSend('rambler:state', { state: 'processing' });
  try {
    const over = budgetError();
    if (over) throw new Error(over);
    const s = store.load();
    let out;
    if (store.isLocal()) {
      const transcript = await transcribe(wavBase64);
      if (!transcript) throw new Error('Nichts verstanden.');
      out = await ollama.rambler({
        url: s.ollamaUrl,
        model: s.ollamaModel,
        transcript,
        selection: ramblerState.selection,
        language: s.language
      });
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
      ramblerSend('rambler:state', {
        state: 'error',
        message: 'In der Zwischenablage – mit Strg+V einfügen (xdotool/wtype fehlt)'
      });
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
const USE_STREAM_CAPTURE =
  IS_LINUX &&
  (process.env.XDG_SESSION_TYPE === 'wayland' ||
    !!process.env.WAYLAND_DISPLAY ||
    process.env.AURA_SCREEN_STREAM === '1');

async function grabViaPanel(maxWidth) {
  if (!panel || panel.isDestroyed()) throw new Error('Aura-Fenster nicht bereit.');
  const r = await panel.webContents.executeJavaScript(`window.__grabScreen(${Number(maxWidth) || 1600})`, true);
  if (!r || r.error)
    throw new Error(
      'Bildschirmaufnahme fehlgeschlagen: ' +
        ((r && r.error) || 'unbekannt') +
        (IS_LINUX ? ' (Unter Wayland muss die Freigabe im System-Dialog bestätigt werden.)' : '')
    );
  return r.jpeg;
}

// Der Agent sieht den Bildschirm (Werkzeug screenshot, T0): Ist das Panel offen, zeigt es den Schritt ohnehin.
// Sonst ein Hinweis, höchstens einmal pro Minute, damit es nicht unbemerkt geschieht (AURA-62).
let lastScreenshotNotice = 0;
function noteAgentScreenshot() {
  if (panel && panelOpen && panel.isVisible()) return;
  if (Date.now() - lastScreenshotNotice < 60000 || !Notification.isSupported()) return;
  lastScreenshotNotice = Date.now();
  new Notification({
    title: 'Aura',
    body: 'Aura hat für die laufende Aufgabe ein Bildschirmfoto gemacht.',
    icon: ICON,
    silent: true
  }).show();
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
  return (
    `Monatsbudget von ${u.budgetUsd.toFixed(2)} $ erreicht (geschätzt ${u.costUsd.toFixed(2)} $). ` +
    'Du kannst es in den Einstellungen erhöhen.'
  );
}

// ---------- IPC ----------

const CHAT_SYSTEM = (lang) =>
  `Du bist Aura, ein Assistent in einem kompakten Overlay auf einem ${IS_LINUX ? 'Linux-' : 'Windows-'}PC. Antworte kurz, klar und freundlich, ` +
  `standardmäßig auf ${lang}. Nutze Markdown sparsam (kurze Listen, **fett**, \`code\`). ` +
  'Wenn ein Screenshot beiliegt, beziehe dich konkret auf das, was zu sehen ist.' +
  (store.profilePrompt() ? '\n\n' + store.profilePrompt() : '');

const chatAborts = new Map();

ipcMain.handle('settings:get', () => store.publicSettings());

ipcMain.handle('settings:save', (_e, patch) => {
  const { apiKey, ...rest } = patch || {};
  let keyError = '';
  // eslint-disable-next-line security/detect-possible-timing-attacks -- presence check, not a secret comparison
  if (apiKey !== undefined) {
    try {
      store.setApiKey(apiKey);
    } catch (err) {
      keyError = err instanceof Error ? err.message : String(err); // no keyring: the key is not stored (AURA-93)
    }
  }
  store.save(rest);
  ollama.setContextSize(store.load().ollamaContext);
  const failed = registerHotkeys();
  applyAutostart();
  broadcastUsage();
  preloadStt().catch(() => {});
  return { settings: store.publicSettings(), failedHotkeys: failed, ...(keyError ? { keyError } : {}) };
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

ipcMain.on('chat:send', async (e, { id, chatId, history, includeScreen, incognito }) => {
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
    if (s.agentEnabled && agentVersion() === 'v2' && agentV2.available()) {
      await runAgentV2(e.sender, id, chatId || id, ctrl, contents, onText, !!incognito);
    } else if (s.agentEnabled) {
      await runAgent(e.sender, id, ctrl, contents, onText);
    } else if (store.isLocal()) {
      await ollama.streamChat({
        url: s.ollamaUrl,
        model: s.ollamaModel,
        history: contents,
        system: CHAT_SYSTEM(s.language),
        signal: ctrl.signal,
        onText
      });
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
  const send = (ch, data) => {
    if (!sender.isDestroyed()) sender.send(ch, data);
  };
  let allowAll = false; // „Alle erlauben“ gilt bis zum Ende dieses Auftrags
  const approve = (step) =>
    new Promise((resolve) => {
      if (ctrl.signal.aborted) return resolve(false);
      if (allowAll) return resolve(true);
      approvals.set(step.id, (ok) => {
        if (ok === 'all') allowAll = true;
        resolve(!!ok);
      });
      ctrl.signal.addEventListener(
        'abort',
        () => {
          approvals.delete(step.id);
          resolve(false);
        },
        { once: true }
      );
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
      screenshot: () => {
        noteAgentScreenshot();
        return screenshotJpeg(currentDisplay);
      },
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
        onUsage: (u) => {
          usage.addTokens(s.chatModel, u);
          broadcastUsage();
        }
      });
    }
  } finally {
    agentRuns--;
    registerStopHotkey();
  }
}

ipcMain.on('agent:approval', (_e, { stepId, ok }) => {
  const r = approvals.get(stepId);
  if (r) {
    approvals.delete(stepId);
    // Scopes as strings (AURA-119): 'all' (task), 'always', 'session', 'hours:N'; everything else yes/no.
    r(typeof ok === 'string' && /^(all|always|session|hours:\d{1,2})$/.test(ok) ? ok : !!ok);
  }
});

// ---------- Agent v2 (agent/, Python + Google ADK) ----------

// v2 ist Standard; ohne mitgeliefertes Python (z. B. Entwicklung ohne agent/.venv) arbeitet v1.
const agentVersion = () => process.env.AURA_AGENT_VERSION || store.load().agentVersion || 'v2';
const v2Senders = new Map(); // Auftrags-ID → Fenster, das den Auftrag geschickt hat
const v2Questions = new Map(); // Frage-ID → resolve({answer})

// Sign-in for remote MCP servers (AURA-95). Authorization URLs open in the user's browser (https only, checked in
// oauth.js); the refresh token goes to the vault.
const oauth = createOAuthClient({
  fetch,
  openExternal: (url) => shell.openExternal(url),
  vault: {
    get: (n) => secrets.get(n),
    set: (n, v, note, meta) => secrets.set(n, v, note, meta),
    remove: (n) => secrets.remove(n)
  },
  clientMetadataUrl: 'https://fischersase.github.io/aura/oauth/client.json'
});
agentMcp.setAuthProvider((name) => oauth.authHeader(String(name)));

/** @param {string} name */
function mcpServerConfig(name) {
  try {
    const cfg = JSON.parse(fs.readFileSync(agentMcp.configFile(), 'utf8'));
    return (cfg.mcpServers || cfg.servers || {})[name] || null;
  } catch {
    return null;
  }
}

const agentV2 = new AgentBridge({
  app,
  settings: () => {
    const s = store.load();
    const gemini = s.provider === 'gemini';
    return {
      provider: gemini ? 'gemini' : 'ollama',
      ...(gemini ? { geminiModel: s.chatModel, geminiApiKey: store.getApiKey() } : {}),
      model: s.ollamaModel,
      ollamaUrl: s.ollamaUrl,
      numCtx: s.ollamaContext, // dieselbe Kontextlänge wie Chat und Rambler, sonst lädt Ollama das Modell neu
      language: s.language,
      profile: store.profilePrompt(),
      sessionType: process.platform === 'win32' ? 'windows' : process.env.XDG_SESSION_TYPE || '',
      toolPolicy: s.toolPolicy || {},
      ...browserLauncher(),
      mcpServers: mcpServersForAgent(),
      // Connector catalog for find_connector, and IDs the user never wants suggested (AURA-96).
      connectors: connectors.list(),
      declinedConnectors: s.declinedConnectors || [],
      disabledSkills: s.disabledSkills || [],
      memoryPaused: !!s.memoryPaused,
      // Location (AURA-116): only what the user allowed in the profile.
      locationMode: (s.profile && s.profile.locationMode) || 'profile',
      // Websites with a stored login (origins only, AURA-124).
      loginOrigins: [
        ...new Set(
          secrets
            .list()
            .filter((e) => e.kind === 'login' && e.origin)
            .map((e) => e.origin)
        )
      ],
      profilePlace: s.profile && s.profile.share ? s.profile.location || '' : '',
      dataDir: path.join(app.getPath('userData'), 'agent'),
      auraDir: defaultAuraDir()
    };
  },
  host: {
    // Freigabe über dieselbe Karte im Panel wie beim alten Agenten.
    approve: (req) =>
      new Promise((resolve) => {
        // Scoped approvals (AURA-119): the agent binds them to this tool and its website, connector tool or action.
        const SCOPES = ['always', 'session', 'hours:1', 'hours:8'];
        const answer = (ok) =>
          resolve({
            decision: ok === 'all' ? 'task' : SCOPES.includes(ok) ? ok : ok ? 'once' : 'deny'
          });
        answer.taskId = req.taskId;
        // Background runs (AURA-122): nobody watches the chat, so the approval waits in the inbox.
        if (String(req.taskId).startsWith('bg-')) return inboxAdd(req, answer);
        const sender = v2Senders.get(req.taskId);
        if (!sender || sender.isDestroyed()) return resolve({ decision: 'deny' });
        approvals.set(req.stepId, answer);
        const detail = req.effect && req.effect !== req.label ? req.effect : '';
        sender.send('agent:approve', {
          chatId: req.taskId,
          id: req.stepId,
          tool: req.tool,
          label: req.label,
          detail,
          tier: req.tier,
          reason: req.reason || ''
        });
        if (panel && (!panelOpen || panelMinimized)) restorePanel();
      }),
    // Rückfrage des Agenten (ask_user) als Karte im Panel.
    ask: (req) =>
      new Promise((resolve) => {
        const sender = v2Senders.get(req.taskId);
        if (!sender || sender.isDestroyed()) return resolve({ answer: '' });
        const id = 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const answer = (text) => resolve({ answer: String(text || '') });
        answer.taskId = req.taskId;
        v2Questions.set(id, answer);
        sender.send('agent:ask', { chatId: req.taskId, id, question: req.question, options: req.options || [] });
        if (panel && (!panelOpen || panelMinimized)) restorePanel();
      }),
    // Connector search in the official registry (AURA-96): the app does the HTTP request, not the agent.
    searchRegistry: async (req) => {
      try {
        return connectors.registrySummary(await zentrale.API.searchRegistry(String((req && req.query) || '')));
      } catch (err) {
        return { results: [], error: err instanceof Error ? err.message : String(err) };
      }
    },
    // Website logins (AURA-124): names for the page's origin; credentials only for exactly that origin, filled by
    // the agent straight into the page without the model seeing them.
    loginsFor: async (req) => {
      try {
        return { logins: secrets.loginsFor(String((req && req.origin) || '')) };
      } catch (err) {
        return { logins: [], error: err instanceof Error ? err.message : String(err) };
      }
    },
    loginFill: async (req) => {
      try {
        const origin = String((req && req.origin) || '');
        return secrets.loginFor(String((req && req.name) || ''), origin, `browser ${origin}`);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    // Scheduled tasks from the chat (AURA-121); the agent's schedule_task is T2, so the user approved it already.
    scheduleTask: async (req) => {
      try {
        const t = scheduler.add({
          title: req.title,
          prompt: req.prompt,
          trigger: req.trigger,
          onlyIfNew: !!req.onlyIfNew
        });
        return { id: t.id, title: t.title, when: scheduler.list().find((x) => x.id === t.id).when };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    listTasks: async () => ({
      tasks: scheduler.list().map((t) => ({
        id: t.id,
        title: t.title,
        when: t.when,
        enabled: t.enabled,
        nextRun: t.nextRun ? new Date(t.nextRun).toISOString() : null,
        lastStatus: t.lastStatus || '',
        lastText: t.lastText || ''
      }))
    }),
    cancelTask: async (req) => ({ removed: scheduler.remove(String((req && req.id) || '')) }),
    // Browser takeover (AURA-118): the user signs in or solves a CAPTCHA in Aura's browser window, then "Weiter".
    takeover: (req) =>
      new Promise((resolve) => {
        const sender = v2Senders.get(req.taskId);
        if (!sender || sender.isDestroyed()) return resolve({ decision: 'cancel' });
        const id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const answer = (decision) => resolve({ decision: decision === 'continue' ? 'continue' : 'cancel' });
        answer.taskId = req.taskId;
        v2Questions.set(id, answer);
        sender.send('agent:takeover', { chatId: req.taskId, id, reason: String(req.reason || '').slice(0, 300) });
        if (panel && (!panelOpen || panelMinimized)) restorePanel();
      }),
    // Connect card in the panel (AURA-96). Nothing is installed here; "connect" opens the Zentrale pre-filled.
    proposeConnector: (req) =>
      new Promise((resolve) => {
        const sender = v2Senders.get(req.taskId);
        if (!sender || sender.isDestroyed()) return resolve({ decision: 'later' });
        const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const answer = (decision) => {
          const d = ['connect', 'later', 'never'].includes(decision) ? decision : 'later';
          if (d === 'never') {
            const declined = new Set(store.load().declinedConnectors || []);
            declined.add(String(req.id));
            store.save({ declinedConnectors: [...declined] });
          }
          if (d === 'connect') {
            minimizePanel();
            zentrale.open(ICON, { page: 'catalog', connect: String(req.id), query: String(req.title || '') });
          }
          resolve({ decision: d });
        };
        answer.taskId = req.taskId;
        v2Questions.set(id, answer);
        sender.send('agent:connector', {
          chatId: req.taskId,
          id,
          title: String(req.title || req.id),
          publisher: String(req.publisher || ''),
          verified: req.verified === 'aura' ? 'aura' : 'registry',
          description: String(req.description || ''),
          reason: String(req.reason || ''),
          needs: Array.isArray(req.needs) ? req.needs.map(String) : [],
          risk: String(req.risk || '')
        });
        if (panel && (!panelOpen || panelMinimized)) restorePanel();
      }),
    screenshot: async (maxWidth) => {
      noteAgentScreenshot();
      return { mime: 'image/jpeg', data: await screenshotJpeg(currentDisplay, maxWidth) };
    },
    // OAuth MCP servers (AURA-95): a fresh header per request; refresh tokens never leave this process.
    authHeader: async (req) => {
      try {
        return await oauth.authHeader(String((req && req.server) || ''));
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    // Maus und Tastatur (Notlösung für Programme ohne Barrierefreiheit). x, y: 0–1000 im letzten Bildschirmfoto.
    input: async (req) => {
      if (req.action === 'click') {
        const d = currentDisplay || displayUnderCursor();
        const dip = {
          x: d.bounds.x + (Number(req.x) / 1000) * d.bounds.width,
          y: d.bounds.y + (Number(req.y) / 1000) * d.bounds.height
        };
        const p =
          process.platform === 'win32'
            ? screen.dipToScreenPoint(dip)
            : { x: dip.x * d.scaleFactor, y: dip.y * d.scaleFactor };
        return agentInput.click(p.x, p.y, { button: req.button === 'right' ? 'right' : 'left', double: !!req.double });
      }
      if (req.action === 'type') return agentInput.typeText(String(req.text || ''));
      if (req.action === 'keys') return agentInput.pressKeys(String(req.keys || ''));
      return { error: 'Unbekannte Eingabe' };
    }
  },
  // Chats the app still has; the agent forgets sessions of all others at start (AURA-106).
  chatIds: () => chats.list().map((c) => c.id)
});
// Deleting a chat (by the user or by pruning) also deletes the agent's session and episodes (NFR-PRIV-007).
chats.setOnRemove((id) => {
  agentV2.forgetChat(id).catch(() => {});
});

ipcMain.on('agent:takeoverAnswer', (_e, { id, decision }) => {
  const r = v2Questions.get(id);
  if (r) {
    v2Questions.delete(id);
    r(decision);
  }
});
ipcMain.on('agent:connectorAnswer', (_e, { id, decision }) => {
  const r = v2Questions.get(id);
  if (r) {
    v2Questions.delete(id);
    r(decision);
  }
});
ipcMain.on('agent:answer', (_e, { id, answer }) => {
  const r = v2Questions.get(id);
  if (r) {
    v2Questions.delete(id);
    r(answer);
  }
});

// Eigene MCP-Server aus ~/.aura/mcp.json für Agent v2, mit eingesetzten Schlüsseln (${secret:NAME}).
// Ein Server mit fehlendem Schlüssel wird mit Fehler übergeben und vom Agenten übersprungen.
function mcpServersForAgent() {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(agentMcp.configFile(), 'utf8'));
  } catch {
    return [];
  }
  const servers = cfg.mcpServers || cfg.servers || {};
  return Object.entries(servers)
    .filter(([, c]) => c && !c.disabled)
    .map(([name, c]) => {
      try {
        // A server added by hand with a catalog URL gets the catalog's tiers too (AURA-96).
        const catalogId = c.catalogId || (connectors.forUrl(c.url) || {}).id;
        const resolved = { ...secrets.resolveServerConfig(c), ...(catalogId ? { catalogId } : {}) };
        const { sandboxed: _s, ...run } = sandbox.wrap(name, builtinConfig(resolved));
        // Paused by drift protection (AURA-97): the agent checks the hash itself, too.
        const st = agentMcp.status().find((x) => x.name === name);
        if (st && st.drift) return { name, error: st.error };
        return { name, ...run };
      } catch (err) {
        return { name, error: String(err.message || err) };
      }
    });
}

// Mitgelieferter Browser-Server (Playwright-MCP), gestartet mit Electron als Node. Ohne Paket nimmt der Agent npx.
function browserLauncher() {
  const cli = path.join(process.resourcesPath || '', 'browser-mcp', 'node_modules', '@playwright', 'mcp', 'cli.js');
  if (!app.isPackaged || !fs.existsSync(cli)) return {};
  return { browserCommand: [process.execPath, cli], browserEnv: { ELECTRON_RUN_AS_NODE: '1' } };
}

// ---------- Sprachmodus mit Agent v2 ----------
// Im Live-Modus wird eine gesprochene Bitte ein ganz normaler Agent-Auftrag; die Antwort wird kurz und vorlesbar.
// Freigaben sind im Sprachmodus nicht möglich (kein Fenster offen): folgenreiche Aktionen lehnt die App ab,
// und der Agent sagt, dass sie im Aura-Fenster freizugeben sind.
const VOICE_HINT =
  '\n\n[Sprachmodus: Antworte in höchstens zwei kurzen, gesprochenen Sätzen, ohne Markdown, Listen oder Links. ' +
  'Folgenreiche Aktionen können im Sprachmodus nicht freigegeben werden; sag dann, dass der Nutzer sie im Aura-Fenster schreiben soll.]';
const voiceChatId = () => 'voice-' + new Date().toISOString().slice(0, 10);
const voiceAgentReady = () => store.load().agentEnabled && agentVersion() === 'v2' && agentV2.available();

function speakable(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>|]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

async function runVoiceTask(taskId, text, jpeg) {
  agentRuns++;
  registerStopHotkey();
  try {
    const done = await agentV2.runTask({
      taskId,
      chatId: voiceChatId(),
      text: text + VOICE_HINT,
      images: jpeg ? [{ mime: 'image/jpeg', data: jpeg }] : []
    });
    if (done && done.usage && store.load().provider === 'gemini') {
      usage.addTokens(store.load().chatModel, {
        promptTokenCount: done.usage.prompt,
        candidatesTokenCount: done.usage.output
      });
      broadcastUsage();
    }
    return speakable(done && done.cancelled ? 'Abgebrochen.' : done && done.text) || 'Erledigt.';
  } finally {
    agentRuns--;
    registerStopHotkey();
  }
}

// Gemini Live ruft den Agenten als Werkzeug auf (aura_ausfuehren).
let voiceSeq = 0;
ipcMain.handle('agent:voiceTask', async (_e, { request }) => {
  if (!voiceAgentReady()) return { error: 'Der Agent ist nicht verfügbar.' };
  try {
    return { result: await runVoiceTask('voice-gl-' + ++voiceSeq, String(request || ''), null) };
  } catch (err) {
    return { error: String(err.message || err) };
  }
});

// Hintergrund-Aufträge: Ist das Panel zu, wenn ein Auftrag fertig wird, meldet sich Aura mit einer Benachrichtigung.
// ---------- Background and scheduled tasks (AURA-121) ----------
// A due task runs as a headless agent task in its own chat "Hintergrund: <Titel>". Nobody watches: approvals in
// background runs are denied for now (the approval inbox follows with AURA-122), and the agent is told so.
const BG_HINT =
  '\n\n[Hintergrundauftrag: Niemand schaut gerade zu. Folgenreiche Aktionen legt die App dem Nutzer zur Freigabe vor ' +
  'und wartet darauf (bis zu einem Tag). Antworte knapp, das Ergebnis erscheint als Benachrichtigung.]';

// Approvals of background runs (AURA-122): "Wartet auf dich" in the panel plus a notification; after a day the run
// goes on without the action. The decision itself uses the normal approval path (agent:approval).
const inbox = createInbox({
  timeoutMs: 24 * 3600 * 1000 - 60_000, // just before the agent gives up
  changed: (list) => panel && !panel.isDestroyed() && panel.webContents.send('inbox:update', list),
  notify: (entry) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: `Aura wartet auf dich: ${entry.title}`,
      body: entry.label.slice(0, 180),
      icon: ICON
    });
    n.on('click', () => openPanel());
    n.show();
  }
});
const inboxList = () => inbox.list();
function inboxAdd(req, answer) {
  const task = scheduler.list().find((t) => String(req.taskId).startsWith(t.chatId + '-'));
  const decide = inbox.add(req, task ? task.title : 'Hintergrundauftrag', (ok) => {
    approvals.delete(req.stepId);
    answer(ok);
  });
  decide.taskId = req.taskId;
  approvals.set(req.stepId, decide);
}
ipcMain.handle('inbox:get', () => inboxList());
let bgSeq = 0;
const bgRunning = new Map(); // scheduled task id → agent task id (for "Stoppen" in the Zentrale)
async function runBackgroundTask(task) {
  if (!voiceAgentReady()) throw new Error('Der Agent ist nicht verfügbar (Agent v2 einschalten).');
  const taskId = `${task.chatId}-${++bgSeq}`;
  bgRunning.set(task.id, taskId);
  agentRuns++;
  registerStopHotkey();
  try {
    const done = await agentV2.runTask({ taskId, chatId: task.chatId, text: runPrompt(task) + BG_HINT });
    const text = String((done && done.text) || (done && done.cancelled ? 'Abgebrochen.' : 'Erledigt.'));
    // Watch task with nothing new (AURA-123): no chat entry, no notification.
    if (task.onlyIfNew && isNothingNew(text)) return { text, status: 'ok' };
    const prior = chats.get(task.chatId);
    chats.save({
      id: task.chatId,
      history: [
        ...((prior && prior.history) || [{ role: 'user', parts: [{ text: `Hintergrund: ${task.title}` }] }]),
        { role: 'user', parts: [{ text: `${new Date().toLocaleString('de-DE')}: ${task.prompt}` }] },
        { role: 'model', parts: [{ text }] }
      ]
    });
    if (Notification.isSupported()) {
      const n = new Notification({
        title: `Aura: ${task.title}`,
        body: text
          .replace(/[*_`#>]/g, '')
          .replace(/\s+/g, ' ')
          .slice(0, 180),
        icon: ICON
      });
      n.on('click', () => openPanel());
      n.show();
    }
    return { text, status: done && done.verified === false ? 'unverified' : 'ok' };
  } finally {
    bgRunning.delete(task.id);
    agentRuns--;
    registerStopHotkey();
  }
}
const scheduler = createScheduler({
  file: path.join(app.getPath('userData'), 'agent', 'tasks.json'),
  run: runBackgroundTask
});

function notifyIfHidden(text, verified) {
  if (panelOpen || !Notification.isSupported()) return;
  const body = String(text || 'Fertig.')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 180);
  const n = new Notification({
    title: verified === false ? 'Aura: nicht alles hat geklappt' : 'Aura ist fertig',
    body,
    icon: ICON,
    silent: false
  });
  n.on('click', () => openPanel());
  n.show();
}

async function runAgentV2(sender, id, chatId, ctrl, contents, onText, incognito = false) {
  const send = (ch, data) => {
    if (!sender.isDestroyed()) sender.send(ch, data);
  };
  const last = contents[contents.length - 1] || { parts: [] };
  const text = last.parts
    .filter((p) => p.text)
    .map((p) => p.text)
    .join('\n');
  const images = last.parts
    .filter((p) => p.inlineData)
    .map((p) => ({ mime: p.inlineData.mimeType, data: p.inlineData.data }));
  v2Senders.set(id, sender);
  const onAbort = () => {
    // Offene Freigaben dieses Auftrags gelten als abgelehnt, dann Not-Aus im Agenten.
    for (const [stepId, r] of approvals) {
      if (r.taskId === id) {
        approvals.delete(stepId);
        r(false);
      }
    }
    for (const [qid, r] of v2Questions) {
      if (r.taskId === id) {
        v2Questions.delete(qid);
        r('');
      }
    }
    agentV2.cancel(id);
  };
  ctrl.signal.addEventListener('abort', onAbort, { once: true });
  agentRuns++;
  registerStopHotkey();
  try {
    const done = await agentV2.runTask(
      { taskId: id, chatId, text, images, incognito },
      {
        onText,
        onStep: (st) =>
          send('agent:step', {
            chatId: id,
            id: st.stepId,
            tool: st.tool,
            label: st.label,
            state: st.state,
            verified: st.verified
          }),
        onPlan: (items) => send('agent:plan', { chatId: id, items })
      }
    );
    if (done && !done.cancelled && done.verified !== null && done.verified !== undefined)
      send('agent:verified', { chatId: id, verified: done.verified });
    if (done && !done.cancelled) notifyIfHidden(done.text, done.verified);
    if (done && done.usage && store.load().provider === 'gemini') {
      // Kosten wie beim Chat mitzählen (Monatsbudget in den Einstellungen).
      usage.addTokens(store.load().chatModel, {
        promptTokenCount: done.usage.prompt,
        candidatesTokenCount: done.usage.output
      });
      broadcastUsage();
    }
  } finally {
    ctrl.signal.removeEventListener('abort', onAbort);
    v2Senders.delete(id);
    agentRuns--;
    registerStopHotkey();
  }
}

// Notbremse: alle laufenden Aufträge abbrechen und gestartete Befehle beenden.
function stopAgent() {
  for (const c of chatAborts.values()) c.abort();
  agentTools.killAll();
  agentV2.cancelAll();
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
  try {
    await agentMcp.sync(!!force);
  } catch {}
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
app.on('will-quit', () => {
  agentMcp.closeAll();
  web.stop();
  agentV2.stop();
});

// Das Notbremse-Kürzel ist nur aktiv, solange der Agent arbeitet.
let stopKeyOn = null;
function registerStopHotkey() {
  const acc = store.load().hotkeyStop;
  if (stopKeyOn) {
    try {
      globalShortcut.unregister(stopKeyOn);
    } catch {}
    stopKeyOn = null;
  }
  if (agentRuns > 0 && acc) {
    try {
      if (globalShortcut.register(acc, stopAgent)) stopKeyOn = acc;
    } catch {}
  }
}

ipcMain.handle('usage:get', () => usageSummary());
// Zentrale-Seiten für Agent v2 (Regeln, Gedächtnis, Protokoll, Systemprüfung).
Object.assign(zentrale.API, {
  policy: () => zentraleV2.policy(),
  savePolicy: (text) => zentraleV2.savePolicy(text),
  // Memory page (AURA-108): facts with provenance from the agent; pausing is a setting the agent starts with.
  memory: async () => {
    if (!agentV2.available()) return { facts: [], paused: !!store.load().memoryPaused, unavailable: true };
    return agentV2.call('memory.list');
  },
  memoryUpdate: ({ id, text } = {}) =>
    agentV2.call('memory.update', { id: String(id || ''), text: String(text || '') }),
  memoryDelete: (id) => agentV2.call('memory.delete', { id: String(id || '') }),
  memoryDeleteAll: () => agentV2.call('memory.deleteAll'),
  memoryPause: (paused) => {
    store.save({ memoryPaused: !!paused });
    return { paused: !!paused };
  },
  audit: () => zentraleV2.audit(),
  doctor: () => zentraleV2.doctor({ settings: () => agentV2.settings(), bridge: agentV2 }),
  installExtension: () => zentraleV2.installExtension(),
  // OAuth sign-in for a remote MCP server (AURA-95); the user signs in in their browser.
  connectServer: async (name) => {
    const c = mcpServerConfig(String(name || ''));
    if (!c || !c.url) return { error: 'Server nicht gefunden oder kein Remote-Server.' };
    try {
      const clientSecret = c.clientSecretRef ? secrets.resolve(c.clientSecretRef) : undefined;
      const r = await oauth.connect(String(name), c.url, {
        clientId: c.clientId || undefined,
        clientSecret: typeof clientSecret === 'string' && clientSecret ? clientSecret : undefined,
        scope: c.scope || undefined
      });
      await agentMcp.sync(true).catch(() => {}); // the server list now connects with the new sign-in
      return { ok: true, scope: r.scope };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
  // Scheduled tasks (AURA-121): list, pause/resume, delete.
  tasks: () =>
    scheduler.list().map((t) => ({
      ...t,
      waiting: inboxList().filter((e) => String(e.taskId).startsWith(t.chatId + '-')).length
    })),
  toggleTask: ({ id, enabled } = {}) => scheduler.setEnabled(String(id || ''), !!enabled),
  removeTask: (id) => scheduler.remove(String(id || '')),
  // Ready-made tasks from the Zentrale (AURA-123), e.g. the daily briefing.
  addTask: ({ title, prompt, trigger, onlyIfNew } = {}) => {
    try {
      return { task: scheduler.add({ title, prompt, trigger, onlyIfNew: !!onlyIfNew }) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
  // Stop a running background run (AURA-122): its waiting approvals count as denied, then the agent stops.
  stopTask: (id) => {
    const taskId = bgRunning.get(String(id || ''));
    if (!taskId) return false;
    for (const e of inboxList()) if (e.taskId === taskId) approvals.get(e.stepId)?.(false);
    agentV2.cancel(taskId);
    return true;
  },
  disconnectServer: async (name) => {
    const r = await oauth.disconnect(String(name || ''));
    await agentMcp.sync(true).catch(() => {});
    return r;
  }
});
zentrale.register();
ipcMain.on('zentrale:open', () => {
  closePanel();
  zentrale.open(ICON);
});

// Chat-Verlauf
ipcMain.handle('chats:list', () => chats.list());
ipcMain.handle('chats:get', (_e, id) => chats.get(id));
ipcMain.handle('chats:save', (_e, chat) => chats.save(chat));
ipcMain.handle('chats:delete', (_e, id) => chats.remove(id));

// Solange eine Antwort läuft, schließt ein Fokuswechsel (z. B. Freigabe-Dialog) das Fenster nicht.
let panelBusy = false;
ipcMain.on('panel:busy', (_e, v) => {
  panelBusy = !!v;
});

ipcMain.on('live:usage', (_e, secs) => {
  usage.addLive(secs || {});
  const u = broadcastUsage();
  if (u.overBudget && liveActive && panel) panel.webContents.send('live:stop', budgetError());
});

ipcMain.handle('live:config', () => {
  const over = budgetError();
  if (over) return { error: over };
  const s = store.load();
  const agent = voiceAgentReady();
  if (store.isLocal()) return { provider: 'ollama', model: s.ollamaModel, language: s.language, agent };
  return {
    agent,
    provider: 'gemini',
    hasKey: !!store.getApiKey(), // the key itself stays in main (live-relay.js, AURA-15)
    model: s.liveModel,
    voice: s.liveVoice,
    language: s.language,
    fps: Number(s.liveFps) || 1
  };
});

// Gemini Live relay (AURA-15): the WebSocket lives here, the panel only exchanges messages.
const liveRelay = new LiveRelay({ getKey: () => store.getApiKey() });
ipcMain.handle('live:open', (e) => {
  const over = budgetError();
  if (over) return { error: over };
  return liveRelay.open(e.sender);
});
ipcMain.on('live:send', (e, { id, data }) => liveRelay.send(e.sender, id, data));
ipcMain.on('live:close', (e, id) => liveRelay.close(id, e.sender));

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
ipcMain.on('panel:minimize', () => minimizePanel());
ipcMain.on('panel:restore', () => restorePanel());

// Overlay meldet, dass weder Glow noch Hinweise sichtbar sind: ganz ausblenden.
ipcMain.on('overlay:idle', () => {
  if (overlay && !overlay.isDestroyed() && !panelOpen && !liveActive) overlay.hide();
});

ipcMain.on('panel:ignoreMouse', (_e, ignore) => {
  // Linux kann Mausbewegungen nicht durchreichen ("forward" gibt es nur unter Windows/macOS):
  // einmal durchlässig, käme nie wieder ein Klick im Fenster an. Dort bleibt das Fenster klickbar.
  if (IS_LINUX) return;
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
    webPreferences: {
      preload: path.join(__dirname, 'preload-stt.js'),
      contextIsolation: true,
      backgroundThrottling: false
    }
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

// language: Whisper-Sprachname (z. B. 'german'); ohne rät Whisper die Sprache selbst.
async function transcribe(wavBase64, language) {
  await ensureStt();
  const id = ++sttSeq;
  return new Promise((resolve, reject) => {
    sttJobs.set(id, { resolve, reject });
    sttWin.webContents.send('stt:request', { id, wavBase64, model: store.load().whisperModel, language });
  });
}

// Spracheinstellung von Aura → Whisper-Sprache. Bei kurzen Aufnahmen rät Whisper sonst oft Englisch.
const WHISPER_LANGUAGES = {
  deutsch: 'german',
  german: 'german',
  english: 'english',
  englisch: 'english',
  español: 'spanish',
  spanisch: 'spanish',
  français: 'french',
  französisch: 'french',
  italiano: 'italian',
  italienisch: 'italian',
  türkçe: 'turkish',
  türkisch: 'turkish',
  polski: 'polish',
  polnisch: 'polish',
  nederlands: 'dutch',
  niederländisch: 'dutch'
};
const whisperLanguage = (language) =>
  WHISPER_LANGUAGES[
    String(language || '')
      .trim()
      .toLowerCase()
  ];

ipcMain.on('stt:result', (_e, { id, text, error }) => {
  const job = sttJobs.get(id);
  if (!job) return;
  sttJobs.delete(id);
  if (error) job.reject(new Error('Spracherkennung: ' + error));
  else job.resolve(text);
});

// Fortschritt beim ersten Laden des Whisper-Modells an Rambler und Panel weitergeben.
ipcMain.on('stt:progress', (_e, p) => {
  for (const w of [ramblerBar, panel, settingsWin, setupWin])
    if (w && !w.isDestroyed()) w.webContents.send('stt:progress', p);
});

// Spracheingabe im Chat: Aufnahme → Text. Lokal mit Whisper (nichts verlässt den Rechner), sonst mit einem
// günstigen Gemini-Modell (dictationModel). Der Text wird im Panel als normale Nachricht abgeschickt.
ipcMain.handle('chat:transcribe', async (_e, { wavBase64 }) => {
  const s = store.load();
  try {
    if (store.isLocal())
      return { text: String((await transcribe(wavBase64, whisperLanguage(s.language))) || '').trim() };
    if (!store.getApiKey()) return { error: 'Kein Gemini-API-Schlüssel eingerichtet.' };
    const over = budgetError();
    if (over) return { error: over };
    const model = s.dictationModel || 'gemini-3.5-flash-lite';
    const out = await gemini.transcribe({ apiKey: store.getApiKey(), model, wavBase64, language: s.language });
    usage.addTokens(model, out.usage);
    broadcastUsage();
    return { text: out.text };
  } catch (err) {
    return { error: String(err.message || err) };
  }
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
    if (voiceAgentReady()) {
      ctrl.signal.addEventListener('abort', () => agentV2.cancel('voice-' + id), { once: true });
      const say = await runVoiceTask('voice-' + id, question, jpeg);
      return { question, say, point: null };
    }
    const out = await ollama.liveTurn({
      url: s.ollamaUrl,
      model: s.ollamaModel,
      language: s.language,
      history,
      question,
      jpeg,
      signal: ctrl.signal
    });
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
  const remote = !ollama.isLocalUrl(u);
  try {
    const v = await ollama.version(u);
    const models = await ollama.listModels(u);
    return { ok: true, version: v, models, recommended: ollama.RECOMMENDED, remote };
  } catch (err) {
    return { ok: false, message: String(err.message || err), recommended: ollama.RECOMMENDED, remote };
  }
});

let pullCtrl = null;
ipcMain.handle('ollama:pull', async (e, { url, name }) => {
  pullCtrl = new AbortController();
  try {
    await ollama.pull(
      url || store.load().ollamaUrl,
      name,
      (p) => {
        if (!e.sender.isDestroyed())
          e.sender.send('ollama:progress', { name, status: p.status, completed: p.completed, total: p.total });
      },
      pullCtrl.signal
    );
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
  if (!on) {
    fs.rmSync(file, { force: true });
    return;
  }
  const exe = process.env.APPIMAGE || process.execPath;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    ['[Desktop Entry]', 'Type=Application', 'Name=Aura', `Exec="${exe}"`, 'X-GNOME-Autostart-enabled=true', ''].join(
      '\n'
    )
  );
}

function applyAutostart() {
  if (!app.isPackaged) return; // Im Entwicklungsmodus nicht die electron.exe eintragen.
  if (IS_LINUX) {
    try {
      applyAutostartLinux(!!store.load().autostart);
    } catch (err) {
      console.warn('Autostart:', err.message);
    }
    return;
  }
  // Ältere portable .exe entpackten sich in einen Temp-Ordner; eingetragen wird die Original-Datei.
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  // Autostart-Einträge der alten „Gemini Overlay“ entfernen, sonst startet die alte Version mit.
  for (const name of ['electron.app.Gemini Overlay', 'Gemini Overlay']) {
    app.setLoginItemSettings({ openAtLogin: false, name });
  }
  app.setLoginItemSettings({ openAtLogin: !!store.load().autostart, path: exe });
  // Old portable Aura (≤ 0.10) in autostart would start first and keep this version from running (AURA-114).
  if (process.platform === 'win32') require('./win-autostart').removeStaleAutostart(exe);
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'));
  tray = new Tray(img);
  tray.setToolTip(`Aura ${app.getVersion()}`);
  const s = () => store.load();
  const menu = () =>
    Menu.buildFromTemplate([
      { label: `Aura öffnen\t${s().hotkeyGemini}`, click: () => openPanel() },
      { label: `Live\t${s().hotkeyLive}`, click: () => toggleLive() },
      { label: `Rambler: ${s().hotkeyRambler} im Textfeld`, enabled: false },
      { type: 'separator' },
      store.isLocal()
        ? { label: `Lokal über Ollama: ${s().ollamaModel}`, enabled: false }
        : {
            label: `Diesen Monat: ≈ ${usageSummary().costUsd.toFixed(2)} $ von ${Number(s().monthlyBudgetUsd).toFixed(2)} $`,
            enabled: false
          },
      ...(agentRuns > 0 ? [{ label: `Agent stoppen\t${s().hotkeyStop}`, click: () => stopAgent() }] : []),
      { label: 'Aura Zentrale (Werkzeuge, MCP, Skills) …', click: () => zentrale.open(ICON) },
      { label: 'Aura Zentrale im Browser …', click: () => web.open() },
      { label: 'Einstellungen …', click: () => openSettings() },
      { label: 'Einrichtung erneut starten …', click: () => openSetup() },
      { type: 'separator' },
      { label: `Version ${app.getVersion()}`, enabled: false },
      { label: 'Beenden', click: () => app.quit() }
    ]);
  tray.on('click', () => openPanel());
  tray.on('right-click', () => tray.popUpContextMenu(menu()));
}

app.whenReady().then(() => {
  // Linux without keyring: if the user agreed to weak storage, values stored that way must stay readable (AURA-93).
  enableWeakIfAllowed(safeStorage, !!store.load().allowWeakSecretStorage);
  ollama.setContextSize(store.load().ollamaContext);
  // Mikrofon und Bildschirm nur für die Fenster, die sie brauchen; keine Navigation weg von Auras Seiten (AURA-14).
  security.install({ app, session, shell });
  // Bildschirmfreigabe ohne Auswahldialog: der Bildschirm, auf dem das Panel offen ist. Nur für das Panel.
  session.defaultSession.setDisplayMediaRequestHandler(async (req, cb) => {
    if (!security.permissionAllowed(req.frame && req.frame.url, 'display-capture')) return cb({});
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
  scheduler.start();
  screen.on('display-removed', () => {
    currentDisplay = null;
  });
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  keys.shutdown();
});
