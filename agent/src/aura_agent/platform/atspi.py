"""Client für den AT-SPI-Helfer (atspi_helper.py), der mit dem System-Python läuft.

Das gebündelte Python hat kein PyGObject; das System-Python von Ubuntu hat es (python3-gi,
gir1.2-atspi-2.0). Jeder Aufruf hat ein Zeitlimit; hängt ein Programm, wird der Helfer beendet
und beim nächsten Aufruf neu gestartet.
"""

from __future__ import annotations

import asyncio
import contextlib
import functools
import itertools
import json
import os
import subprocess
from pathlib import Path
from typing import Any

from .proc import spawn_kwargs

HELPER = Path(__file__).with_name("atspi_helper.py")
SYSTEM_PYTHON = os.environ.get("AURA_SYSTEM_PYTHON", "/usr/bin/python3")
CALL_TIMEOUT_S = 8.0


@functools.cache
def available() -> bool:
  try:
    r = subprocess.run([SYSTEM_PYTHON, "-c", "import gi; gi.require_version('Atspi', '2.0'); from gi.repository import Atspi"],
                       capture_output=True, timeout=10, check=False)
  except (OSError, subprocess.TimeoutExpired):
    return False
  return r.returncode == 0


class HelperClient:
  """Ein Helfer-Prozess mit JSON-Zeilen über stdin/stdout (AT-SPI unter Linux, UI Automation unter Windows)."""

  def __init__(self, argv: list[str]) -> None:
    self.argv = argv
    self._proc: asyncio.subprocess.Process | None = None
    self._ids = itertools.count(1)
    self._lock = asyncio.Lock()

  async def _start(self) -> asyncio.subprocess.Process:
    if self._proc is None or self._proc.returncode is not None:
      self._proc = await asyncio.create_subprocess_exec(
          *self.argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
          stderr=asyncio.subprocess.DEVNULL, env={**os.environ, "PYTHONWARNINGS": "ignore", "PYTHONUTF8": "1"},
          limit=16 * 1024 * 1024, **spawn_kwargs(new_group=False))
    return self._proc

  def kill(self) -> None:
    if self._proc and self._proc.returncode is None:
      with contextlib.suppress(ProcessLookupError):
        self._proc.kill()
    self._proc = None

  async def call(self, method: str, **params: Any) -> dict[str, Any]:
    async with self._lock:
      proc = await self._start()
      assert proc.stdin and proc.stdout
      rid = next(self._ids)
      proc.stdin.write((json.dumps({"id": rid, "method": method, "params": params}) + "\n").encode())
      try:
        await proc.stdin.drain()
        while True:
          line = await asyncio.wait_for(proc.stdout.readline(), CALL_TIMEOUT_S)
          if not line:
            self.kill()
            return {"error": "Barrierefreiheits-Helfer ist beendet."}
          msg = json.loads(line)
          if msg.get("id") == rid:
            break
      except TimeoutError:
        self.kill()
        return {"error": f"Das Programm antwortet nicht über die Barrierefreiheit (nach {CALL_TIMEOUT_S:.0f} s abgebrochen)."}
      if msg.get("error"):
        return {"error": msg["error"]}
      return msg.get("result") or {}


AtspiClient = HelperClient
CLIENT = HelperClient([SYSTEM_PYTHON, str(HELPER)])
