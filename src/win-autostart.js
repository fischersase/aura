// @ts-check
// Windows autostart cleanup (AURA-114). Up to 0.10.x Aura was a portable .exe that registered itself in
// HKCU\...\Run. If such an entry survives, the old version starts at login, holds the single-instance lock, and the
// installed Aura hands over to it and quits. Entries that start a different Aura.exe than this one are removed.
const { execFile } = require('child_process');
const path = require('path');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

/**
 * Output of `reg query <Run key>` → value name and command.
 * @param {string} out
 */
function parseRunKey(out) {
  /** @type {{ name: string, data: string }[]} */
  const entries = [];
  for (const line of String(out).split(/\r?\n/)) {
    const m = /^\s{2,}(.+?)\s{2,}REG_(?:EXPAND_)?SZ\s{2,}(.*)$/.exec(line);
    if (m) entries.push({ name: m[1], data: m[2].trim() });
  }
  return entries;
}

/** Program a Run command starts (quoted or the first token). */
function programOf(/** @type {string} */ data) {
  const m = /^"([^"]+)"/.exec(data) || /^(\S+)/.exec(data);
  return m ? m[1] : '';
}

/**
 * Run entries that start another Aura.exe (or an old portable "Aura-x.y.z-portable.exe") than `exe`.
 * @param {{ name: string, data: string }[]} entries
 * @param {string} exe this Aura.exe
 */
function staleAuraEntries(entries, exe) {
  const self = path.win32.normalize(exe).toLowerCase();
  return entries.filter((e) => {
    const prog = programOf(e.data);
    const base = path.win32.basename(prog).toLowerCase();
    const aura = base === 'aura.exe' || (base.startsWith('aura-') && base.endsWith('-portable.exe'));
    if (!aura) return false;
    return path.win32.normalize(prog).toLowerCase() !== self;
  });
}

/** Removes stale entries; errors are ignored (autostart is a convenience). @param {string} exe */
function removeStaleAutostart(exe) {
  execFile('reg', ['query', RUN_KEY], { windowsHide: true }, (err, out) => {
    if (err) return;
    for (const e of staleAuraEntries(parseRunKey(out), exe))
      execFile('reg', ['delete', RUN_KEY, '/v', e.name, '/f'], { windowsHide: true }, () => {});
  });
}

module.exports = { parseRunKey, staleAuraEntries, removeStaleAutostart };
