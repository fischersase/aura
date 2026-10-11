"""Host-Attrappe für Tests: Freigaben nach Drehbuch, alle Meldungen werden mitgeschrieben."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any


class FakeHost:
  def __init__(self, decisions: list[str] | Callable[[dict[str, Any]], str] | None = None) -> None:
    self._decisions = decisions if decisions is not None else []
    self.approvals: list[dict[str, Any]] = []
    self.events: list[tuple[str, dict[str, Any]]] = []

  async def approve(self, request: dict[str, Any]) -> str:
    self.approvals.append(request)
    if callable(self._decisions):
      return self._decisions(request)
    return self._decisions.pop(0) if self._decisions else "deny"

  async def screenshot(self, max_width: int = 1600) -> dict[str, Any]:
    # 1x1 weißes JPEG
    return {"mime": "image/jpeg", "data": "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "width": 1, "height": 1}

  def emit(self, method: str, params: dict[str, Any]) -> None:
    self.events.append((method, params))

  def of(self, method: str) -> list[dict[str, Any]]:
    return [p for m, p in self.events if m == method]

  def text(self, task_id: str | None = None) -> str:
    return "".join(p["delta"] for p in self.of("task.text") if task_id is None or p["taskId"] == task_id)

  def done(self) -> dict[str, Any] | None:
    d = self.of("task.done")
    return d[-1] if d else None
