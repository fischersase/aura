// Sendet Tastendrücke (Strg+C, Strg+V, Strg+Z) an das aktive Fenster.
// Ein dauerhaft laufender PowerShell-Prozess vermeidet native Node-Module.
const { spawn } = require('child_process');

const SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms;',
  'Add-Type @"',
  'using System; using System.Runtime.InteropServices;',
  'public static class KB { [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k); }',
  '"@;',
  // Warten, bis Strg/Alt/Shift/Win losgelassen sind, damit z. B. Strg+Alt+D nicht zu Strg+Alt+C wird.
  'function WaitMods { for($i=0;$i -lt 100;$i++){ $d=$false; foreach($k in 0x10,0x11,0x12,0x5B,0x5C){ if([KB]::GetAsyncKeyState($k) -band 0x8000){$d=$true} }; if(-not $d){return}; Start-Sleep -Milliseconds 20 } }',
  'while(($l=[Console]::In.ReadLine()) -ne $null){ WaitMods; [System.Windows.Forms.SendKeys]::SendWait($l); [Console]::Out.WriteLine("ok") }'
].join('\n');

let proc = null;
let queue = [];
let buffer = '';

function ensure() {
  if (process.platform !== 'win32') return null;
  if (proc && !proc.killed) return proc;
  proc = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore']
  });
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      buffer = buffer.slice(i + 1);
      const next = queue.shift();
      if (next) next();
    }
  });
  proc.on('exit', () => {
    proc = null;
    queue.splice(0).forEach((r) => r());
  });
  return proc;
}

// keys im SendKeys-Format: '^c' = Strg+C, '^v' = Strg+V, '^z' = Strg+Z
function send(keys) {
  const p = ensure();
  if (!p) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 3000);
    queue.push(() => { clearTimeout(t); resolve(); });
    p.stdin.write(keys + '\n');
  });
}

function shutdown() {
  if (proc) proc.kill();
}

module.exports = { send, ensure, shutdown };
