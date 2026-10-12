"""Kindprozesse plattformübergreifend starten und samt Kindern beenden (Not-Aus, Zeitlimit).

Linux: eigene Sitzung (Prozessgruppe), beendet mit killpg.
Windows: eigene Prozessgruppe ohne Konsolenfenster, beendet mit taskkill /T (ganzer Prozessbaum).
Ohne CREATE_NO_WINDOW würde jeder Befehl unter Windows kurz ein schwarzes Konsolenfenster öffnen,
weil der Agent selbst keine Konsole hat.
"""

from __future__ import annotations

import contextlib
import os
import signal
import subprocess
from typing import Any

from .base import IS_WINDOWS

CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_NO_WINDOW = 0x08000000


def spawn_kwargs(new_group: bool = True) -> dict[str, Any]:
  """Zusätzliche Argumente für subprocess.Popen und asyncio.create_subprocess_exec."""
  if IS_WINDOWS:
    return {"creationflags": CREATE_NO_WINDOW | (CREATE_NEW_PROCESS_GROUP if new_group else 0)}
  return {"start_new_session": True} if new_group else {}


def kill_tree(pid: int) -> None:
  """Beendet einen Prozess und alle seine Kinder. Fehler (schon beendet, keine Rechte) werden ignoriert."""
  if IS_WINDOWS:
    with contextlib.suppress(OSError, subprocess.SubprocessError):
      subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True, timeout=10, check=False,
                     creationflags=CREATE_NO_WINDOW)
    return
  with contextlib.suppress(ProcessLookupError, PermissionError):
    os.killpg(pid, signal.SIGKILL)
