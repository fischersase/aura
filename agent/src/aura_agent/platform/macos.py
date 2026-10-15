"""macOS-Backend für Fenster, Programme, Audio, Medien und Systemeinstellungen (osascript / JXA / plistlib)."""

from __future__ import annotations

import contextlib
import json
import os
import plistlib
import subprocess
from pathlib import Path
from typing import Any

from .base import WindowInfo

APP_DIRS = (
    Path("/Applications"),
    Path("/System/Applications"),
    Path("/System/Applications/Utilities"),
    Path.home() / "Applications",
)


def run_osascript(script: str, *, language: str = "AppleScript", timeout: float = 10.0) -> tuple[int, str]:
    """Runs an AppleScript or JXA script via osascript and returns (returncode, stdout_or_stderr)."""
    cmd = ["osascript"]
    if language != "AppleScript":
        cmd.extend(["-l", language])
    cmd.extend(["-e", script])
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, str(e)
    out = (proc.stdout or proc.stderr or "").strip()
    return proc.returncode, out


def installed_bundles() -> list[dict[str, str]]:
    """Scans macOS application directories for .app bundles and reads their Info.plist metadata."""
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for base in APP_DIRS:
        if not base.is_dir():
            continue
        for bundle in sorted(base.glob("*.app")):
            plist_path = bundle / "Contents" / "Info.plist"
            stem = bundle.stem
            name = stem
            bundle_id = stem.lower()
            exe = stem
            if plist_path.is_file():
                with contextlib.suppress(Exception):
                    with plist_path.open("rb") as f:
                        info = plistlib.load(f)
                    name = str(info.get("CFBundleDisplayName") or info.get("CFBundleName") or stem)
                    bundle_id = str(info.get("CFBundleIdentifier") or bundle_id)
                    exe = str(info.get("CFBundleExecutable") or stem)
            key = bundle_id.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(
                {
                    "id": bundle_id,
                    "name": name,
                    "stem": stem,
                    "path": str(bundle),
                    "exe": exe,
                }
            )
    return out


def launch_bundle(entry: dict[str, str]) -> None:
    """Starts a macOS .app bundle via `open -a`."""
    target = entry.get("path") or entry.get("name") or entry.get("id") or ""
    if target:
        subprocess.Popen(
            ["open", "-a", target],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def windows() -> list[WindowInfo]:
    """Lists visible application windows via JXA (System Events)."""
    jxa = """
    const se = Application('System Events');
    const out = [];
    const procs = se.applicationProcesses.whose({ backgroundOnly: false })();
    for (const p of procs) {
      let pName = '';
      let pid = null;
      let front = false;
      try { pName = p.name(); pid = p.unixId(); front = p.frontmost(); } catch (e) { continue; }
      let wins = [];
      try { wins = p.windows(); } catch (e) { wins = []; }
      for (let i = 0; i < wins.length; i++) {
        const w = wins[i];
        let title = '';
        let mini = false;
        try { title = w.name() || ''; } catch (e) {}
        try { mini = !!w.attributes.byName('AXMinimized').value(); } catch (e) {}
        out.push({
          id: 'm:' + pid + ':' + i,
          title: String(title),
          app: String(pName),
          instance: String(pName),
          pid: pid,
          desktop: 0,
          active: Boolean(front && i === 0),
          minimized: Boolean(mini)
        });
      }
    }
    JSON.stringify(out);
    """
    code, raw = run_osascript(jxa, language="JavaScript", timeout=8.0)
    if code != 0 or not raw:
        return []
    try:
        items = json.loads(raw)
    except ValueError:
        return []
    return [
        WindowInfo(
            id=str(w.get("id", "")),
            title=str(w.get("title", "")),
            app=str(w.get("app", "")),
            instance=str(w.get("instance", "")),
            pid=int(w["pid"]) if isinstance(w.get("pid"), int) else None,
            desktop=0,
            active=bool(w.get("active")),
            minimized=bool(w.get("minimized")),
        )
        for w in items
        if isinstance(w, dict)
    ]


def _parse_window_id(window_id: str) -> tuple[int, int] | None:
    parts = window_id.split(":")
    if len(parts) == 3 and parts[0] == "m" and parts[1].isdigit() and parts[2].isdigit():
        return int(parts[1]), int(parts[2])
    return None


def act(window_id: str, action: str) -> bool:
    """Performs focus, minimize, maximize, or close on a macOS window."""
    parsed = _parse_window_id(window_id)
    if not parsed:
        return False
    pid, idx = parsed
    jxa = f"""
    const se = Application('System Events');
    const procs = se.applicationProcesses.whose({{ unixId: {pid} }})();
    if (!procs.length) {{ 'false'; }} else {{
      const p = procs[0];
      const wins = p.windows();
      const w = wins[{idx}] || wins[0];
      if ('{action}' === 'focus') {{
        p.frontmost = true;
        if (w) {{
          try {{ w.attributes.byName('AXMinimized').value = false; }} catch (e) {{}}
          try {{ w.actions.byName('AXRaise').perform(); }} catch (e) {{}}
        }}
      }} else if ('{action}' === 'minimize' && w) {{
        try {{ w.attributes.byName('AXMinimized').value = true; }} catch (e) {{}}
      }} else if ('{action}' === 'maximize' && w) {{
        try {{ w.attributes.byName('AXMinimized').value = false; }} catch (e) {{}}
        try {{ w.actions.byName('AXZoomWindow').perform(); }} catch (e) {{
          try {{
            const b = w.attributes.byName('AXFullScreen');
            b.value = !b.value();
          }} catch (e2) {{}}
        }}
      }} else if ('{action}' === 'close' && w) {{
        try {{ w.buttons.whose({{ subrole: 'AXCloseButton' }})[0].actions.byName('AXPress').perform(); }} catch (e) {{}}
      }}
      'true';
    }}
    """
    code, out = run_osascript(jxa, language="JavaScript", timeout=6.0)
    return code == 0 and out.endswith("true")


def exe_path(pid: int) -> str:
    """Returns executable name for a PID on macOS."""
    try:
        proc = subprocess.run(
            ["ps", "-p", str(pid), "-o", "comm="], capture_output=True, text=True, timeout=2.0, check=False
        )
        return os.path.basename(proc.stdout.strip())
    except (OSError, subprocess.TimeoutExpired):
        return ""


def get_volume() -> dict[str, Any]:
    """Reads output volume and mute state on macOS."""
    code, out = run_osascript(
        "set s to get volume settings\n"
        'return (output volume of s as string) & "," & (output muted of s as string)'
    )
    if code != 0 or "," not in out:
        return {"error": out or "Lautstärke konnte nicht gelesen werden."}
    vol_s, mute_s = out.split(",", 1)
    try:
        pct = int(vol_s.strip())
    except ValueError:
        pct = None
    return {"percent": pct, "muted": mute_s.strip().lower() == "true"}


def set_volume(level: int | None, mute: bool | None) -> dict[str, Any]:
    """Sets output volume and/or mute state on macOS."""
    cmds: list[str] = []
    if level is not None:
        lv = max(0, min(int(level), 100))
        cmds.append(f"set volume output volume {lv}")
    if mute is not None:
        cmds.append(f"set volume {'with' if mute else 'without'} output muted")
    if cmds:
        code, err = run_osascript("\n".join(cmds))
        if code != 0:
            return {"error": err}
    return get_volume()


def set_dark_mode(on: bool) -> dict[str, Any]:
    """Toggles macOS dark mode via System Events appearance preferences."""
    val = "true" if on else "false"
    code, err = run_osascript(
        f'tell application "System Events" to tell appearance preferences to set dark mode to {val}'
    )
    if code != 0:
        return {"error": err, "verified": False}
    _, now = run_osascript('tell application "System Events" to tell appearance preferences to get dark mode')
    is_dark = now.strip().lower() == "true"
    return {"dark": is_dark, "verified": is_dark == on}
