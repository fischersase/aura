"""Pfade so auflösen, wie der Nutzer sie meint.

Modelle schreiben "~/x", "Downloads", "$HOME/x" oder erfinden "/home/user/x"
(beobachtet in P0), unter Windows auch "~\\x", "%USERPROFILE%\\x" oder "C:\\Users\\user\\x".
Relative Pfade gelten ab dem Benutzerordner.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

_FAKE_HOME = re.compile(
    r"^(/home|[A-Za-z]:[\\/]Users)[\\/](user|username|nutzer|benutzer|you|me|yourname)(?=[\\/]|$)",
    re.IGNORECASE,
)


def expand(p: str | None, home: str | None = None) -> Path:
    home = home or str(Path.home())
    s = str(p or "").strip().strip("\"'")
    if not s:
        return Path(home)
    s = os.path.expandvars(
        s.replace("$HOME", home).replace("$env:USERPROFILE", home).replace("$env:HOME", home)
    )
    if s == "~" or s.startswith(("~/", "~\\")):
        s = home + s[1:]
    if _FAKE_HOME.match(s) and not Path(s).exists():
        s = _FAKE_HOME.sub(lambda _m: home, s)  # Funktion statt Text: Windows-Pfade enthalten \\
    path = Path(s)
    if not path.is_absolute():
        path = Path(home) / path
    return path


def show(path: Path, home: str | None = None) -> str:
    """Pfad für Modell und UI, mit ~ statt Benutzerordner."""
    home = home or str(Path.home())
    s = str(path)
    return "~" + s[len(home) :] if s == home or s.startswith((home + "/", home + os.sep)) else s
