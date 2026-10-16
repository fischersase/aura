// Sendet Tastendrücke (Strg+C, Strg+V, Strg+Z) an das aktive Fenster.
// Windows: ein dauerhaft laufender PowerShell-Prozess mit Win32 keybd_event (keine nativen Node-Module).
// Linux: xdotool (X11) bzw. wtype oder ydotool (Wayland), falls installiert.
const { spawn, execFile } = require('child_process');

const SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms;',
  'Add-Type @"',
  'using System; using System.Runtime.InteropServices;',
  'public static class KB {',
  '  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);',
  '  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);',
  '  public static void SendCtrl(byte vk) {',
  '    keybd_event(0x12, 0, 2, UIntPtr.Zero);', // Alt loslassen, falls noch gedrückt
  '    keybd_event(0x10, 0, 2, UIntPtr.Zero);', // Shift loslassen
  '    keybd_event(0x11, 0, 0, UIntPtr.Zero);', // Ctrl drücken
  '    keybd_event(vk, 0, 0, UIntPtr.Zero);',
  '    keybd_event(vk, 0, 2, UIntPtr.Zero);',
  '    keybd_event(0x11, 0, 2, UIntPtr.Zero);', // Ctrl loslassen
  '  }',
  '}',
  '"@;',
  // Warten, bis Strg/Alt/Shift/Win losgelassen sind, damit z. B. Alt+D nicht zu Strg+Alt+V wird.
  'function WaitMods { for($i=0;$i -lt 75;$i++){ $d=$false; foreach($k in 0x10,0x11,0x12,0x5B,0x5C){ if([KB]::GetAsyncKeyState($k) -band 0x8000){$d=$true} }; if(-not $d){return}; Start-Sleep -Milliseconds 15 } }',
  'while(($l=[Console]::In.ReadLine()) -ne $null){ WaitMods; if($l -eq "^v"){ [KB]::SendCtrl(0x56) } elseif($l -eq "^c"){ [KB]::SendCtrl(0x43) } elseif($l -eq "^z"){ [KB]::SendCtrl(0x5A) } else { [System.Windows.Forms.SendKeys]::SendWait($l) }; [Console]::Out.WriteLine("ok") }'
].join('\n');

let proc = null;
let queue = [];
let buffer = '';

function ensure() {
  if (process.platform !== 'win32') return null;
  if (proc && !proc.killed) return proc;
  proc = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-Sta', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {
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

// ---------- Linux ----------

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000 }, (err) => resolve(!err));
  });
const runOut = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 1500 }, (err, stdout) => resolve(err ? '' : String(stdout || '').trim()));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Aktives X11/XWayland-Fenster vor dem Einblenden der Rambler-Pille merken, damit Klicks auf ✓ den Fokus nicht verlieren.
async function activeWindow() {
  if (process.platform !== 'linux') return '';
  const id = await runOut('xdotool', ['getactivewindow']);
  return /^\d+$/.test(id) ? id : '';
}

// Linux-Tastencodes für ydotool: KEY_LEFTCTRL=29, C=46, V=47, Z=44
const YDO = { c: 46, v: 47, z: 44 };
let linuxTool; // zuletzt funktionierendes Werkzeug merken

async function sendLinux(key, winId = '') {
  const letter = key.replace('^', '');
  const wayland = process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY;
  const tools = {
    xdotool: async () => {
      if (winId && /^\d+$/.test(String(winId))) {
        await run('xdotool', ['windowactivate', '--sync', String(winId)]);
      }
      return run('xdotool', ['key', '--clearmodifiers', `ctrl+${letter}`]);
    },
    wtype: () => run('wtype', ['-M', 'ctrl', letter, '-m', 'ctrl']),
    ydotool: () => run('ydotool', ['key', '29:1', `${YDO[letter]}:1`, `${YDO[letter]}:0`, '29:0'])
  };
  const order = linuxTool ? [linuxTool] : wayland ? ['wtype', 'ydotool', 'xdotool'] : ['xdotool', 'ydotool'];
  // Kurz warten, damit die Finger vom Kürzel (Alt+D) weg sind.
  await sleep(wayland ? 120 : 60);
  for (const t of order) {
    if (await tools[t]()) {
      linuxTool = t;
      return true;
    }
  }
  linuxTool = undefined;
  return false;
}

// keys im SendKeys-Format: '^c' = Strg+C, '^v' = Strg+V, '^z' = Strg+Z.
// Liefert false, wenn keine Tasten gesendet werden konnten.
function send(keys, winId = '') {
  if (process.platform === 'linux') return sendLinux(keys, winId);
  const p = ensure();
  if (!p) return Promise.resolve(false);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(true), 3000);
    queue.push(() => {
      clearTimeout(t);
      resolve(true);
    });
    p.stdin.write(keys + '\n');
  });
}

function shutdown() {
  if (proc) proc.kill();
}

module.exports = { send, activeWindow, ensure, shutdown };
