// Electron-Härtung (src/security.js, AURA-14): Berechtigungen nur für die richtigen Fenster, keine fremde Navigation.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');
const sec = require('../src/security');

const DIR = path.join(
  path.sep === '\\' ? 'C:\\Program Files\\Aura' : '/opt/Aura',
  'resources',
  'app.asar',
  'src',
  'renderer'
);
const page = (name, extra = '') => pathToFileURL(path.join(DIR, name)).href + extra;

test('Mikrofon nur für Panel und Rambler, Bildschirm nur für das Panel', () => {
  assert.strictEqual(sec.permissionAllowed(page('panel.html'), 'media', DIR), true);
  assert.strictEqual(sec.permissionAllowed(page('panel.html'), 'display-capture', DIR), true);
  assert.strictEqual(sec.permissionAllowed(page('rambler.html', '?x=1#y'), 'media', DIR), true);
  assert.strictEqual(sec.permissionAllowed(page('rambler.html'), 'display-capture', DIR), false);
  for (const p of ['overlay.html', 'settings.html', 'setup.html', 'zentrale.html', 'stt.html']) {
    assert.strictEqual(sec.permissionAllowed(page(p), 'media', DIR), false, p);
    assert.strictEqual(sec.permissionAllowed(page(p), 'display-capture', DIR), false, p);
  }
  assert.strictEqual(sec.permissionAllowed(page('panel.html'), 'geolocation', DIR), false);
  assert.strictEqual(sec.permissionAllowed(page('panel.html'), 'notifications', DIR), false);
});

test('fremde Seiten und Pfade außerhalb des Renderer-Ordners bekommen nichts', () => {
  for (const url of [
    'https://example.com/panel.html',
    'http://127.0.0.1:47800/panel.html',
    'file:///tmp/panel.html',
    page('../panel.html'),
    page('sub/panel.html'),
    'data:text/html,<p>',
    'javascript:alert(1)',
    '',
    undefined,
    'not a url'
  ]) {
    assert.strictEqual(sec.permissionAllowed(url, 'media', DIR), false, String(url));
    assert.strictEqual(sec.navigationAllowed(url, DIR), false, String(url));
  }
});

test('Navigation nur zwischen eigenen Seiten; externe Links nur https', () => {
  assert.strictEqual(sec.navigationAllowed(page('zentrale.html'), DIR), true);
  assert.strictEqual(sec.isExternalLink('https://ai.google.dev'), true);
  for (const u of ['http://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'smb://x/y']) {
    assert.strictEqual(sec.isExternalLink(u), false, u);
  }
});

test('install hängt Handler ein: neue Fenster abgelehnt, fremde Navigation verhindert', () => {
  const events = {};
  const app = {
    on: (name, fn) => {
      events[name] = fn;
    }
  };
  const handlers = {};
  const session = {
    defaultSession: {
      setPermissionRequestHandler: (fn) => {
        handlers.request = fn;
      },
      setPermissionCheckHandler: (fn) => {
        handlers.check = fn;
      }
    }
  };
  const opened = [];
  sec.install({ app, session, shell: { openExternal: (u) => opened.push(u) } });
  const contentsEvents = {};
  let openHandler;
  events['web-contents-created'](
    {},
    {
      setWindowOpenHandler: (fn) => {
        openHandler = fn;
      },
      on: (n, fn) => {
        contentsEvents[n] = fn;
      }
    }
  );
  assert.deepStrictEqual(openHandler({ url: 'https://example.com' }), { action: 'deny' });
  assert.deepStrictEqual(openHandler({ url: 'file:///etc/passwd' }), { action: 'deny' });
  assert.deepStrictEqual(opened, ['https://example.com']);
  let prevented = false;
  contentsEvents['will-navigate'](
    {
      preventDefault: () => {
        prevented = true;
      }
    },
    'https://evil.example'
  );
  assert.strictEqual(prevented, true);
  let granted;
  handlers.request({ getURL: () => 'https://evil.example' }, 'media', (ok) => {
    granted = ok;
  });
  assert.strictEqual(granted, false);
  assert.strictEqual(handlers.check(null, 'media'), false);
});

// Windows (regression, v0.18): Electron reports file:///C:/Users/<name with spaces>/…/panel.html. Every IPC call from the
// corner chat and the Zentrale was rejected because the URL was not converted to a Windows path.
test('Windows: own pages are recognised (drive letter, spaces, other case); foreign paths are not', () => {
  const winDir =
    'C:\\Users\\Sebastian Fischer\\AppData\\Local\\Programs\\aura-desktop\\resources\\app.asar\\src\\renderer';
  const base =
    'file:///C:/Users/Sebastian%20Fischer/AppData/Local/Programs/aura-desktop/resources/app.asar/src/renderer/';
  const win = (url) => sec.rendererPage(url, winDir, 'win32');
  assert.strictEqual(win(base + 'panel.html'), 'panel.html');
  assert.strictEqual(win(base + 'zentrale.html?x=1#y'), 'zentrale.html');
  assert.strictEqual(win(base.replace('file:///C:', 'file:///c:').toLowerCase() + 'panel.html'), 'panel.html');
  for (const bad of [
    base + 'sub/panel.html',
    base + '../panel.html',
    base + '..%5Cpanel.html',
    'file:///C:/Users/Other/panel.html',
    'file:///D:/Users/Sebastian%20Fischer/AppData/Local/Programs/aura-desktop/resources/app.asar/src/renderer/panel.html',
    'file://evil-host/share/panel.html',
    'https://example.com/panel.html'
  ]) {
    assert.strictEqual(win(bad), null, bad);
  }
});
