const {
  app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, clipboard,
  desktopCapturer, session, nativeImage, shell, Notification
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
const web = require('./web');
const security = require('./security');
const { AgentBridge, defaultAuraDir } = require('./agent2/bridge');
const zentraleV2 = require('./agent2/zentrale-v2');
agentMcp.setResolver(secrets.resolveServerConfig);

const R = (f) => path.join(__dirname, 'renderer', f);
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const PANEL_W = 440;
const PANEL_H = 620;
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
    // Wie auf dem Googlebook: Klick daneben schließt das Fenster, außer Live oder der Agent läuft.
    if (panelOpen && !liveActive && !agentRuns && !panelBusy && !panel.webContents.isDevToolsOpened()) closePanel();
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
  'Wenn ein Screenshot beiliegt, beziehe dich konkret auf das, was zu sehen ist.'
  + (store.profilePrompt() ? '\n\n' + store.profilePrompt() : '');

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

ipcMain.on('chat:send', async (e, { id, chatId, history, includeScreen }) => {
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
      await runAgentV2(e.sender, id, chatId || id, ctrl, contents, onText);
    } else if (s.agentEnabled) {
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
  if (r) { approvals.delete(stepId); r(ok === 'all' || ok === 'always' ? ok : !!ok); }
});

// ---------- Agent v2 (agent/, Python + Google ADK) ----------

// v2 ist Standard; ohne mitgeliefertes Python (z. B. Entwicklung ohne agent/.venv) arbeitet v1.
const agentVersion = () => process.env.AURA_AGENT_VERSION || store.load().agentVersion || 'v2';
const v2Senders = new Map(); // Auftrags-ID → Fenster, das den Auftrag geschickt hat
const v2Questions = new Map(); // Frage-ID → resolve({answer})

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
      disabledSkills: s.disabledSkills || [],
      dataDir: path.join(app.getPath('userData'), 'agent'),
      auraDir: defaultAuraDir()
    };
  },
  host: {
    // Freigabe über dieselbe Karte im Panel wie beim alten Agenten.
    approve: (req) => new Promise((resolve) => {
      const sender = v2Senders.get(req.taskId);
      if (!sender || sender.isDestroyed()) return resolve({ decision: 'deny' });
      const answer = (ok) => resolve({ decision: ok === 'all' ? 'task' : ok === 'always' ? 'always' : ok ? 'once' : 'deny' });
      answer.taskId = req.taskId;
      approvals.set(req.stepId, answer);
      const detail = req.effect && req.effect !== req.label ? req.effect : '';
      sender.send('agent:approve', { chatId: req.taskId, id: req.stepId, tool: req.tool, label: req.label, detail, tier: req.tier, reason: req.reason || '' });
      if (panel && !panelOpen) openPanel();
    }),
    // Rückfrage des Agenten (ask_user) als Karte im Panel.
    ask: (req) => new Promise((resolve) => {
      const sender = v2Senders.get(req.taskId);
      if (!sender || sender.isDestroyed()) return resolve({ answer: '' });
      const id = 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const answer = (text) => resolve({ answer: String(text || '') });
      answer.taskId = req.taskId;
      v2Questions.set(id, answer);
      sender.send('agent:ask', { chatId: req.taskId, id, question: req.question, options: req.options || [] });
      if (panel && !panelOpen) openPanel();
    }),
    screenshot: async (maxWidth) => ({ mime: 'image/jpeg', data: await screenshotJpeg(currentDisplay, maxWidth) }),
    // Maus und Tastatur (Notlösung für Programme ohne Barrierefreiheit). x, y: 0–1000 im letzten Bildschirmfoto.
    input: async (req) => {
      if (req.action === 'click') {
        const d = currentDisplay || displayUnderCursor();
        const dip = { x: d.bounds.x + (Number(req.x) / 1000) * d.bounds.width, y: d.bounds.y + (Number(req.y) / 1000) * d.bounds.height };
        const p = process.platform === 'win32' ? screen.dipToScreenPoint(dip) : { x: dip.x * d.scaleFactor, y: dip.y * d.scaleFactor };
        return agentInput.click(p.x, p.y, { button: req.button === 'right' ? 'right' : 'left', double: !!req.double });
      }
      if (req.action === 'type') return agentInput.typeText(String(req.text || ''));
      if (req.action === 'keys') return agentInput.pressKeys(String(req.keys || ''));
      return { error: 'Unbekannte Eingabe' };
    }
  }
});

ipcMain.on('agent:answer', (_e, { id, answer }) => {
  const r = v2Questions.get(id);
  if (r) { v2Questions.delete(id); r(answer); }
});

// Eigene MCP-Server aus ~/.aura/mcp.json für Agent v2, mit eingesetzten Schlüsseln (${secret:NAME}).
// Ein Server mit fehlendem Schlüssel wird mit Fehler übergeben und vom Agenten übersprungen.
function mcpServersForAgent() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(agentMcp.configFile(), 'utf8')); } catch { return []; }
  const servers = cfg.mcpServers || cfg.servers || {};
  return Object.entries(servers).filter(([, c]) => c && !c.disabled).map(([name, c]) => {
    try { return { name, ...secrets.resolveServerConfig(c) }; } catch (err) { return { name, error: String(err.message || err) }; }
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
const VOICE_HINT = '\n\n[Sprachmodus: Antworte in höchstens zwei kurzen, gesprochenen Sätzen, ohne Markdown, Listen oder Links. '
  + 'Folgenreiche Aktionen können im Sprachmodus nicht freigegeben werden; sag dann, dass der Nutzer sie im Aura-Fenster schreiben soll.]';
const voiceChatId = () => 'voice-' + new Date().toISOString().slice(0, 10);
const voiceAgentReady = () => store.load().agentEnabled && agentVersion() === 'v2' && agentV2.available();

function speakable(text) {
  return String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>|]/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

async function runVoiceTask(taskId, text, jpeg) {
  agentRuns++;
  registerStopHotkey();
  try {
    const done = await agentV2.runTask({ taskId, chatId: voiceChatId(), text: text + VOICE_HINT, images: jpeg ? [{ mime: 'image/jpeg', data: jpeg }] : [] });
    if (done && done.usage && store.load().provider === 'gemini') {
      usage.addTokens(store.load().chatModel, { promptTokenCount: done.usage.prompt, candidatesTokenCount: done.usage.output });
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
    return { result: await runVoiceTask('voice-gl-' + (++voiceSeq), String(request || ''), null) };
  } catch (err) {
    return { error: String(err.message || err) };
  }
});

// Hintergrund-Aufträge: Ist das Panel zu, wenn ein Auftrag fertig wird, meldet sich Aura mit einer Benachrichtigung.
function notifyIfHidden(text, verified) {
  if (panelOpen || !Notification.isSupported()) return;
  const body = String(text || 'Fertig.').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').slice(0, 180);
  const n = new Notification({ title: verified === false ? 'Aura: nicht alles hat geklappt' : 'Aura ist fertig', body, icon: ICON, silent: false });
  n.on('click', () => openPanel());
  n.show();
}

async function runAgentV2(sender, id, chatId, ctrl, contents, onText) {
  const send = (ch, data) => { if (!sender.isDestroyed()) sender.send(ch, data); };
  const last = contents[contents.length - 1] || { parts: [] };
  const text = last.parts.filter((p) => p.text).map((p) => p.text).join('\n');
  const images = last.parts.filter((p) => p.inlineData).map((p) => ({ mime: p.inlineData.mimeType, data: p.inlineData.data }));
  v2Senders.set(id, sender);
  const onAbort = () => {
    // Offene Freigaben dieses Auftrags gelten als abgelehnt, dann Not-Aus im Agenten.
    for (const [stepId, r] of approvals) { if (r.taskId === id) { approvals.delete(stepId); r(false); } }
    for (const [qid, r] of v2Questions) { if (r.taskId === id) { v2Questions.delete(qid); r(''); } }
    agentV2.cancel(id);
  };
  ctrl.signal.addEventListener('abort', onAbort, { once: true });
  agentRuns++;
  registerStopHotkey();
  try {
    const done = await agentV2.runTask({ taskId: id, chatId, text, images }, {
      onText,
      onStep: (st) => send('agent:step', { chatId: id, id: st.stepId, tool: st.tool, label: st.label, state: st.state, verified: st.verified }),
      onPlan: (items) => send('agent:plan', { chatId: id, items })
    });
    if (done && !done.cancelled && done.verified !== null && done.verified !== undefined) send('agent:verified', { chatId: id, verified: done.verified });
    if (done && !done.cancelled) notifyIfHidden(done.text, done.verified);
    if (done && done.usage && store.load().provider === 'gemini') {
      // Kosten wie beim Chat mitzählen (Monatsbudget in den Einstellungen).
      usage.addTokens(store.load().chatModel, { promptTokenCount: done.usage.prompt, candidatesTokenCount: done.usage.output });
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
app.on('will-quit', () => { agentMcp.closeAll(); web.stop(); agentV2.stop(); });

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
// Zentrale-Seiten für Agent v2 (Regeln, Gedächtnis, Protokoll, Systemprüfung).
Object.assign(zentrale.API, {
  policy: () => zentraleV2.policy(),
  savePolicy: (text) => zentraleV2.savePolicy(text),
  memory: () => zentraleV2.memory(),
  saveMemory: (text) => zentraleV2.saveMemory(text),
  audit: () => zentraleV2.audit(),
  doctor: () => zentraleV2.doctor({ settings: () => agentV2.settings(), bridge: agentV2 }),
  installExtension: () => zentraleV2.installExtension()
});
zentrale.register();
ipcMain.on('zentrale:open', () => { closePanel(); zentrale.open(ICON); });

// Chat-Verlauf
ipcMain.handle('chats:list', () => chats.list());
ipcMain.handle('chats:get', (_e, id) => chats.get(id));
ipcMain.handle('chats:save', (_e, chat) => chats.save(chat));
ipcMain.handle('chats:delete', (_e, id) => chats.remove(id));

// Solange eine Antwort läuft, schließt ein Fokuswechsel (z. B. Freigabe-Dialog) das Fenster nicht.
let panelBusy = false;
ipcMain.on('panel:busy', (_e, v) => { panelBusy = !!v; });

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
const WHISPER_LANGUAGES = { deutsch: 'german', german: 'german', english: 'english', englisch: 'english', español: 'spanish',
  spanisch: 'spanish', français: 'french', französisch: 'french', italiano: 'italian', italienisch: 'italian',
  türkçe: 'turkish', türkisch: 'turkish', polski: 'polish', polnisch: 'polish', nederlands: 'dutch', niederländisch: 'dutch' };
const whisperLanguage = (language) => WHISPER_LANGUAGES[String(language || '').trim().toLowerCase()];

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

// Spracheingabe im Chat: Aufnahme → Text. Lokal mit Whisper (nichts verlässt den Rechner), sonst mit einem
// günstigen Gemini-Modell (dictationModel). Der Text wird im Panel als normale Nachricht abgeschickt.
ipcMain.handle('chat:transcribe', async (_e, { wavBase64 }) => {
  const s = store.load();
  try {
    if (store.isLocal()) return { text: String(await transcribe(wavBase64, whisperLanguage(s.language)) || '').trim() };
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
  // Ältere portable .exe entpackten sich in einen Temp-Ordner; eingetragen wird die Original-Datei.
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
  tray.setToolTip(`Aura ${app.getVersion()}`);
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
  screen.on('display-removed', () => { currentDisplay = null; });
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  keys.shutdown();
});
