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

  async def ask(self, request: dict[str, Any]) -> dict[str, Any]:
    """Frage an den Nutzer: {taskId, question, options}. Antwort: {answer}."""
    ...

  async def input(self, request: dict[str, Any]) -> dict[str, Any]:
    """Maus/Tastatur: {action: click|type|keys, x, y (0–1000), text, keys}."""
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
  call_counts: dict[str, int] = field(default_factory=dict)
  # Ändernde Aktionen und ob sie nachgeprüft sind (True/False/None = nicht prüfbar).
  changes: list[dict[str, Any]] = field(default_factory=list)
  # Abgelehnte oder gesperrte Aktionen (für Rückmeldungen aus Spezialisten an den Hauptagenten).
  refusals: list[str] = field(default_factory=list)
  # Hat der Auftrag fremde Inhalte gelesen (Webseiten, Dateien, Programme, MCP)? Dann sind Wege nach außen strenger.
  tainted_by: list[str] = field(default_factory=list)
  # Hat der Auftrag lokale Daten gelesen (Dateien, Befehlsausgaben, Bildschirm, Gedächtnis)?
  local_data_from: list[str] = field(default_factory=list)

  @property
  def tainted(self) -> bool:
    return bool(self.tainted_by)

  def verified(self) -> bool | None:
    """Gesamturteil für task.done: None ohne ändernde Aktionen."""
    if not self.changes:
      return None
    if any(c["verified"] is False for c in self.changes):
      return False
    return True if all(c["verified"] is True for c in self.changes) else None

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
