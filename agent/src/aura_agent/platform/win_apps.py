"""Installierte Programme unter Windows: alles, was im Startmenü steht (klassische Programme und Store-Apps).

Quelle 1: Get-StartApps (PowerShell) liefert Name und AppID jedes Startmenü-Eintrags, auch für Store-Apps
wie Rechner oder Fotos. Gestartet wird über explorer.exe shell:AppsFolder\\<AppID>, genau wie aus dem Startmenü.
Quelle 2 (Ergänzung, falls Get-StartApps fehlt): die Verknüpfungen (.lnk) in den Startmenü-Ordnern.
Das Ergebnis wird kurz zwischengespeichert, weil PowerShell rund eine Sekunde zum Start braucht.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

from .proc import CREATE_NO_WINDOW

CACHE_S = 120.0
_cache: tuple[float, list[dict[str, str]]] | None = None
SKIP = (
    "uninstall",
    "deinstall",
    "entfernen",
    "readme",
    "liesmich",
    "release notes",
    "website",
    "help",
    "hilfe",
)


def start_menu_dirs() -> list[Path]:
    dirs = []
    for var in ("APPDATA", "PROGRAMDATA"):
        base = os.environ.get(var)
        if base:
            dirs.append(Path(base) / "Microsoft" / "Windows" / "Start Menu" / "Programs")
    return dirs


def _start_apps() -> list[dict[str, str]]:
    cmd = [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress",
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=20, check=False, creationflags=CREATE_NO_WINDOW)
    except (OSError, subprocess.SubprocessError):
        return []
    try:
        data = json.loads(r.stdout.decode("utf-8", "replace") or "[]")
    except json.JSONDecodeError:
        return []
    if isinstance(data, dict):
        data = [data]
    return [
        {"name": str(d.get("Name") or ""), "app_id": str(d.get("AppID") or "")}
        for d in data
        if d.get("Name") and d.get("AppID")
    ]


def _shortcuts() -> list[dict[str, str]]:
    out = []
    for d in start_menu_dirs():
        if d.is_dir():
            out += [{"name": f.stem, "lnk": str(f)} for f in sorted(d.rglob("*.lnk"))]
    return out


def entries(refresh: bool = False) -> list[dict[str, str]]:
    """[{name, app_id?, lnk?}] ohne Deinstallations- und Hilfe-Einträge. Gleichnamige Einträge werden zusammengelegt:
    gestartet wird dann über die Verknüpfung (behält ihre Argumente), die AppID verrät die Programmdatei."""
    global _cache
    if _cache and not refresh and time.monotonic() - _cache[0] < CACHE_S:
        return _cache[1]
    found: dict[str, dict[str, str]] = {}
    for e in _start_apps() + _shortcuts():
        key = e["name"].lower()
        if not any(s in key for s in SKIP):
            found[key] = {**found.get(key, {}), **e}
    _cache = (time.monotonic(), list(found.values()))
    return _cache[1]


def exe_of(entry: dict[str, str]) -> str:
    """Programmdatei, falls die AppID ein Pfad ist (klassische Programme), sonst ""."""
    app_id = entry.get("app_id", "")
    if app_id.lower().endswith(".exe"):
        return app_id.replace("/", "\\").rsplit("\\", 1)[-1]
    return ""


def launch(entry: dict[str, str]) -> None:
    if entry.get("lnk"):
        os.startfile(entry["lnk"])  # type: ignore[attr-defined]  # nur unter Windows vorhanden
    else:
        subprocess.Popen(
            ["explorer.exe", f"shell:AppsFolder\\{entry['app_id']}"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=CREATE_NO_WINDOW,
        )
