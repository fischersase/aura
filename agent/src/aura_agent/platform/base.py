"""Gemeinsame Datentypen der Plattform-Schicht (Linux X11, GNOME Wayland, Windows, macOS)."""

from __future__ import annotations

import sys
from dataclasses import asdict, dataclass
from typing import Any

IS_WINDOWS = sys.platform == "win32"
IS_MACOS = sys.platform == "darwin"
IS_LINUX = not IS_WINDOWS and not IS_MACOS


@dataclass
class WindowInfo:
    id: str  # X11 "0x…", Wayland "w…", Windows "0x…" (Fenster-Handle)
    title: str
    app: str  # X11: WM_CLASS-Klasse, z. B. "Google-chrome"; Windows: Programmdatei ohne .exe, z. B. "notepad"
    instance: str  # X11: WM_CLASS-Instanz; Windows: Programmdatei, z. B. "notepad.exe"
    pid: int | None
    desktop: int | None
    active: bool
    minimized: bool

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)
