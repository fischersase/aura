"""Programme und Fenster: öffnen, auflisten, wechseln, schließen. Jede Aktion prüft ihr Ergebnis nach.

X11 über EWMH (platform/x11.py), GNOME Wayland über die Erweiterung aura-bridge (platform/gnome_wayland.py),
Windows über user32 (platform/win32.py) und das Startmenü (platform/win_apps.py).
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import time
from difflib import get_close_matches
from pathlib import Path
from typing import Any

from ..harness.tiers import Tier, aura_tool
from ..platform.base import IS_WINDOWS, WindowInfo
from ..platform.proc import spawn_kwargs
from ..policy.exfil import url_tier
from ..policy.paths import path_tier
from ..runtime.context import current
from .apps import WEB_APP_NOTE, App, best_matches, installed_apps
from .paths import expand

if IS_WINDOWS:
    from ..platform import win32
else:
    from ..platform import gnome_wayland, x11

LAUNCH_WAIT_S = 15.0
STATE_WAIT_S = 2.0  # Wartezeit auf Fokus/Minimieren/Maximieren, je Versuch
CLOSE_WAIT_S = 3.0  # Wartezeit, bis ein geschlossenes Fenster verschwunden ist
POLL_S = 0.3
# Programme und Skripte: Öffnen startet Code, daher T2.
EXECUTABLE_SUFFIXES = (
    ".sh",
    ".run",
    ".appimage",
    ".py",
    ".jar",
    ".deb",
    ".exe",
    ".msi",
    ".bat",
    ".cmd",
    ".ps1",
    ".vbs",
    ".js",
    ".jse",
    ".wsf",
    ".hta",
    ".lnk",
    ".scr",
    ".com",
    ".cpl",
    ".reg",
    ".msix",
    ".appx",
    ".appinstaller",
)


def _exe_name(pid: int | None) -> str:
    if not pid:
        return ""
    if IS_WINDOWS:
        return os.path.basename(win32.exe_path(pid)).lower()
    try:
        return os.path.basename(os.readlink(f"/proc/{pid}/exe")).lower()
    except OSError:
        return ""


def _matches(app: App, w: WindowInfo) -> bool:
    tokens = {t.lower() for t in (app.wm_class, app.binary, app.id, app.name) if t}
    wclass = {w.app.lower(), w.instance.lower()} - {""}
    if tokens & wclass:
        return True
    if any(t in c or c in t for t in tokens for c in wclass if len(c) > 3 and len(t) > 3):
        return True
    # Windows: Fenstertitel tragen den Programmnamen („Unbenannt - Editor“, „Rechner“); Store-Apps haben keine Programmdatei.
    if IS_WINDOWS and len(app.name) > 3:
        t = w.title.lower()
        n = app.name.lower()
        if t == n or t.endswith((f" - {n}", f" – {n}")) or t.startswith(f"{n} - "):
            return True
    exe = _exe_name(w.pid)
    return bool(exe) and bool(app.binary) and exe in {app.binary.lower(), Path(app.binary).stem.lower()}


def _windows() -> list[WindowInfo]:
    if IS_WINDOWS:
        return win32.windows()
    with x11.X11() as x:
        return x.windows()


async def _list() -> list[WindowInfo] | None:
    """Offene Fenster über X11, (unter Wayland) die GNOME-Erweiterung oder user32. None: hier nicht möglich."""
    if IS_WINDOWS:
        return await asyncio.to_thread(win32.windows)
    if gnome_wayland.is_wayland():
        try:
            return await gnome_wayland.windows()
        except Exception:  # noqa: BLE001 - Erweiterung fehlt oder ist aus
            return None
    if x11.available():
        return await asyncio.to_thread(_windows)
    return None


def _no_windows() -> str:
    if IS_WINDOWS:
        return "Fenster lassen sich hier nicht steuern."
    return (
        gnome_wayland.NOT_INSTALLED
        if gnome_wayland.is_wayland()
        else "Fenster lassen sich in dieser Sitzung nicht steuern (kein X11)."
    )


async def _do(window_id: str, action: str) -> None:
    if IS_WINDOWS:
        fn = {
            "focus": win32.focus,
            "minimize": win32.minimize,
            "maximize": win32.maximize,
            "close": win32.close_window,
        }[action]
        await asyncio.to_thread(fn, window_id)
        return
    if window_id.startswith("w"):
        await gnome_wayland.act(window_id, action)
        return

    def act() -> None:
        with x11.X11() as x:
            {"focus": x.focus, "minimize": x.minimize, "maximize": x.maximize, "close": x.close_window}[
                action
            ](window_id)

    await asyncio.to_thread(act)


def _brief(w: WindowInfo) -> dict[str, Any]:
    return {"id": w.id, "app": w.app, "title": w.title, "active": w.active, "minimized": w.minimized}


async def _wait_for(check, timeout: float) -> Any:
    """Wartet, bis check() etwas Wahres liefert. check darf synchron oder async sein."""
    end = time.monotonic() + timeout
    while True:
        found = check()
        if asyncio.iscoroutine(found):
            found = await found
        if found or time.monotonic() > end:
            return found
        await asyncio.sleep(POLL_S)


async def _find(window_id: str) -> WindowInfo | None:
    return next((w for w in (await _list() or []) if w.id == window_id), None)


@aura_tool(Tier.T0, label=lambda a: "Fenster")
async def list_windows() -> dict[str, Any]:
    """Listet die offenen Fenster: ID, Programm, Titel, ob aktiv oder minimiert."""
    wins = await _list()
    if wins is None:
        return {"error": _no_windows()}
    return {"count": len(wins), "windows": [_brief(w) for w in wins]}


def _resolve(window: str, wins: list[WindowInfo]) -> tuple[WindowInfo | None, str]:
    w = window.strip()
    if w.lower().startswith("0x") or (w.startswith("w") and w[1:].isdigit()):
        hit = [x for x in wins if x.id == w.lower()]
        return (hit[0], "") if hit else (None, f"Kein Fenster mit ID {w}.")
    q = w.lower()
    hits = [x for x in wins if q in x.title.lower() or q in x.app.lower() or q in x.instance.lower()]
    if len(hits) == 1:
        return hits[0], ""
    if not hits:
        return None, f"Kein Fenster passt zu „{window}“."
    active = [x for x in hits if x.active]
    if active:
        return active[0], ""
    return None, "Mehrere Fenster passen: " + "; ".join(
        f"{x.id} {x.app}: {x.title[:60]}" for x in hits[:8]
    ) + ". Nutze die ID."


def _window_tier(a: dict[str, Any]) -> tuple[Tier, str]:
    if a.get("action") == "close":
        return Tier.T2, "Fenster schließen kann ungespeicherte Arbeit verwerfen"
    return Tier.T1, ""


def _window_label(a: dict[str, Any]) -> str:
    w = str(a.get("window", ""))
    if w.lower().startswith("0x") and (IS_WINDOWS or x11.available()):
        try:
            hit = next((x for x in _windows() if x.id == w.lower()), None)
            if hit:
                w = f"{hit.title or hit.app} ({hit.app})"
        except Exception:  # noqa: BLE001, S110 - Beschriftung ist nur Komfort
            pass
    verb = {
        "focus": "nach vorne",
        "minimize": "minimieren",
        "maximize": "maximieren",
        "close": "schließen",
    }.get(a.get("action", ""), a.get("action", ""))
    return f"{w} {verb}"


@aura_tool(_window_tier, label=_window_label)
async def window_action(window: str, action: str) -> dict[str, Any]:
    """Holt ein Fenster nach vorne, minimiert, maximiert oder schließt es.

    Args:
      window: Fenster-ID aus list_windows (z. B. "0x2400003") oder ein Teil von Titel oder Programmname.
      action: "focus", "minimize", "maximize" oder "close".
    """
    if action not in ("focus", "minimize", "maximize", "close"):
        return {"error": "action muss focus, minimize, maximize oder close sein."}
    wins = await _list()
    if wins is None:
        return {"error": _no_windows()}
    target, err = _resolve(window, wins)
    if not target:
        return {"error": err}
    await _do(target.id, action)

    async def gone_check() -> bool:
        return await _find(target.id) is None

    if action == "close":
        gone = await _wait_for(gone_check, CLOSE_WAIT_S)
        return {
            "window": _brief(target),
            "verified": bool(gone),
            **(
                {}
                if gone
                else {"error": "Fenster ist noch offen (vielleicht fragt das Programm nach dem Speichern)."}
            ),
        }
    want = {"focus": lambda w: w.active, "minimize": lambda w: w.minimized, "maximize": lambda w: True}[
        action
    ]

    async def state_check() -> WindowInfo | None:
        s = await _find(target.id)
        return s if s is not None and want(s) else None

    after = await _wait_for(state_check, STATE_WAIT_S)
    return {
        "window": _brief(after or target),
        "verified": bool(after),
        **(
            {}
            if after
            else {"error": f"„{action}“ wurde gesendet, aber der Fensterzustand hat sich nicht geändert."}
        ),
    }


async def _is_active(window_id: str) -> bool:
    w = await _find(window_id)
    return bool(w and w.active)


def _start(app: App) -> None:
    if IS_WINDOWS:
        from ..platform import win_apps

        win_apps.launch(app.entry)
        return
    if shutil.which("gio"):
        cmd = ["gio", "launch", str(app.file)]
    elif shutil.which("gtk-launch"):
        cmd = ["gtk-launch", app.id]
    else:
        cmd = [
            "/bin/sh",
            "-c",
            app.exec.replace("%U", "").replace("%u", "").replace("%F", "").replace("%f", ""),
        ]
    subprocess.Popen(
        cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **spawn_kwargs()
    )


def _process_running(app: App) -> bool:
    if not app.binary:
        return False
    if IS_WINDOWS:
        import psutil  # pyright: ignore[reportMissingModuleSource]

        want = app.binary.lower()
        return any((p.info.get("name") or "").lower() == want for p in psutil.process_iter(["name"]))
    return subprocess.run(["pgrep", "-f", app.binary], capture_output=True, check=False).returncode == 0


def _web_app(app: App) -> dict[str, Any]:
    """Marks results for installed web apps (AURA-92) and makes blind clicks in this task ask first."""
    if not app.is_web_app:
        return {}
    task = current()
    if task is not None:
        task.web_content_unavailable = True
    return {"web_app": True, "note": WEB_APP_NOTE}


@aura_tool(Tier.T1, label=lambda a: a.get("name", ""))
async def launch_app(name: str) -> dict[str, Any]:
    """Startet ein installiertes Programm per Name (z. B. "Firefox", "Antigravity", "Rechner", "Dateien") und prüft, ob sein Fenster erscheint.

    Läuft das Programm schon, wird sein Fenster nach vorne geholt.

    Args:
      name: Programmname, wie ihn der Nutzer sagt.
    """
    apps = await asyncio.to_thread(installed_apps)
    hits = best_matches(apps, name)
    all_windows = await _list()
    if not hits and all_windows:
        # Kein Programmeintrag, aber vielleicht ein offenes Fenster mit diesem Namen: nach vorne holen.
        q = name.lower()
        wins = [w for w in all_windows if q in w.title.lower() or q in w.app.lower()]
        if wins:
            target = wins[0]
            await _do(target.id, "focus")
            active = await _wait_for(lambda: _is_active(target.id), 2)
            return {
                "app": target.title or target.app,
                "already_running": True,
                "window": _brief(target),
                "verified": bool(active),
            }
    if not hits:
        close = get_close_matches(name.lower(), [a.name.lower() for a in apps], n=5, cutoff=0.5)
        return {
            "error": f"Kein installiertes Programm „{name}“ gefunden.",
            **({"meintest_du": close} if close else {}),
        }
    app = hits[0]
    alternatives = [a.name for a in hits[1:4]]

    if all_windows is None:
        await asyncio.to_thread(_start, app)
        running = await _wait_for(lambda: _process_running(app), 8)
        return {
            "app": app.name,
            "verified": False,
            "process_running": bool(running),
            "note": _no_windows(),
            **_web_app(app),
        }

    before = all_windows
    existing = [w for w in before if _matches(app, w)]
    if existing:
        target = existing[0]
        await _do(target.id, "focus")
        active = await _wait_for(lambda: _is_active(target.id), 2)
        return {
            "app": app.name,
            "already_running": True,
            "window": _brief(target),
            "verified": bool(active),
            **({} if active else {"error": "Fenster existiert, ließ sich aber nicht nach vorne holen."}),
            **_web_app(app),
        }

    before_ids = {w.id for w in before}
    await asyncio.to_thread(_start, app)

    async def new_window() -> WindowInfo | None:
        fresh = [w for w in (await _list() or []) if w.id not in before_ids]
        mine = [w for w in fresh if _matches(app, w)]
        return (mine or [])[0] if mine else None

    win = await _wait_for(new_window, LAUNCH_WAIT_S)
    if win:
        return {
            "app": app.name,
            "window": _brief(win),
            "verified": True,
            **({"alternatives": alternatives} if alternatives else {}),
            **_web_app(app),
        }
    running = await asyncio.to_thread(_process_running, app)
    return {
        "app": app.name,
        "verified": False,
        "process_running": running,
        "error": f"„{app.name}“ wurde gestartet, aber nach {int(LAUNCH_WAIT_S)} s ist kein Fenster erschienen.",
        **_web_app(app),
    }


def _open_tier(a: dict[str, Any]) -> tuple[Tier, str]:
    t = str(a.get("target", "")).strip()
    if t.startswith(("http://", "https://", "mailto:")):
        return url_tier(t) or (Tier.T1, "")
    p = expand(t)
    blocked = path_tier(p)
    if blocked:
        return blocked
    if p.is_file() and (
        (not IS_WINDOWS and os.access(p, os.X_OK)) or p.suffix.lower() in EXECUTABLE_SUFFIXES
    ):
        return Tier.T2, "startet ein Programm oder Skript"
    return Tier.T1, ""


@aura_tool(_open_tier, label=lambda a: a.get("target", ""))
async def open_target(target: str) -> dict[str, Any]:
    """Öffnet eine Webseite (https://…), eine Datei oder einen Ordner mit dem Standardprogramm.

    Für Programme nach Namen launch_app nutzen.

    Args:
      target: URL, Datei- oder Ordnerpfad (z. B. "~/Downloads" oder "https://music.youtube.com").
    """
    t = target.strip()
    if not t.startswith(("http://", "https://", "mailto:")):
        p = expand(t)
        if not p.exists():
            return {"error": f"Gibt es nicht: {t}"}
        t = str(p)
    if IS_WINDOWS:
        try:
            await asyncio.to_thread(os.startfile, t)  # type: ignore[attr-defined]  # nur unter Windows vorhanden
        except OSError as e:
            return {"error": f"Konnte „{t}“ nicht öffnen: {e.strerror or e}"}
        return {
            "opened": t,
            "verified": None,
            "note": "Geöffnet; ob das Fenster erschien, wird hier nicht geprüft.",
        }
    proc = await asyncio.create_subprocess_exec(
        "xdg-open",
        t,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    try:
        _, err = await asyncio.wait_for(proc.communicate(), 10)
    except TimeoutError:
        return {"opened": t, "verified": None}
    if proc.returncode:
        return {
            "error": (err or b"").decode(errors="replace").strip()
            or f"xdg-open beendet mit {proc.returncode}"
        }
    return {
        "opened": t,
        "verified": None,
        "note": "Geöffnet; ob das Fenster erschien, wird hier nicht geprüft.",
    }
