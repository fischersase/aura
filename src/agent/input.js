// Maus und Tastatur für den Agenten: klicken, tippen, Tastenkombinationen.
// Windows: PowerShell mit user32 (SetCursorPos, mouse_event) und SendKeys.
// Linux: xdotool (X11), unter Wayland wtype (Tastatur) bzw. ydotool (Maus und Tastatur).
const { execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const WAYLAND = process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY;

const run = (cmd, args, timeout = 15000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, err: err ? String(stderr || err.message).trim() : '' }));
});

const ps = (script) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);

const WIN_USER32 = 'Add-Type @"\nusing System; using System.Runtime.InteropServices;\n' +
  'public static class U { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' +
  ' [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);' +
  ' [DllImport("user32.dll")] public static extern void mouse_event(int f, int dx, int dy, int d, int e); }\n"@;\n';

async function linuxTry(cands) {
  const errs = [];
  for (const [cmd, args] of cands) {
    const r = await run(cmd, args);
    if (r.ok) return { ok: true, via: cmd };
    errs.push(`${cmd}: ${r.err || 'nicht verfügbar'}`);
  }
  return { error: 'Konnte nicht ausgeführt werden. Unter Linux wird xdotool (X11) bzw. ydotool/wtype (Wayland) gebraucht. ' + errs.join('; ') };
}

// x, y in echten Bildschirm-Pixeln.
async function click(x, y, { button = 'left', double = false } = {}) {
  x = Math.round(x); y = Math.round(y);
  if (IS_WIN) {
    const [down, up] = button === 'right' ? [0x08, 0x10] : [0x02, 0x04];
    const one = `[U]::mouse_event(${down},0,0,0,0); [U]::mouse_event(${up},0,0,0,0);`;
    const r = await ps(WIN_USER32 + `[U]::SetProcessDPIAware() | Out-Null; [U]::SetCursorPos(${x},${y}) | Out-Null; Start-Sleep -Milliseconds 60; ${one}${double ? ' Start-Sleep -Milliseconds 80; ' + one : ''}`);
    return r.ok ? { ok: true } : { error: r.err };
  }
  const btn = button === 'right' ? '3' : '1';
  const ydoBtn = button === 'right' ? '0xC1' : '0xC0';
  const cands = [
    ['xdotool', ['mousemove', String(x), String(y), 'click', ...(double ? ['--repeat', '2'] : []), btn]],
    ['ydotool', ['mousemove', '--absolute', '-x', String(x), '-y', String(y)]]
  ];
  if (WAYLAND) cands.reverse();
  const r = await linuxTry(cands);
  if (r.ok && r.via === 'ydotool') {
    await run('ydotool', ['click', ...(double ? ['--repeat', '2'] : []), ydoBtn]);
  }
  return r;
}

// SendKeys-Sonderzeichen in geschweifte Klammern setzen.
const sendKeysEscape = (t) => t.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`).replace(/\r?\n/g, '{ENTER}');
const psQuote = (t) => "'" + t.replace(/'/g, "''") + "'";

async function typeText(text) {
  const t = String(text || '');
  if (IS_WIN) {
    const r = await ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${psQuote(sendKeysEscape(t))})`);
    return r.ok ? { ok: true } : { error: r.err };
  }
  const cands = [['xdotool', ['type', '--delay', '8', '--', t]], ['wtype', ['--', t]], ['ydotool', ['type', '--', t]]];
  if (WAYLAND) cands.push(cands.shift());
  return linuxTry(cands);
}

// "ctrl+shift+s", "enter", "alt+f4", "f5" …
const WIN_NAMES = { enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}', backspace: '{BS}', delete: '{DEL}', del: '{DEL}',
  up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}', space: ' ', insert: '{INS}' };
const X_NAMES = { enter: 'Return', return: 'Return', tab: 'Tab', esc: 'Escape', escape: 'Escape', backspace: 'BackSpace', delete: 'Delete', del: 'Delete',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next', space: 'space', insert: 'Insert',
  win: 'super', super: 'super', meta: 'super', cmd: 'super', control: 'ctrl', strg: 'ctrl' };

async function pressKeys(combo) {
  const parts = String(combo || '').toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { error: 'Keine Tasten angegeben.' };
  const key = parts.pop();
  const mods = parts;
  if (IS_WIN) {
    if (mods.some((m) => ['win', 'super', 'meta', 'cmd'].includes(m)) || ['win', 'super'].includes(key)) {
      return { error: 'Die Windows-Taste geht hier nicht; nutze open oder run_command.' };
    }
    const prefix = mods.map((m) => ({ ctrl: '^', control: '^', strg: '^', shift: '+', alt: '%' }[m] || '')).join('');
    const k = WIN_NAMES[key] || (/^f\d{1,2}$/.test(key) ? `{${key.toUpperCase()}}` : sendKeysEscape(key));
    const r = await ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${psQuote(prefix + k)})`);
    return r.ok ? { ok: true } : { error: r.err };
  }
  const xKey = X_NAMES[key] || (/^f\d{1,2}$/.test(key) ? key.toUpperCase() : key);
  const xMods = mods.map((m) => X_NAMES[m] || m);
  const wArgs = [];
  xMods.forEach((m) => wArgs.push('-M', m === 'super' ? 'logo' : m));
  if (key.length === 1) wArgs.push(key); else wArgs.push('-k', xKey);
  xMods.slice().reverse().forEach((m) => wArgs.push('-m', m === 'super' ? 'logo' : m));
  const cands = [['xdotool', ['key', '--clearmodifiers', [...xMods, xKey].join('+')]], ['wtype', wArgs]];
  if (WAYLAND) cands.reverse();
  return linuxTry(cands);
}

module.exports = { click, typeText, pressKeys };
