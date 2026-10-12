// electron-builder afterPack: Dateirechte im fertigen App-Ordner vereinheitlichen (AURA-21).
// Ohne das hängen die Rechte im Paket vom umask des Build-Rechners ab (lintian: non-standard-file-perm 0664).
const fs = require('fs');
const path = require('path');

function dropGroupWrite(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    const mode = fs.statSync(p).mode;
    if (mode & 0o022) fs.chmodSync(p, mode & ~0o022);
    if (entry.isDirectory()) dropGroupWrite(p);
  }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  dropGroupWrite(context.appOutDir);
};
