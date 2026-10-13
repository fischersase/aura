// @ts-check
// Electron-Härtung (AURA-14, AURA-18): welche Fenster Mikrofon und Bildschirm nutzen und welche IPC-Kanäle sie aufrufen
// dürfen, und keine Navigation weg von den eigenen Seiten. Die Entscheidungen sind reine Funktionen (test/security.test.js); install() hängt sie in Electron ein.
const path = require('path');
const { pathToFileURL } = require('url');

const RENDERER_DIR = path.join(__dirname, 'renderer');

// Seite → erlaubte Berechtigungen. Alles andere wird abgelehnt.
/** @type {Record<string, Set<string>>} */
const PERMISSIONS = {
  'panel.html': new Set(['media', 'display-capture']), // Chat, Spracheingabe, Live mit Bildschirm
  'rambler.html': new Set(['media']) // Diktat
};

// Name der eigenen Renderer-Seite (z. B. "panel.html") oder null, wenn die URL nicht zu Aura gehört.
/**
 * @param {unknown} url
 * @param {string} [rendererDir]
 * @returns {string | null}
 */
function rendererPage(url, rendererDir = RENDERER_DIR) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch {
    return null;
  }
  if (u.protocol !== 'file:') return null;
  const base = pathToFileURL(rendererDir + path.sep).href;
  const target = pathToFileURL(decodeURIComponent(u.pathname)).href;
  if (!target.toLowerCase().startsWith(base.toLowerCase())) return null;
  const rest = target.slice(base.length);
  return rest.includes('/') ? null : rest;
}

/**
 * @param {unknown} url
 * @param {string} permission
 * @param {string} [rendererDir]
 */
function permissionAllowed(url, permission, rendererDir = RENDERER_DIR) {
  const page = rendererPage(url, rendererDir);
  return !!page && !!PERMISSIONS[page] && PERMISSIONS[page].has(permission);
}

// IPC (AURA-18): Kanal → Seiten, die ihn aufrufen dürfen. Ein Kanal, der hier fehlt, lässt sich gar nicht erst
// registrieren (guardIpc), damit jeder neue Kanal bewusst freigegeben wird. Eine XSS in Overlay, Rambler oder dem
// Spracherkennungs-Fenster erreicht so weder Schlüssel noch MCP-Konfiguration noch den Agenten.
const PANEL = ['panel.html'];
const CONFIG = ['setup.html', 'settings.html'];
/** @type {Record<string, string[]>} */
const IPC_ACCESS = {
  'setup:done': ['setup.html'],
  'settings:get': [...PANEL, ...CONFIG],
  'settings:save': [...PANEL, ...CONFIG],
  'settings:testKey': CONFIG,
  'settings:open': PANEL,
  'open:external': [...PANEL, ...CONFIG],
  'usage:get': [...PANEL, 'settings.html'],
  'zentrale:open': [...PANEL, 'settings.html'],
  'chat:send': PANEL,
  'chat:abort': PANEL,
  'chat:transcribe': PANEL,
  'chats:list': PANEL,
  'chats:get': PANEL,
  'chats:save': PANEL,
  'chats:delete': PANEL,
  'agent:approval': PANEL,
  'agent:answer': PANEL,
  'agent:connectorAnswer': PANEL,
  'agent:takeoverAnswer': PANEL,
  'inbox:get': PANEL,
  'agent:voiceTask': PANEL,
  'agent:stop': PANEL,
  'agent:openLog': ['settings.html'],
  'agent:extensions': ['settings.html'],
  'agent:openFile': ['settings.html'],
  'panel:busy': PANEL,
  'panel:hide': PANEL,
  'panel:ignoreMouse': PANEL,
  'live:usage': PANEL,
  'live:config': PANEL,
  'live:open': PANEL,
  'live:send': PANEL,
  'live:close': PANEL,
  'live:active': PANEL,
  'live:turn': PANEL,
  'live:abortTurn': PANEL,
  'glow:level': PANEL,
  'pointer:show': PANEL,
  'pointer:clear': PANEL,
  'overlay:idle': ['overlay.html'],
  'rambler:audio': ['rambler.html'],
  'rambler:cancel': ['rambler.html'],
  'rambler:undo': ['rambler.html'],
  'rambler:full': ['rambler.html'],
  'rambler:error': ['rambler.html'],
  'stt:ready': ['stt.html'],
  'stt:result': ['stt.html'],
  'stt:progress': ['stt.html'],
  'ollama:status': CONFIG,
  'ollama:pull': CONFIG,
  'ollama:abortPull': CONFIG
};

/**
 * @param {string} channel
 * @returns {string[] | null}
 */
function ipcPages(channel) {
  if (Object.prototype.hasOwnProperty.call(IPC_ACCESS, channel)) return IPC_ACCESS[channel];
  if (/^z:[A-Za-z]+$/.test(channel)) return ['zentrale.html']; // Aura Zentrale (src/zentrale.js)
  return null;
}

// Darf die Seite unter url (event.senderFrame.url) den Kanal benutzen?
/**
 * @param {unknown} url
 * @param {string} channel
 * @param {string} [rendererDir]
 */
function ipcAllowed(url, channel, rendererDir = RENDERER_DIR) {
  const pages = ipcPages(channel);
  const page = rendererPage(url, rendererDir);
  return !!pages && !!page && pages.includes(page);
}

// Nur der Hauptframe der eigenen Seite zählt; ein zerstörter oder fremder Frame wird abgelehnt.
/**
 * @param {IpcEvent | null | undefined} event
 * @param {string} channel
 * @param {string} [rendererDir]
 */
function senderAllowed(event, channel, rendererDir = RENDERER_DIR) {
  const frame = event && event.senderFrame;
  if (!frame || frame.parent) return false;
  return ipcAllowed(frame.url, channel, rendererDir);
}

// Ersetzt handle/on/once von ipcMain durch Varianten, die den Absender prüfen. Läuft vor der ersten Registrierung
// und gilt damit für alle Module. Unbekannte Kanäle werfen schon beim Registrieren.
/**
 * The parts of an IPC event the guard reads (Electron IpcMainEvent / IpcMainInvokeEvent, or a test double).
 * @typedef {{ senderFrame?: { url: string, parent: unknown } | null }} IpcEvent
 */
/** @typedef {(event: IpcEvent, ...args: unknown[]) => unknown} IpcHandler */
/**
 * Electron's ipcMain, or an EventEmitter-based test double.
 * @typedef {object} GuardableIpc
 * @property {(channel: string, fn: IpcHandler) => void} handle
 * @property {(channel: string, fn: IpcHandler) => unknown} on
 * @property {(channel: string, fn: IpcHandler) => unknown} once
 * @property {(channel: string, fn: IpcHandler) => unknown} removeListener
 * @property {boolean} [__auraGuarded]
 */
/**
 * @template {GuardableIpc} T
 * @param {T} ipcMain
 * @param {{ rendererDir?: string, log?: (message: string) => void }} [options]
 * @returns {T}
 */
function guardIpc(ipcMain, { rendererDir = RENDERER_DIR, log = console.warn } = {}) {
  if (ipcMain.__auraGuarded) return ipcMain;
  const known = (/** @type {string} */ channel) => {
    if (!ipcPages(channel)) throw new Error(`IPC channel ${channel} has no entry in IPC_ACCESS (src/security.js)`);
  };
  const reject = (/** @type {string} */ channel, /** @type {IpcEvent} */ e) =>
    log(`IPC ${channel} from ${e && e.senderFrame ? e.senderFrame.url : 'unknown frame'} rejected`);
  const handle = ipcMain.handle.bind(ipcMain);
  const on = ipcMain.on.bind(ipcMain);
  ipcMain.handle = (channel, fn) => {
    known(channel);
    return handle(channel, (/** @type {IpcEvent} */ e, /** @type {unknown[]} */ ...args) => {
      if (!senderAllowed(e, channel, rendererDir)) {
        reject(channel, e);
        throw new Error('Not allowed');
      }
      return fn(e, ...args);
    });
  };
  const listener =
    (/** @type {string} */ channel, /** @type {IpcHandler} */ fn) =>
    (/** @type {IpcEvent} */ e, /** @type {unknown[]} */ ...args) => {
      if (!senderAllowed(e, channel, rendererDir)) return reject(channel, e);
      return fn(e, ...args);
    };
  ipcMain.on = (channel, fn) => {
    known(channel);
    return on(channel, listener(channel, fn));
  };
  // once: erst ein erlaubter Aufruf verbraucht den Listener.
  ipcMain.once = (channel, fn) => {
    known(channel);
    /** @type {IpcHandler} */
    const h = (e, ...args) => {
      if (!senderAllowed(e, channel, rendererDir)) return reject(channel, e);
      ipcMain.removeListener(channel, h);
      return fn(e, ...args);
    };
    return on(channel, h);
  };
  ipcMain.__auraGuarded = true;
  return ipcMain;
}

// Navigation nur zwischen eigenen Renderer-Seiten.
/**
 * @param {unknown} url
 * @param {string} [rendererDir]
 */
function navigationAllowed(url, rendererDir = RENDERER_DIR) {
  return rendererPage(url, rendererDir) !== null;
}

// Links, die Aura im Standardbrowser öffnen darf.
/** @param {unknown} url */
function isExternalLink(url) {
  return /^https:\/\//i.test(String(url || ''));
}

/**
 * @param {{ app: import('electron').App, session: typeof import('electron').session, shell: import('electron').Shell }} electron
 */
function install({ app, session, shell }) {
  const deny = (/** @type {{ preventDefault: () => void }} */ e) => e.preventDefault();
  app.on('web-contents-created', (_e, contents) => {
    // Neue Fenster nie in Electron öffnen; https-Links gehen an den Standardbrowser.
    contents.setWindowOpenHandler(({ url }) => {
      if (isExternalLink(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (e, url) => {
      if (!navigationAllowed(url)) deny(e);
    });
    contents.on('will-redirect', (e, url) => {
      if (!navigationAllowed(url)) deny(e);
    });
    contents.on('will-attach-webview', deny);
  });
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback) =>
    callback(permissionAllowed(wc && wc.getURL(), permission))
  );
  ses.setPermissionCheckHandler((wc, permission) => permissionAllowed(wc && wc.getURL(), permission));
}

module.exports = {
  rendererPage,
  permissionAllowed,
  navigationAllowed,
  isExternalLink,
  install,
  PERMISSIONS,
  IPC_ACCESS,
  ipcAllowed,
  senderAllowed,
  guardIpc
};
