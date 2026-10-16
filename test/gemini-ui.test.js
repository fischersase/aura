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
  assert.match(panelHtml, /id="deleteCurrentChat"/);
  assert.match(panelHtml, /id="historyClearAll"/);
  assert.match(panelHtml, /<meta name="color-scheme" content="dark light">/);

  assert.doesNotMatch(panelCss, /prefers-color-scheme:\s*light/);
  assert.match(panelCss, /:root\[data-theme="light"\]/);
  assert.match(panelCss, /\.card\.minimized/);
  assert.match(panelCss, /\.min-bar/);
  assert.match(panelJs, /applyPanelTheme/);

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

  assert.match(zHtml, /<meta name="color-scheme" content="dark light">/);
  assert.match(zHtml, /id="customizeTabs"/);
  assert.match(zHtml, /data-tab="discover"/);
  assert.match(zHtml, /data-tab="catalog"/);
  assert.match(zHtml, /data-tab="skills"/);
  assert.match(zHtml, /<search>/);
  assert.match(zHtml, /id="themeToggle"/);
  assert.match(zHtml, /id="chat"/);
  assert.match(zHtml, /id="zChatDeleteBtn"/);
  assert.match(zHtml, /id="deleteAllChats"/);
  assert.match(zHtml, /id="settings"/);
  assert.match(zHtml, /id="addCronTask"/);
  assert.match(zHtml, /id="rulesQuickList"/);

  assert.doesNotMatch(zCss, /prefers-color-scheme:\s*light/);
  assert.match(zCss, /:root\[data-theme="light"\]/);
  assert.match(zCss, /\.gem-grid/);
  assert.match(zCss, /\.gem-item/);
  assert.match(zCss, /\.nav-scroll/);
  assert.match(zCss, /\.sidebar-chat-del/);

  assert.match(zJs, /STARTER_SKILLS/);
  assert.match(zJs, /schreibstil-anpassen/);
  assert.match(zJs, /renderConnectorGrid/);
  assert.match(zJs, /renderSkillGrid/);
  assert.match(zJs, /expandedServers/);
  assert.match(zJs, /openChatInZentrale/);
  assert.match(zJs, /data-side-del/);
  assert.match(zJs, /renderQuickRules/);
  assert.match(zJs, /loadSettingsPage/);
});

test('Settings page DOM IDs in zentrale.js match zentrale.html and saveSettingsPatch returns ok', () => {
  const zHtml = read('renderer/zentrale.html');
  const zJs = read('renderer/zentrale.js');
  const mainJs = read('main.js');

  for (const id of [
    'cfgProvider',
    'cfgGeminiBlock',
    'cfgApiKey',
    'cfgTestKey',
    'cfgKeyStatus',
    'cfgChatModel',
    'cfgLiveModel',
    'cfgRamblerModel',
    'cfgDictationModel',
    'cfgLiveVoice',
    'cfgLiveFps',
    'cfgMonthlyBudget',
    'cfgUsageText',
    'cfgOllamaBlock',
    'cfgOllamaStatus',
    'cfgOllamaUrl',
    'cfgOllamaCheck',
    'cfgOllamaModel',
    'cfgOllamaPull',
    'cfgOllamaCtx',
    'cfgWhisperModel',
    'cfgHotkeyGemini',
    'cfgHotkeyRambler',
    'cfgHotkeyLive',
    'cfgHotkeyStop',
    'cfgHotkeyStatus',
    'cfgThemeSelect',
    'cfgPanelCorner',
    'cfgLanguage',
    'cfgGlowStay',
    'cfgAutostart',
    'cfgSaveStatus',
    'cfgSaveBtn'
  ]) {
    assert.ok(zHtml.includes(`id="${id}"`), `zentrale.html has #${id}`);
    assert.ok(zJs.includes(`$('${id}')`), `zentrale.js binds #${id}`);
  }
  assert.match(mainJs, /ok:\s*!keyError/);
});

test('Windows app icon, Aura Ring + Center Dot in panel/Zentrale, and Rambler (Alt+D) 3-part pill UI', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const mainJs = read('main.js');
  const storeJs = read('store.js');
  const keysJs = read('keys.js');
  const panelHtml = read('renderer/panel.html');
  const panelCss = read('renderer/panel.css');
  const zHtml = read('renderer/zentrale.html');
  const ramblerHtml = read('renderer/rambler.html');
  const ramblerJs = read('renderer/rambler.js');

  // Windows executable icon embedding & AppUserModelId
  assert.strictEqual(pkg.build.win.icon, 'assets/icon.ico');
  assert.notStrictEqual(pkg.build.win.signAndEditExecutable, false);
  assert.match(mainJs, /process\.platform === 'win32' \? 'icon\.ico' : 'icon\.png'/);
  assert.match(mainJs, /setAppUserModelId\('io\.github\.fischersase\.aura'\)/);

  // Small panel and Zentrale greeting use the Aura Ring + Center Dot instead of the 4-pointed Gemini star
  assert.match(panelHtml, /<symbol id="spark"[^>]*><path fill="url\(#g\)" fill-rule="evenodd"/);
  assert.doesNotMatch(panelHtml, /12 2c\.6 5\.3/);
  assert.match(panelCss, /button svg\.spark\s*\{\s*stroke:\s*none;/);
  assert.match(zHtml, /class="zchat-greet-icon"[\s\S]*?fill-rule="evenodd"/);

  // Rambler defaults to Alt+D, uses 3-part pill UI (cancel X, purple waveform capsule, confirm checkmark), and Win32 keybd_event
  assert.match(storeJs, /hotkeyRambler:\s*'Alt\+D'/);
  assert.match(ramblerHtml, /class="pill-cancel"/);
  assert.match(ramblerHtml, /id="capsule" class="capsule"/);
  assert.match(ramblerHtml, /class="pill-confirm"/);
  assert.match(ramblerJs, /centerBoost/);
  assert.match(keysJs, /keybd_event/);
  assert.match(mainJs, /transcribe\(wavBase64,\s*whisperLanguage\(s\.language\)\)/);
});
