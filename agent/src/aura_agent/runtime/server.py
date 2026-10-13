"""Der Agent als RPC-Dienst: Methoden für Electron und der Host in Gegenrichtung."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any, cast

import httpx
from google.adk.memory import SqliteMemoryService
from google.adk.models.base_llm import BaseLlm
from google.adk.runners import Runner
from google.adk.sessions.sqlite_session_service import SqliteSessionService

from .. import __version__
from ..agents.root import build_root, tool_catalog
from ..extensions.mcp import build_toolsets, integrations_agent
from ..harness.audit import AuditLog
from ..harness.context_manager import ContextManagerPlugin
from ..harness.guard import GuardPlugin
from ..harness.hooks import Hooks
from ..memory.store import FactStore
from ..models.ollama_llm import OllamaLlm
from ..models.unconfigured import UnconfiguredLlm
from ..policy.engine import PolicyEngine
from ..rpc.peer import INVALID_PARAMS, PROTOCOL_VERSION, Peer, RpcError
from ..tools.browser import build_browser_toolset
from .controller import APP_NAME, TaskController
from .settings import AgentSettings

log = logging.getLogger(__name__)

APPROVAL_TIMEOUT_S = 600
# Nur für Ende-zu-Ende-Tests der Electron-Brücke: JSON-Datei mit Drehbuch statt echtem Modell.
TEST_SCRIPT_ENV = "AURA_AGENT_TEST_SCRIPT"


def _scripted_from_file(path: str) -> BaseLlm:
    from ..testing.scripted_llm import Call, ScriptedLlm

    steps = json.loads(Path(path).read_text(encoding="utf-8"))
    return ScriptedLlm(
        [s if isinstance(s, str) else [Call(c["name"], c.get("args", {})) for c in s] for s in steps]
    )


class RpcHost:
    """Electron als Host, über die RPC-Verbindung."""

    def __init__(self, peer: Peer) -> None:
        self.peer = peer

    async def approve(self, request: dict[str, Any]) -> str:
        res = await self.peer.request("host.approve", request, timeout=APPROVAL_TIMEOUT_S)
        decision = (res or {}).get("decision", "deny")
        return decision if decision in ("once", "task", "always", "deny") else "deny"

    async def ask(self, request: dict[str, Any]) -> dict[str, Any]:
        return await self.peer.request("host.ask", request, timeout=APPROVAL_TIMEOUT_S)

    async def input(self, request: dict[str, Any]) -> dict[str, Any]:
        return await self.peer.request("host.input", request, timeout=30)

    async def screenshot(self, max_width: int = 1600) -> dict[str, Any]:
        return await self.peer.request("host.screenshot", {"maxWidth": max_width}, timeout=30)

    def emit(self, method: str, params: dict[str, Any]) -> None:
        self.peer.notify(method, params)


def make_model(settings: AgentSettings) -> BaseLlm:
    """Lokal über Ollama (Standard) oder Gemini, wenn der Nutzer Gemini als Anbieter gewählt hat."""
    if settings.provider == "gemini":
        if not settings.gemini_api_key:
            # Start anyway; tasks report the missing key (models/unconfigured.py).
            return UnconfiguredLlm(
                model="unconfigured",
                reason="Gemini ist gewählt, aber es ist kein API-Schlüssel hinterlegt. Trag ihn in den Einstellungen ein.",
            )
        from google.adk.models.google_llm import Gemini

        return Gemini(model=settings.gemini_model, client_kwargs={"api_key": settings.gemini_api_key})
    return OllamaLlm(
        model=f"ollama/{settings.model}",
        base_url=settings.ollama_url,
        num_ctx=settings.num_ctx,
        keep_alive=settings.keep_alive,
        think=False,
    )


def build_runner(
    settings: AgentSettings, model: BaseLlm | None = None, browser: bool | None = None
) -> Runner:
    """browser: None = nach Einstellung (aber nie bei Testmodellen), True/False erzwingt."""
    policy = PolicyEngine(settings.aura_dir / "policy.toml", settings.tool_policy)
    episodes = SqliteMemoryService(settings.data_dir / "memory.db")
    use_browser = settings.browser and model is None if browser is None else browser
    toolset = build_browser_toolset(settings, settings.browser_headless) if use_browser else None
    settings.ensure_dirs()
    llm = model or make_model(settings)
    return Runner(
        app_name=APP_NAME,
        agent=build_root(
            llm, settings, toolset, integrations_agent(llm, build_toolsets(settings.mcp_servers)), episodes
        ),
        memory_service=episodes,
        session_service=SqliteSessionService(str(settings.data_dir / "sessions.db")),
        plugins=[
            GuardPlugin(policy, Hooks(settings.aura_dir / "hooks.json")),
            ContextManagerPlugin(settings.num_ctx),
        ],
    )


class AgentServer:
    def __init__(self, peer: Peer, model: BaseLlm | None = None) -> None:
        self.peer = peer
        self.host = RpcHost(peer)
        self._model = model
        self._shell_warm: asyncio.Task | None = None  # Windows: PowerShell vorwärmen
        self.settings: AgentSettings | None = None
        self.controller: TaskController | None = None
        peer.on("initialize", self.initialize)
        peer.on("task.start", self.task_start)
        peer.on("task.cancel", self.task_cancel)
        peer.on("task.cancelAll", self.task_cancel_all)
        peer.on("chat.forget", self.chat_forget)
        peer.on("chat.retain", self.chat_retain)
        peer.on("memory.list", self.memory_list)
        peer.on("memory.update", self.memory_update)
        peer.on("memory.delete", self.memory_delete)
        peer.on("memory.deleteAll", self.memory_delete_all)
        peer.on("catalog.list", self.catalog)
        peer.on("policy.list", self.policy_list)
        peer.on("ping", self.ping)
        peer.on("shutdown", self.shutdown)

    async def initialize(self, p: dict[str, Any]) -> dict[str, Any]:
        if p.get("protocol") != PROTOCOL_VERSION:
            raise RpcError(
                INVALID_PARAMS,
                f"Protokollversion {p.get('protocol')} passt nicht (erwartet {PROTOCOL_VERSION})",
            )
        self.settings = AgentSettings.from_params(p.get("settings") or {})
        if self._model is None and os.environ.get(TEST_SCRIPT_ENV):
            self._model = _scripted_from_file(os.environ[TEST_SCRIPT_ENV])
        runner = build_runner(self.settings, self._model)
        self.controller = TaskController(
            runner,
            self.host,
            AuditLog(self.settings.data_dir / "audit"),
            self.settings.home,
            self.settings.max_llm_calls,
            episodes_db=self.settings.data_dir / "memory.db",
        )
        self.controller.memory_paused = self.settings.memory_paused
        if self._model is None and p.get("warmUp", True) and self.settings.provider == "ollama":
            self._warm_task = asyncio.create_task(
                self._warm_up()
            )  # keep a reference, or the task may be collected
        if p.get("warmUp", True):
            from ..tools.shell import warm_up_shell

            self._shell_warm = asyncio.create_task(warm_up_shell())
        model = self.settings.gemini_model if self.settings.provider == "gemini" else self.settings.model
        return {
            "protocol": PROTOCOL_VERSION,
            "version": __version__,
            "model": model,
            "provider": self.settings.provider,
        }

    def _require(self) -> TaskController:
        if not self.controller:
            raise RpcError(INVALID_PARAMS, "initialize fehlt")
        return self.controller

    async def task_start(self, p: dict[str, Any]) -> dict[str, Any]:
        ctl = self._require()
        if not p.get("taskId") or not p.get("chatId") or not isinstance(p.get("text"), str):
            raise RpcError(INVALID_PARAMS, "taskId, chatId und text sind nötig")
        ctl.start(
            p["taskId"], p["chatId"], p["text"], p.get("images"), incognito=bool(p.get("incognito", False))
        )
        return {"accepted": True}

    async def task_cancel(self, p: dict[str, Any]) -> dict[str, Any]:
        return {"cancelled": await self._require().cancel(str(p.get("taskId", "")))}

    async def task_cancel_all(self, _p: dict[str, Any]) -> dict[str, Any]:
        return {"cancelled": await self._require().cancel_all()}

    async def chat_forget(self, p: dict[str, Any]) -> dict[str, Any]:
        chat_id = p.get("chatId")
        if not isinstance(chat_id, str) or not chat_id:
            raise RpcError(INVALID_PARAMS, "chatId fehlt")
        return await self._require().forget_chat(chat_id)

    async def chat_retain(self, p: dict[str, Any]) -> dict[str, Any]:
        ids = p.get("chatIds")
        if not isinstance(ids, list) or not all(isinstance(i, str) for i in cast("list[Any]", ids)):
            raise RpcError(INVALID_PARAMS, "chatIds muss eine Liste von Texten sein")
        return await self._require().retain_chats(set(cast("list[str]", ids)))

    # Memory page in the Zentrale (AURA-108): facts with their provenance; changes are audited without content.
    def _facts(self) -> FactStore:
        if self.settings is None:
            raise RpcError(INVALID_PARAMS, "initialize fehlt")
        return FactStore(self.settings.aura_dir)

    async def memory_list(self, _p: dict[str, Any]) -> dict[str, Any]:
        facts = await asyncio.to_thread(self._facts().list)
        return {"facts": facts, "paused": bool(self.settings and self.settings.memory_paused)}

    async def memory_update(self, p: dict[str, Any]) -> dict[str, Any]:
        fid, text = p.get("id"), p.get("text")
        if not isinstance(fid, str) or not isinstance(text, str):
            raise RpcError(INVALID_PARAMS, "id und text sind nötig")
        r = await asyncio.to_thread(self._facts().update, fid, text)
        if r.get("ok"):
            self._require().audit.write("memory_edited", fact=fid)
        return r

    async def memory_delete(self, p: dict[str, Any]) -> dict[str, Any]:
        fid = p.get("id")
        if not isinstance(fid, str):
            raise RpcError(INVALID_PARAMS, "id fehlt")
        removed = await asyncio.to_thread(self._facts().delete, fid)
        if removed:
            self._require().audit.write("memory_deleted", fact=fid)
        return {"removed": removed}

    async def memory_delete_all(self, _p: dict[str, Any]) -> dict[str, Any]:
        removed = await asyncio.to_thread(self._facts().delete_all)
        self._require().audit.write("memory_cleared", count=removed)
        return {"removed": removed}

    async def catalog(self, _p: dict[str, Any]) -> dict[str, Any]:
        return {"tools": tool_catalog()}

    async def policy_list(self, _p: dict[str, Any]) -> dict[str, Any]:
        s = self.settings or AgentSettings()
        return {
            "file": str(s.aura_dir / "policy.toml"),
            "rules": PolicyEngine(s.aura_dir / "policy.toml", s.tool_policy).listing(),
        }

    async def ping(self, _p: dict[str, Any]) -> dict[str, Any]:
        return {"ok": True, "tasks": len(self.controller.tasks) if self.controller else 0}

    async def shutdown(self, _p: dict[str, Any]) -> dict[str, Any]:
        if self.controller:
            await self.controller.cancel_all()
        asyncio.get_running_loop().call_later(0.05, self.peer.closed.set)
        return {}

    async def _warm_up(self) -> None:
        """Lädt das Modell mit demselben num_ctx wie später die Aufträge (sonst lädt Ollama neu)."""
        s = self.settings
        if s is None:
            return
        self.peer.notify("model.status", {"state": "loading", "model": s.model})
        try:
            async with httpx.AsyncClient(timeout=300) as client:
                r = await client.post(
                    f"{s.ollama_url}/api/generate",
                    json={"model": s.model, "keep_alive": s.keep_alive, "options": {"num_ctx": s.num_ctx}},
                )
                r.raise_for_status()
            self.peer.notify("model.status", {"state": "ready", "model": s.model})
        except Exception as e:  # noqa: BLE001 - nur eine Statusmeldung
            self.peer.notify("model.status", {"state": "error", "model": s.model, "message": str(e)})
