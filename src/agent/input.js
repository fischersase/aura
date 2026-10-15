// Maus und Tastatur für den Agenten: klicken, bewegen, ziehen, scrollen, tippen, Tastenkombinationen.
// Windows: PowerShell mit user32 (SetCursorPos, mouse_event) und SendKeys.
// macOS: osascript (JXA CoreGraphics / System Events) bzw. cliclick.
// Linux: xdotool (X11), unter Wayland wtype (Tastatur) bzw. ydotool (Maus und Tastatur).
const { execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const WAYLAND = process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY;

const run = (cmd, args, timeout = 15000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, windowsHide: true }, (err, _stdout, stderr) =>
    resolve({ ok: !err, err: err ? String(stderr || err.message).trim() : '' })
  );
});

const ps = (script) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
const jxa = (script) => run('osascript', ['-l', 'JavaScript', '-e', script]);

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
async function move(x, y) {
  x = Math.round(x); y = Math.round(y);
  if (IS_WIN) {
    const r = await ps(WIN_USER32 + `[U]::SetProcessDPIAware() | Out-Null; [U]::SetCursorPos(${x},${y}) | Out-Null`);
    return r.ok ? { ok: true } : { error: r.err };
  }
  if (IS_MAC) {
    const r = await jxa(
      `ObjC.import('CoreGraphics'); const p = $.CGPointMake(${x}, ${y}); ` +
      `const e = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, p, $.kCGMouseButtonLeft); ` +
      `$.CGEventPost($.kCGHIDEventTap, e);`
    );
    return r.ok ? { ok: true } : { error: r.err };
  }
  const cands = [
    ['xdotool', ['mousemove', String(x), String(y)]],
    ['ydotool', ['mousemove', '--absolute', '-x', String(x), '-y', String(y)]]
  ];
  if (WAYLAND) cands.reverse();
  return linuxTry(cands);
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
  if (IS_MAC) {
    const downType = button === 'right' ? '$.kCGEventRightMouseDown' : '$.kCGEventLeftMouseDown';
    const upType = button === 'right' ? '$.kCGEventRightMouseUp' : '$.kCGEventLeftMouseUp';
    const btnConst = button === 'right' ? '$.kCGMouseButtonRight' : '$.kCGMouseButtonLeft';
    const r = await jxa(
      `ObjC.import('CoreGraphics'); const p = $.CGPointMake(${x}, ${y}); ` +
      `function one(clickState) { ` +
      `const d = $.CGEventCreateMouseEvent(null, ${downType}, p, ${btnConst}); ` +
      `$.CGEventSetIntegerValueField(d, $.kCGMouseEventClickState, clickState); $.CGEventPost($.kCGHIDEventTap, d); ` +
      `const u = $.CGEventCreateMouseEvent(null, ${upType}, p, ${btnConst}); ` +
      `$.CGEventSetIntegerValueField(u, $.kCGMouseEventClickState, clickState); $.CGEventPost($.kCGHIDEventTap, u); ` +
      `} one(1); ${double ? 'delay(0.06); one(2);' : ''}`
    );
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

async function drag(x1, y1, x2, y2, { button = 'left' } = {}) {
  x1 = Math.round(x1); y1 = Math.round(y1);
  x2 = Math.round(x2); y2 = Math.round(y2);
  if (IS_WIN) {
    const [down, up] = button === 'right' ? [0x08, 0x10] : [0x02, 0x04];
    const r = await ps(
      WIN_USER32 +
      `[U]::SetProcessDPIAware() | Out-Null; [U]::SetCursorPos(${x1},${y1}) | Out-Null; Start-Sleep -Milliseconds 60; ` +
      `[U]::mouse_event(${down},0,0,0,0); Start-Sleep -Milliseconds 60; ` +
      `[U]::SetCursorPos(${x2},${y2}) | Out-Null; Start-Sleep -Milliseconds 80; ` +
      `[U]::mouse_event(${up},0,0,0,0);`
    );
    return r.ok ? { ok: true } : { error: r.err };
  }
  if (IS_MAC) {
    const downType = button === 'right' ? '$.kCGEventRightMouseDown' : '$.kCGEventLeftMouseDown';
    const dragType = button === 'right' ? '$.kCGEventRightMouseDragged' : '$.kCGEventLeftMouseDragged';
    const upType = button === 'right' ? '$.kCGEventRightMouseUp' : '$.kCGEventLeftMouseUp';
    const btnConst = button === 'right' ? '$.kCGMouseButtonRight' : '$.kCGMouseButtonLeft';
    const r = await jxa(
      `ObjC.import('CoreGraphics'); ` +
      `const p1 = $.CGPointMake(${x1}, ${y1}); const p2 = $.CGPointMake(${x2}, ${y2}); ` +
      `$.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, ${downType}, p1, ${btnConst})); delay(0.06); ` +
      `$.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, ${dragType}, p2, ${btnConst})); delay(0.06); ` +
      `$.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, ${upType}, p2, ${btnConst}));`
    );
    return r.ok ? { ok: true } : { error: r.err };
  }
  const btn = button === 'right' ? '3' : '1';
  const ydoDown = button === 'right' ? '0x41' : '0x40';
  const ydoUp = button === 'right' ? '0x81' : '0x80';
  if (!WAYLAND) {
    const r = await run('xdotool', [
      'mousemove', String(x1), String(y1),
      'mousedown', btn,
      'mousemove', '--sync', String(x2), String(y2),
      'mouseup', btn
    ]);
    if (r.ok) return { ok: true, via: 'xdotool' };
  }
  const m1 = await run('ydotool', ['mousemove', '--absolute', '-x', String(x1), '-y', String(y1)]);
  if (m1.ok) {
    await run('ydotool', ['click', ydoDown]);
    await run('ydotool', ['mousemove', '--absolute', '-x', String(x2), '-y', String(y2)]);
    await run('ydotool', ['click', ydoUp]);
    return { ok: true, via: 'ydotool' };
  }
  return linuxTry([
    ['xdotool', ['mousemove', String(x1), String(y1), 'mousedown', btn, 'mousemove', '--sync', String(x2), String(y2), 'mouseup', btn]]
  ]);
}

async function scroll(x, y, { direction = 'down', amount = 3 } = {}) {
  x = Math.round(x); y = Math.round(y);
  const steps = Math.max(1, Math.min(20, Math.round(Number(amount) || 3)));
  const dir = String(direction || 'down').toLowerCase();
  if (IS_WIN) {
    const isHoriz = dir === 'left' || dir === 'right';
    const flag = isHoriz ? 0x01000 : 0x0800; // MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL
    const sign = (dir === 'up' || dir === 'right') ? 1 : -1;
    const delta = sign * steps * 120;
    const r = await ps(
      WIN_USER32 +
      `[U]::SetProcessDPIAware() | Out-Null; [U]::SetCursorPos(${x},${y}) | Out-Null; Start-Sleep -Milliseconds 40; ` +
      `[U]::mouse_event(${flag},0,0,${delta},0);`
    );
    return r.ok ? { ok: true } : { error: r.err };
  }
  if (IS_MAC) {
    const dy = dir === 'up' ? steps * 3 : dir === 'down' ? -steps * 3 : 0;
    const dx = dir === 'left' ? steps * 3 : dir === 'right' ? -steps * 3 : 0;
    const r = await jxa(
      `ObjC.import('CoreGraphics'); const p = $.CGPointMake(${x}, ${y}); ` +
      `$.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, p, $.kCGMouseButtonLeft)); ` +
      `const s = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 2, ${dy}, ${dx}); ` +
      `$.CGEventPost($.kCGHIDEventTap, s);`
    );
    return r.ok ? { ok: true } : { error: r.err };
  }
  // X11 buttons: 4=up, 5=down, 6=left, 7=right
  const btnMap = { up: '4', down: '5', left: '6', right: '7' };
  const btn = btnMap[dir] || '5';
  const cands = [
    ['xdotool', ['mousemove', String(x), String(y), 'click', '--repeat', String(steps), btn]],
    ['ydotool', ['mousemove', '--absolute', '-x', String(x), '-y', String(y)]]
  ];
  if (WAYLAND) cands.reverse();
  const r = await linuxTry(cands);
  if (r.ok && r.via === 'ydotool') {
    const wy = dir === 'up' ? String(steps) : dir === 'down' ? String(-steps) : '0';
    const wx = dir === 'right' ? String(steps) : dir === 'left' ? String(-steps) : '0';
    await run('ydotool', ['mousemove', '-w', '--', wx, wy]);
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
  if (IS_MAC) {
    const r = await jxa(`Application('System Events').keystroke(${JSON.stringify(t)});`);
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
const MAC_KEYCODES = {
  enter: 36, return: 36, tab: 48, space: 49, backspace: 51, esc: 53, escape: 53, delete: 117, del: 117,
  left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111
};

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
  if (IS_MAC) {
    const macMods = mods.map((m) => ({
      ctrl: 'control down', control: 'control down', strg: 'control down',
      shift: 'shift down', alt: 'option down', option: 'option down',
      cmd: 'command down', command: 'command down', meta: 'command down', super: 'command down', win: 'command down'
    }[m])).filter(Boolean);
    const usingClause = macMods.length ? `, { using: ${JSON.stringify(macMods)} }` : '';
    const code = MAC_KEYCODES[key];
    const expr = code !== undefined
      ? `Application('System Events').keyCode(${code}${usingClause});`
      : `Application('System Events').keystroke(${JSON.stringify(key)}${usingClause});`;
    const r = await jxa(expr);
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

module.exports = { move, click, drag, scroll, typeText, pressKeys };

