"""Host-Attrappe für Tests: Freigaben nach Drehbuch, alle Meldungen werden mitgeschrieben."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any


class FakeHost:
    def __init__(
        self,
        decisions: list[str] | Callable[[dict[str, Any]], str] | None = None,
        answers: list[str] | None = None,
    ) -> None:
        self._decisions = decisions if decisions is not None else []
        self._answers = list(answers or [])
        self.approvals: list[dict[str, Any]] = []
        self.questions: list[dict[str, Any]] = []
        self.inputs: list[dict[str, Any]] = []
        self.events: list[tuple[str, dict[str, Any]]] = []
        self.auth_headers: dict[str, str] = {}  # server → "Bearer …" (AURA-95)
        self.auth_requests: list[str] = []
        self.registry: list[dict[str, Any]] = []  # host.searchRegistry results (AURA-96)
        self.registry_queries: list[str] = []
        self.proposals: list[dict[str, Any]] = []
        self.proposal_decisions: list[str] = []

    async def approve(self, request: dict[str, Any]) -> str:
        self.approvals.append(request)
        if callable(self._decisions):
            return self._decisions(request)
        return self._decisions.pop(0) if self._decisions else "deny"

    async def ask(self, request: dict[str, Any]) -> dict[str, Any]:
        self.questions.append(request)
        return {"answer": self._answers.pop(0) if self._answers else ""}

    async def auth_header(self, server: str) -> dict[str, str]:
        self.auth_requests.append(server)
        if server not in self.auth_headers:
            raise RuntimeError("Nicht verbunden – in der Aura Zentrale anmelden.")
        return {"Authorization": self.auth_headers[server]}

    async def search_registry(self, query: str) -> dict[str, Any]:
        self.registry_queries.append(query)
        return {"results": list(self.registry)}

    async def propose_connector(self, card: dict[str, Any]) -> dict[str, Any]:
        self.proposals.append(card)
        return {"decision": self.proposal_decisions.pop(0) if self.proposal_decisions else "later"}

    async def input(self, request: dict[str, Any]) -> dict[str, Any]:
        self.inputs.append(request)
        return {"ok": True, "via": "fake"}

    async def screenshot(self, max_width: int = 1600) -> dict[str, Any]:
        # 1x1 weißes JPEG
        return {
            "mime": "image/jpeg",
            "data": "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
            "width": 1,
            "height": 1,
        }

    def emit(self, method: str, params: dict[str, Any]) -> None:
        self.events.append((method, params))

    def of(self, method: str) -> list[dict[str, Any]]:
        return [p for m, p in self.events if m == method]

    def text(self, task_id: str | None = None) -> str:
        return "".join(p["delta"] for p in self.of("task.text") if task_id is None or p["taskId"] == task_id)

    def done(self) -> dict[str, Any] | None:
        d = self.of("task.done")
        return d[-1] if d else None
