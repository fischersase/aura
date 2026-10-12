// Electron-Härtung (AURA-14): welche Fenster Mikrofon und Bildschirm nutzen dürfen, und keine Navigation weg von den
// eigenen Seiten. Die Entscheidungen sind reine Funktionen (test/security.test.js); install() hängt sie in Electron ein.
const path = require('path');
const { pathToFileURL } = require('url');

const RENDERER_DIR = path.join(__dirname, 'renderer');

// Seite → erlaubte Berechtigungen. Alles andere wird abgelehnt.
const PERMISSIONS = {
  'panel.html': new Set(['media', 'display-capture']), // Chat, Spracheingabe, Live mit Bildschirm
  'rambler.html': new Set(['media']) // Diktat
};

// Name der eigenen Renderer-Seite (z. B. "panel.html") oder null, wenn die URL nicht zu Aura gehört.
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

function permissionAllowed(url, permission, rendererDir = RENDERER_DIR) {
  const page = rendererPage(url, rendererDir);
  return !!page && !!PERMISSIONS[page] && PERMISSIONS[page].has(permission);
}

// Navigation nur zwischen eigenen Renderer-Seiten.
function navigationAllowed(url, rendererDir = RENDERER_DIR) {
  return rendererPage(url, rendererDir) !== null;
}

// Links, die Aura im Standardbrowser öffnen darf.
function isExternalLink(url) {
  return /^https:\/\//i.test(String(url || ''));
}

function install({ app, session, shell }) {
  const deny = (e) => e.preventDefault();
  app.on('web-contents-created', (_e, contents) => {
    // Neue Fenster nie in Electron öffnen; https-Links gehen an den Standardbrowser.
    contents.setWindowOpenHandler(({ url }) => {
      if (isExternalLink(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (e, url) => { if (!navigationAllowed(url)) deny(e); });
    contents.on('will-redirect', (e, url) => { if (!navigationAllowed(url)) deny(e); });
    contents.on('will-attach-webview', deny);
  });
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(permissionAllowed(wc && wc.getURL(), permission)));
  ses.setPermissionCheckHandler((wc, permission) => permissionAllowed(wc && wc.getURL(), permission));
}

module.exports = { rendererPage, permissionAllowed, navigationAllowed, isExternalLink, install, PERMISSIONS };
