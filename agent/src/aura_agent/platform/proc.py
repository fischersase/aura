"""Kindprozesse plattformübergreifend starten und samt Kindern beenden (Not-Aus, Zeitlimit).

Linux: eigene Sitzung (Prozessgruppe), beendet mit killpg.
Windows: eigene Prozessgruppe ohne Konsolenfenster, beendet mit taskkill /T (ganzer Prozessbaum).
Ohne CREATE_NO_WINDOW würde jeder Befehl unter Windows kurz ein schwarzes Konsolenfenster öffnen,
weil der Agent selbst keine Konsole hat.
"""

from __future__ import annotations

import contextlib
import os
import re
import signal
import subprocess
from typing import Any

from .base import IS_WINDOWS

CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_NO_WINDOW = 0x08000000


# Umgebungsvariablen mit Zugangsdaten bekommen Kindprozesse des Agenten nicht (AURA-13): selbst wenn ein Befehl
# fälschlich als lesend durchginge, könnte er so keine Schlüssel ausgeben.
# Geprüft werden ganze Namensteile, damit XAUTHORITY, SSH_AUTH_SOCK oder DBUS_SESSION_BUS_ADDRESS erhalten bleiben.
SECRET_ENV = re.compile(
    r"(?i)(^|_)(API_?KEY|ACCESS_?KEY|SECRET(_?KEY)?|PRIVATE_?KEY|CLIENT_?SECRET|TOKEN|AUTH_?TOKEN|"
    r"PASSWORD|PASSWD|PASS|CREDENTIALS?|COOKIE|SESSION_?KEY)(_|$)"
)
# Kein Pager, und git ignoriert den fsmonitor-Hook fremder Repositorys (würde sonst bei "git status" Code ausführen).
GIT_SAFE_CONFIG = {"core.fsmonitor": "false", "core.pager": "cat"}


def child_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """Umgebung für Befehle des Agenten: ohne Zugangsdaten, mit sicheren git-Einstellungen."""
    env = {k: v for k, v in os.environ.items() if not SECRET_ENV.search(k)}
    n = int(env.get("GIT_CONFIG_COUNT", "0") or 0)
    for key, value in GIT_SAFE_CONFIG.items():
        env[f"GIT_CONFIG_KEY_{n}"] = key
        env[f"GIT_CONFIG_VALUE_{n}"] = value
        n += 1
    env["GIT_CONFIG_COUNT"] = str(n)
    env.update(extra or {})
    return env


def spawn_kwargs(new_group: bool = True) -> dict[str, Any]:
    """Zusätzliche Argumente für subprocess.Popen und asyncio.create_subprocess_exec."""
    if IS_WINDOWS:
        return {"creationflags": CREATE_NO_WINDOW | (CREATE_NEW_PROCESS_GROUP if new_group else 0)}
    return {"start_new_session": True} if new_group else {}


def kill_tree(pid: int) -> None:
    """Beendet einen Prozess und alle seine Kinder. Fehler (schon beendet, keine Rechte) werden ignoriert."""
    if IS_WINDOWS:
        with contextlib.suppress(OSError, subprocess.SubprocessError):
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                capture_output=True,
                timeout=10,
                check=False,
                creationflags=CREATE_NO_WINDOW,
            )
        return
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(pid, signal.SIGKILL)
