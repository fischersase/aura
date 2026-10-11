"""Was ein laufender Auftrag braucht: Host-Verbindung, Audit, Freigaben, Prozesse.

Der TaskController setzt den Kontext per ContextVar. ADK führt Werkzeuge im
selben asyncio-Kontext aus (auch in Spezialisten über AgentTool), daher sehen
Plugins und Werkzeuge immer den richtigen Auftrag.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Protocol

from ..harness.audit import AuditLog


class Host(Protocol):
  """Die Electron-Seite aus Sicht des Agenten."""

  async def approve(self, request: dict[str, Any]) -> str:
    """Fragt den Nutzer. Antwort: 'once', 'task' (Rest des Auftrags) oder 'deny'."""
    ...

  async def screenshot(self, max_width: int = 1600) -> dict[str, Any]:
    """Bildschirmfoto als {mime, data (base64), width, height}."""
    ...

  def emit(self, method: str, params: dict[str, Any]) -> None:
    """Benachrichtigung an die UI (task.text, task.step …)."""
    ...


@dataclass
class TaskContext:
  task_id: str
  chat_id: str
  host: Host
  audit: AuditLog
  home: str
  abort: asyncio.Event = field(default_factory=asyncio.Event)
  allow_all: bool = False
  allowed_tools: set[str] = field(default_factory=set)
  processes: set[asyncio.subprocess.Process] = field(default_factory=set)
  tool_errors_in_row: int = 0
  steps: int = 0

  def step(self, step_id: str, tool: str, label: str, state: str, **extra: Any) -> None:
    self.host.emit("task.step", {"taskId": self.task_id, "stepId": step_id, "tool": tool, "label": label, "state": state, **extra})

  def kill_processes(self) -> None:
    """Beendet alle von diesem Auftrag gestarteten Befehle samt Kindprozessen."""
    for p in list(self.processes):
      if p.returncode is None:
        with contextlib.suppress(ProcessLookupError, PermissionError):
          os.killpg(p.pid, signal.SIGKILL)
    self.processes.clear()


CURRENT: ContextVar[TaskContext | None] = ContextVar("aura_task", default=None)


def current() -> TaskContext | None:
  return CURRENT.get()
