// Windows autostart cleanup (AURA-114): entries of an old portable Aura are found, this Aura and others are kept.
const test = require('node:test');
const assert = require('node:assert');
const { parseRunKey, staleAuraEntries } = require('../src/win-autostart');

const OUT = [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  '    OneDrive    REG_SZ    "C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe" /background',
  '    electron.app.Aura    REG_SZ    "C:\\Users\\u\\Downloads\\Aura.exe"',
  '    Aura old    REG_SZ    C:\\Users\\u\\Desktop\\Aura-0.9.2-portable.exe --hidden',
  '    aura-desktop    REG_SZ    "C:\\Users\\u\\AppData\\Local\\Programs\\aura-desktop\\Aura.exe"',
  '    Discord    REG_EXPAND_SZ    %LOCALAPPDATA%\\Discord\\Update.exe --processStart Discord.exe',
  ''
].join('\r\n');

test('Run key output is parsed into names and commands', () => {
  const e = parseRunKey(OUT);
  assert.deepStrictEqual(
    e.map((x) => x.name),
    ['OneDrive', 'electron.app.Aura', 'Aura old', 'aura-desktop', 'Discord']
  );
});

test('only other Aura executables are stale', () => {
  const self = 'C:\\Users\\U\\AppData\\Local\\Programs\\aura-desktop\\Aura.exe'; // case differs
  assert.deepStrictEqual(
    staleAuraEntries(parseRunKey(OUT), self).map((x) => x.name),
    ['electron.app.Aura', 'Aura old']
  );
});
