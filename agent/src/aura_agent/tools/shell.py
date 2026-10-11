"""Shell-Befehle mit Einstufung (siehe policy/shell_classifier.py).

Jeder Befehl läuft in einer eigenen Prozessgruppe, damit der Not-Aus auch
Kindprozesse sicher beendet.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
from pathlib import Path
from typing import Any

from ..harness.guard import clip
from ..harness.tiers import aura_tool
from ..policy.shell_classifier import classify
from ..runtime.context import current
from .paths import expand

MAX_OUTPUT = 12000


@aura_tool(tier=lambda a: classify(a.get("command", "")), label=lambda a: a.get("command", ""), effect=lambda a: a.get("command", ""))
async def run_command(command: str, cwd: str = "~", timeout_s: int = 120) -> dict[str, Any]:
  """Führt einen bash-Befehl auf dem Linux-PC aus und gibt Ausgabe und Exit-Code zurück.

  Für Systeminfos, Programme verwalten, Dateien bearbeiten usw. Nur lesende Befehle laufen ohne Rückfrage.

  Args:
    command: Der Befehl.
    cwd: Arbeitsordner (Standard: Benutzerordner).
    timeout_s: Abbruch nach so vielen Sekunden (5 bis 900, Standard 120).
  """
  task = current()
  home = task.home if task else str(Path.home())
  workdir = expand(cwd, home)
  if not workdir.is_dir():
    return {"error": f"Arbeitsordner gibt es nicht: {workdir}"}
  timeout = min(max(int(timeout_s or 120), 5), 900)
  proc = await asyncio.create_subprocess_exec(
      "/bin/bash", "-lc", command, cwd=str(workdir), stdin=asyncio.subprocess.DEVNULL,
      stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, start_new_session=True,
      env={**os.environ, "PAGER": "cat", "GIT_PAGER": "cat", "TERM": "dumb"},
  )
  if task:
    task.processes.add(proc)
  timed_out = False
  try:
    out, _ = await asyncio.wait_for(proc.communicate(), timeout)
  except TimeoutError:
    timed_out = True
    _kill(proc)
    out = b""
    with contextlib.suppress(Exception):
      out = await asyncio.wait_for(proc.stdout.read(), 2) if proc.stdout else b""
  except asyncio.CancelledError:
    _kill(proc)
    raise
  finally:
    if task:
      task.processes.discard(proc)
  result: dict[str, Any] = {"exit_code": proc.returncode, "output": clip(out.decode(errors="replace"), MAX_OUTPUT) or "(keine Ausgabe)"}
  if timed_out:
    result["error"] = f"Nach {timeout} s abgebrochen."
  return result


def _kill(proc: asyncio.subprocess.Process) -> None:
  if proc.returncode is None:
    with contextlib.suppress(ProcessLookupError, PermissionError):
      os.killpg(proc.pid, signal.SIGKILL)
