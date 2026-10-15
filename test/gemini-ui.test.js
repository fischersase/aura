// Tests for the Google Gemini dark minimalist UI and panel minimize/persistence behavior.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

test('panel supports minimizing to bottom-right pill and preserves active chat session', () => {
  const panelHtml = read('renderer/panel.html');
  const panelCss = read('renderer/panel.css');
  const panelJs = read('renderer/panel.js');
  const mainJs = read('main.js');

  assert.match(panelHtml, /id="minimizedBar"/);
  assert.match(panelHtml, /id="minimizeBtn"/);
  assert.match(panelHtml, /id="restoreBtn"/);
  assert.match(panelHtml, /<meta name="color-scheme" content="dark">/);

  assert.doesNotMatch(panelCss, /prefers-color-scheme:\s*light/);
  assert.match(panelCss, /\.card\.minimized/);
  assert.match(panelCss, /\.min-bar/);

  // Opening the panel must not wipe the current conversation via resetChat()
  const openBlock = panelJs.slice(
    panelJs.indexOf('window.api.onPanelOpen'),
    panelJs.indexOf('window.api.onPanelClose')
  );
  assert.doesNotMatch(openBlock, /resetChat\(\)/);
  assert.match(panelJs, /window\.api\.onPanelMinimize/);
  assert.match(panelJs, /window\.api\.onPanelRestore/);
  assert.match(panelJs, /window\.api\.minimizePanel/);
  assert.match(panelJs, /window\.api\.restorePanel/);

  assert.match(mainJs, /function minimizePanel\(\)/);
  assert.match(mainJs, /function restorePanel\(\)/);
  assert.match(mainJs, /ipcMain\.on\('panel:minimize'/);
  assert.match(mainJs, /ipcMain\.on\('panel:restore'/);
});

test('Aura Zentrale implements minimalist dark Google Gemini layout for Connectors and Skills', () => {
  const zHtml = read('renderer/zentrale.html');
  const zCss = read('renderer/zentrale.css');
  const zJs = read('renderer/zentrale.js');

  assert.match(zHtml, /<meta name="color-scheme" content="dark">/);
  assert.match(zHtml, /id="customizeTabs"/);
  assert.match(zHtml, /data-tab="discover"/);
  assert.match(zHtml, /data-tab="catalog"/);
  assert.match(zHtml, /data-tab="skills"/);
  assert.match(zHtml, /<search>/);

  assert.doesNotMatch(zCss, /prefers-color-scheme:\s*light/);
  assert.match(zCss, /\.gem-grid/);
  assert.match(zCss, /\.gem-item/);

  assert.match(zJs, /STARTER_SKILLS/);
  assert.match(zJs, /schreibstil-anpassen/);
  assert.match(zJs, /renderConnectorGrid/);
  assert.match(zJs, /renderSkillGrid/);
});
