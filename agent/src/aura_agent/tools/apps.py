"""Installierte Programme finden, wie src/agent/tools.js (desktopEntries, bestMatch).

Linux: .desktop-Einträge. Windows: Startmenü (platform/win_apps.py).
"""

from __future__ import annotations

import configparser
import os
import re
import shlex
from dataclasses import dataclass, field
from pathlib import Path

from ..platform.base import IS_WINDOWS


@dataclass
class App:
    id: str  # Linux: Dateiname ohne .desktop; Windows: AppID oder Pfad der Verknüpfung
    file: Path | None
    name: str
    names: str  # alle Suchbegriffe, klein
    exec: str
    wm_class: str  # StartupWMClass, falls angegeben
    exe: str = ""  # Windows: Programmdatei, falls bekannt (z. B. "notepad.exe")
    entry: dict[str, str] = field(default_factory=dict)  # Windows: Startmenü-Eintrag zum Starten

    @property
    def binary(self) -> str:
        if IS_WINDOWS:
            return self.exe
        try:
            words = [w for w in shlex.split(self.exec) if not w.startswith("%")]
        except ValueError:
            words = self.exec.split()
        while words and (words[0] == "env" or "=" in words[0]):
            words.pop(0)
        return os.path.basename(words[0]) if words else ""


def app_dirs() -> list[Path]:
    home = Path.home()
    data_dirs = os.environ.get("XDG_DATA_DIRS", "/usr/local/share:/usr/share").split(":")
    dirs = [home / ".local/share/applications"] + [Path(d) / "applications" for d in data_dirs if d]
    dirs += [
        Path("/var/lib/flatpak/exports/share/applications"),
        home / ".local/share/flatpak/exports/share/applications",
        Path("/var/lib/snapd/desktop/applications"),
    ]
    seen, out = set(), []
    for d in dirs:
        if d not in seen:
            seen.add(d)
            out.append(d)
    return out


def installed_apps() -> list[App]:
    if IS_WINDOWS:
        return _windows_apps()
    apps: dict[str, App] = {}
    for d in app_dirs():
        if not d.is_dir():
            continue
        for f in sorted(d.glob("*.desktop")):
            app_id = f.stem
            if app_id in apps:  # ~/.local hat Vorrang
                continue
            cp = configparser.RawConfigParser(strict=False, interpolation=None)
            try:
                cp.read(f, encoding="utf-8")
                sec = cp["Desktop Entry"]
            except (configparser.Error, KeyError, UnicodeDecodeError):
                continue
            if (
                sec.get("NoDisplay", "").lower() == "true"
                or sec.get("Hidden", "").lower() == "true"
                or sec.get("Type", "Application") != "Application"
            ):
                continue
            names = [
                sec.get(k, "")
                for k in ("Name", "Name[de]", "GenericName", "GenericName[de]", "Keywords", "Keywords[de]")
            ]
            apps[app_id] = App(
                id=app_id,
                file=f,
                name=sec.get("Name", app_id),
                names=" ".join([*names, app_id]).lower(),
                exec=sec.get("Exec", ""),
                wm_class=sec.get("StartupWMClass", ""),
            )
    return list(apps.values())


def _windows_apps() -> list[App]:
    from ..platform import win_apps

    return [
        App(
            id=e.get("app_id") or e.get("lnk", ""),
            file=None,
            name=e["name"],
            names=e["name"].lower(),
            exec="",
            wm_class="",
            exe=win_apps.exe_of(e),
            entry=e,
        )
        for e in win_apps.entries()
    ]


# GNOME übersetzt Namen erst zur Laufzeit (gettext); in den .desktop-Dateien steht oft nur Englisch.
GERMAN = {
    "dateien": "files",
    "dateimanager": "files",
    "dateiverwaltung": "files",
    "rechner": "calculator",
    "taschenrechner": "calculator",
    "einstellungen": "settings",
    "systemeinstellungen": "settings",
    "texteditor": "text editor",
    "editor": "text editor",
    "bildbetrachter": "image viewer",
    "bilder": "image viewer",
    "kalender": "calendar",
    "uhr": "clocks",
    "uhren": "clocks",
    "systemüberwachung": "system monitor",
    "aufgabenverwaltung": "system monitor",
    "taskmanager": "system monitor",
    "kamera": "camera",
    "dokumentenbetrachter": "document viewer",
    "pdf": "document viewer",
    "musik": "music",
    "videos": "videos",
    "bildschirmfoto": "screenshot",
    "laufwerke": "disks",
    "kontakte": "contacts",
    "wetter": "weather",
    "karten": "maps",
    "vs code": "visual studio code",
    "vscode": "visual studio code",
    "chrome browser": "google chrome",
}


def _score(a: App, q: str) -> int:
    names = [n.lower() for n in (a.name, a.id, a.binary) if n]
    if q in names:
        return 100
    if any(q in re.split(r"[\s\-_.]+", n) for n in names):  # ganzes Wort, z. B. "chrome" in "Google Chrome"
        return 90
    if any(n.startswith(q) for n in names):
        return 80
    if any(q in n for n in names):
        return 60
    if all(w in a.names for w in q.split()):
        return 30
    return 0


# Unter Windows heißen die Programme im deutschen Startmenü schon deutsch; hier nur andere Wörter dafür.
GERMAN_WINDOWS = {
    "taschenrechner": "rechner",
    "calculator": "rechner",
    "texteditor": "editor",
    "notepad": "editor",
    "dateien": "explorer",
    "dateimanager": "explorer",
    "dateiverwaltung": "explorer",
    "datei-explorer": "explorer",
    "aufgabenverwaltung": "task-manager",
    "taskmanager": "task-manager",
    "systemüberwachung": "task-manager",
    "eingabeaufforderung": "terminal",
    "konsole": "terminal",
    "powershell": "windows powershell",
    "bildbetrachter": "fotos",
    "bilder": "fotos",
    "kamera": "kamera",
    "uhr": "uhr",
    "wetter": "wetter",
    "vs code": "visual studio code",
    "vscode": "visual studio code",
    "chrome browser": "google chrome",
    "bildschirmfoto": "snipping tool",
    "screenshot": "snipping tool",
}


def best_matches(apps: list[App], query: str) -> list[App]:
    q = query.strip().lower()
    aliases = GERMAN_WINDOWS if IS_WINDOWS else GERMAN
    queries = [q] + ([aliases[q]] if q in aliases else [])
    scored = []
    for a in apps:
        s = max(_score(a, x) for x in queries)
        if not s:
            continue
        if (
            a.id.startswith("chrome-") or "--app-id" in a.exec or "_crx_" in a.id.lower()
        ):  # Web-App-Verknüpfungen nur, wenn genau gemeint
            s -= 40
        scored.append((s - len(a.name) / 100, a))
    return [a for _, a in sorted(scored, key=lambda x: -x[0])]
