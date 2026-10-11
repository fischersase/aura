const {
  app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, clipboard,
  desktopCapturer, session, nativeImage, shell
} = require('electron');
const path = require('path');
const store = require('./store');
const gemini = require('./gemini');
const keys = require('./keys');
const usage = require('./usage');

const R = (f) => path.join(__dirname, 'renderer', f);
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const PANEL_W = 440;
const PANEL_H = 620;
const MARGIN = 4; // + 12 px Schattenrand im Panel-Fenster = 16 px Abstand
const RAMBLER_W = 420;
const RAMBLER_H = 92;

let overlay, panel, ramblerBar, settingsWin, setupWin, tray;
let panelOpen = false;
let liveActive = false;
let currentDisplay = null;
const ramblerState = { recording: false, busy: false, saved: null, selection: '', last: null };

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => (store.load().setupDone ? openSettings() : openSetup()));

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
    // Wie auf dem Googlebook: Klick daneben schließt das Fenster, außer Live läuft.
    if (panelOpen && !liveActive && !panel.webContents.isDevToolsOpened()) closePanel();
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
    title: 'Gemini Overlay – Einrichtung',
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
    title: 'Gemini Overlay – Einstellungen',
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
  if (!store.getApiKey()) {
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
  if (!store.getApiKey()) { openSetup(); return; }
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
    await keys.send('^c');
    await sleep(120);
    const selection = clipboard.readText();
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

async function pasteText(text) {
  const saved = saveClipboard();
  clipboard.writeText(text);
  await keys.send('^v');
  await sleep(350);
  restoreClipboard(saved);
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
    const out = await gemini.rambler({
      apiKey: store.getApiKey(),
      model: s.ramblerModel,
      wavBase64,
      selection: ramblerState.selection,
      language: s.language
    });
    usage.addTokens(s.ramblerModel, out.usage);
    broadcastUsage();
    if (!out.text) throw new Error('Nichts verstanden.');
    await pasteText(out.text);
    ramblerState.last = { ...out, fullAvailable: !ramblerState.selection };
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

async function screenshotJpeg(display, maxWidth = 1600) {
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
  return src.thumbnail.toJPEG(75).toString('base64');
}

// ---------- Kosten ----------

function usageSummary() {
  return usage.summary(store.load().monthlyBudgetUsd);
}

function broadcastUsage() {
  const u = usageSummary();
  for (const w of [panel, settingsWin]) if (w && !w.isDestroyed()) w.webContents.send('usage:update', u);
  return u;
}

function budgetError() {
  const u = usageSummary();
  if (!u.overBudget) return null;
  return `Monatsbudget von ${u.budgetUsd.toFixed(2)} $ erreicht (geschätzt ${u.costUsd.toFixed(2)} $). ` +
    'Du kannst es in den Einstellungen erhöhen.';
}

// ---------- IPC ----------

const CHAT_SYSTEM = (lang) =>
  'Du bist Gemini in einem kompakten Overlay auf einem Windows-PC. Antworte kurz, klar und freundlich, ' +
  `standardmäßig auf ${lang}. Nutze Markdown sparsam (kurze Listen, **fett**, \`code\`). ` +
  'Wenn ein Screenshot beiliegt, beziehe dich konkret auf das, was zu sehen ist.';

const chatAborts = new Map();

ipcMain.handle('settings:get', () => store.publicSettings());

ipcMain.handle('settings:save', (_e, patch) => {
  const { apiKey, ...rest } = patch || {};
  if (apiKey !== undefined) store.setApiKey(apiKey);
  store.save(rest);
  const failed = registerHotkeys();
  applyAutostart();
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
    const res = await gemini.streamChat({
      apiKey: store.getApiKey(),
      model: s.chatModel,
      history: contents,
      system: CHAT_SYSTEM(s.language),
      signal: ctrl.signal,
      onText: (t) => e.sender.send('chat:chunk', { id, text: t })
    });
    usage.addTokens(s.chatModel, res.usage);
    broadcastUsage();
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
  return {
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
  reg(s.hotkeyGemini, toggleGemini, 'Gemini');
  reg(s.hotkeyRambler, toggleRambler, 'Rambler');
  reg(s.hotkeyLive, toggleLive, 'Gemini Live');
  return failed;
}

function applyAutostart() {
  if (!app.isPackaged) return; // Im Entwicklungsmodus nicht die electron.exe eintragen.
  // Die portable .exe entpackt sich in einen Temp-Ordner; eingetragen wird die Original-Datei.
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  app.setLoginItemSettings({ openAtLogin: !!store.load().autostart, path: exe });
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'));
  tray = new Tray(img);
  tray.setToolTip('Gemini Overlay');
  const s = () => store.load();
  const menu = () => Menu.buildFromTemplate([
    { label: `Gemini öffnen\t${s().hotkeyGemini}`, click: () => openPanel() },
    { label: `Gemini Live\t${s().hotkeyLive}`, click: () => toggleLive() },
    { label: `Rambler: ${s().hotkeyRambler} im Textfeld`, enabled: false },
    { type: 'separator' },
    { label: `Diesen Monat: ≈ ${usageSummary().costUsd.toFixed(2)} $ von ${Number(s().monthlyBudgetUsd).toFixed(2)} $`, enabled: false },
    { label: 'Einstellungen …', click: () => openSettings() },
    { label: 'Einrichtung erneut starten …', click: () => openSetup() },
    { label: 'Beenden', click: () => app.quit() }
  ]);
  tray.on('click', () => openPanel());
  tray.on('right-click', () => tray.popUpContextMenu(menu()));
}

app.whenReady().then(() => {
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

  if (!store.load().setupDone || !store.getApiKey()) openSetup();
  else if (failed.length) openSettings();
  screen.on('display-removed', () => { currentDisplay = null; });
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  keys.shutdown();
});
