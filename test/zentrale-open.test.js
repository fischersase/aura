// "Datei öffnen" in the Zentrale (AURA-111): files are revealed in the file manager, folders opened.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

function loadZentrale() {
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'electron')
      return { BrowserWindow: class {}, ipcMain: {}, shell: {}, safeStorage: {}, app: { getPath: () => '/tmp' } };
    return orig.call(this, req, ...rest);
  };
  try {
    delete require.cache[require.resolve('../src/zentrale')];
    return require('../src/zentrale');
  } finally {
    Module._load = orig;
  }
}

test('files are shown in the folder, never handed to the default app (Firefox snap cannot read ~/.aura)', () => {
  const { revealOrOpen } = loadZentrale();
  const calls = [];
  const shell = { showItemInFolder: (p) => calls.push(['reveal', p]), openPath: (p) => calls.push(['open', p]) };
  revealOrOpen('/home/u/.aura/mcp.json', true, shell);
  revealOrOpen('/home/u/.aura/skills', false, shell);
  assert.deepStrictEqual(calls, [
    ['reveal', '/home/u/.aura/mcp.json'],
    ['open', '/home/u/.aura/skills']
  ]);
});
