"""Steuert Aufträge: starten, Text streamen, abbrechen, abschließen.

Die innere Schleife (Modell ↔ Werkzeuge) ist ADKs Runner. Hier sitzt die
äußere Schleife: Sitzung je Chat, Streaming an die UI, Abbruch, Audit und die
Prüfungen am Ende (leere Antwort wird einmal zurückgewiesen).
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import logging
import re
import sqlite3
import time
from collections.abc import Callable
from contextlib import closing
from pathlib import Path

from google.adk.agents.run_config import (
    RunConfig,
    StreamingMode,  # pyright: ignore[reportPrivateImportUsage] - public in ADK docs, re-exported here
)
from google.adk.runners import Runner
from google.genai import types

from ..harness.audit import AuditLog
from .context import CURRENT, Host, TaskContext

log = logging.getLogger(__name__)

APP_NAME = "aura"
USER_ID = "local"
EMPTY_ANSWER_NUDGE = (
    "[Hinweis der App, nicht vom Nutzer] Du hast keine Antwort geschrieben. Sag dem Nutzer jetzt in ein bis zwei "
    "Sätzen, was du getan hast und was dabei herauskam. Behaupte nichts, was kein Werkzeugergebnis belegt."
)
VERIFY_NUDGE = (
    "[Hinweis der App, nicht vom Nutzer] Deine Antwort klingt nach Erfolg, aber die Nachprüfung sagt, dass diese "
    "Aktionen NICHT wirksam wurden: {items}. Schreib dem Nutzer eine kurze, ehrliche Korrektur. Versuche höchstens "
    "einen anderen Weg, wenn es einen verlässlicheren gibt."
)
# Erfolgsbehauptungen in der Endantwort (für die Prüfung vor „fertig“).
SUCCESS_CLAIM = re.compile(
    r"\b(erledigt|geöffnet|gestartet|pausiert|fortgesetzt|gestoppt|geschlossen|gelöscht|gespeichert|angelegt|erstellt|"
    r"geändert|verschoben|kopiert|eingestellt|aktiviert|deaktiviert|abgespielt|läuft (jetzt|wieder)|ist (jetzt )?(offen|an|aus))\b",
    re.IGNORECASE,
)
CANCEL_GRACE_S = 2.0


def _text_of(content: types.Content | None) -> str:
    if not content:
        return ""
    return "".join(p.text or "" for p in content.parts or [] if p.text and not p.thought)


class TaskController:
    def __init__(
        self,
        runner: Runner,
        host: Host,
        audit: AuditLog,
        home: str,
        max_llm_calls: int = 60,
        on_finished: Callable[[str], None] | None = None,
        episodes_db: Path | None = None,
    ) -> None:
        self.runner = runner
        self.episodes_db = episodes_db  # memory.db of the runner's memory service (for forget_chat)
        self.host = host
        self.audit = audit
        self.home = home
        self.max_llm_calls = max_llm_calls
        self.tasks: dict[str, tuple[asyncio.Task[None], TaskContext]] = {}
        self._on_finished = on_finished

    async def _session_id(self, chat_id: str) -> str:
        sessions = self.runner.session_service
        s = await sessions.get_session(app_name=APP_NAME, user_id=USER_ID, session_id=chat_id)
        if s is None:
            s = await sessions.create_session(app_name=APP_NAME, user_id=USER_ID, session_id=chat_id)
        return s.id

    def start(
        self, task_id: str, chat_id: str, text: str, images: list[dict[str, str]] | None = None
    ) -> None:
        if task_id in self.tasks:
            raise ValueError(f"Auftrag {task_id} läuft schon")
        ctx = TaskContext(
            task_id=task_id, chat_id=chat_id, host=self.host, audit=self.audit, home=self.home, request=text
        )
        parts = [types.Part(text=text)]
        for img in images or []:
            parts.append(
                types.Part(
                    inline_data=types.Blob(
                        mime_type=img.get("mime", "image/jpeg"), data=base64.b64decode(img["data"])
                    )
                )
            )
        task = asyncio.create_task(self._run(ctx, types.Content(role="user", parts=parts)))
        self.tasks[task_id] = (task, ctx)
        task.add_done_callback(lambda _t: self._finished(task_id))

    def _finished(self, task_id: str) -> None:
        self.tasks.pop(task_id, None)
        if self._on_finished:
            self._on_finished(task_id)

    async def cancel(self, task_id: str) -> bool:
        entry = self.tasks.get(task_id)
        if not entry:
            return False
        task, ctx = entry
        ctx.abort.set()
        ctx.kill_processes()
        self.audit.write("task_cancel", task=task_id)
        done, _ = await asyncio.wait({task}, timeout=CANCEL_GRACE_S)
        if not done:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        return True

    async def cancel_all(self) -> int:
        ids = list(self.tasks)
        await asyncio.gather(*(self.cancel(t) for t in ids))
        return len(ids)

    async def forget_chat(self, chat_id: str) -> dict[str, int]:
        """Deletes everything the agent stored about a chat: its session and its episodes (NFR-PRIV-007, AURA-106).

        Running tasks of the chat are cancelled first, so they cannot write the session again.
        """
        running = [tid for tid, (_t, ctx) in self.tasks.items() if ctx.chat_id == chat_id]
        await asyncio.gather(*(self.cancel(t) for t in running))
        sessions = 0
        service = self.runner.session_service
        if await service.get_session(app_name=APP_NAME, user_id=USER_ID, session_id=chat_id) is not None:
            await service.delete_session(app_name=APP_NAME, user_id=USER_ID, session_id=chat_id)
            sessions = 1
        episodes = await asyncio.to_thread(self._delete_episodes, chat_id)
        self.audit.write("chat_forgotten", chat=chat_id, sessions=sessions, episodes=episodes)
        return {"sessions": sessions, "episodes": episodes}

    async def retain_chats(
        self, chat_ids: set[str], keep_prefixes: tuple[str, ...] = ("voice-",)
    ) -> dict[str, int]:
        """Forgets sessions of chats the app no longer has (deleted before AURA-106, or while the agent was off).

        Sessions whose id starts with one of keep_prefixes have no chat in the app's list (voice tasks) and stay.
        """
        listed = await self.runner.session_service.list_sessions(app_name=APP_NAME, user_id=USER_ID)
        orphans = [
            s.id for s in listed.sessions if s.id not in chat_ids and not s.id.startswith(keep_prefixes)
        ]
        totals = {"chats": 0, "sessions": 0, "episodes": 0}
        for chat_id in orphans:
            r = await self.forget_chat(chat_id)
            totals["chats"] += 1
            totals["sessions"] += r["sessions"]
            totals["episodes"] += r["episodes"]
        return totals

    def _delete_episodes(self, chat_id: str) -> int:
        """Removes the chat's rows from the episode store (memory.db); its FTS index follows by trigger."""
        path = self.episodes_db
        if path is None or not path.exists():
            return 0
        with closing(sqlite3.connect(path)) as db:
            try:
                cur = db.execute(
                    "DELETE FROM memory_events WHERE app_name = ? AND user_id = ? AND session_id = ?",
                    (APP_NAME, USER_ID, chat_id),
                )
            except sqlite3.OperationalError:  # no table yet: nothing was stored
                return 0
            db.commit()
            return cur.rowcount

    async def _run(self, ctx: TaskContext, message: types.Content) -> None:
        CURRENT.set(ctx)
        t0 = time.monotonic()
        usage = {"prompt": 0, "output": 0, "llm_calls": 0}
        self.audit.write("task_start", task=ctx.task_id, chat=ctx.chat_id, text=_text_of(message))
        error: str | None = None
        final = ""
        try:
            session_id = await self._session_id(ctx.chat_id)
            final, error = await self._turn(ctx, session_id, message, usage)
            if not final and not error and not ctx.abort.is_set():
                self.audit.write("empty_answer_nudge", task=ctx.task_id)
                final, error = await self._turn(
                    ctx,
                    session_id,
                    types.Content(role="user", parts=[types.Part(text=EMPTY_ANSWER_NUDGE)]),
                    usage,
                )
            failed = [c["label"] or c["tool"] for c in ctx.changes if c["verified"] is False]
            if failed and SUCCESS_CLAIM.search(final or "") and not error and not ctx.abort.is_set():
                self.audit.write("verify_rejected", task=ctx.task_id, failed=failed)
                nudge = VERIFY_NUDGE.format(items="; ".join(failed[:5]))
                final, error = await self._turn(
                    ctx, session_id, types.Content(role="user", parts=[types.Part(text=nudge)]), usage
                )
        except asyncio.CancelledError:
            error = None
        except Exception as e:
            log.exception("Auftrag %s fehlgeschlagen", ctx.task_id)
            error = f"{type(e).__name__}: {e}"
        finally:
            ctx.kill_processes()
        await self._remember_conversation(ctx, t0)
        cancelled = ctx.abort.is_set()
        ms = round((time.monotonic() - t0) * 1000)
        self.audit.write(
            "task_end",
            task=ctx.task_id,
            ok=not error and not cancelled,
            cancelled=cancelled,
            error=error,
            steps=ctx.steps,
            ms=ms,
            **usage,
        )
        if error and not cancelled:
            self.host.emit("task.error", {"taskId": ctx.task_id, "message": error})
        else:
            self.host.emit(
                "task.done",
                {
                    "taskId": ctx.task_id,
                    "text": final,
                    "cancelled": cancelled,
                    "verified": ctx.verified(),
                    "steps": ctx.steps,
                    "ms": ms,
                    "usage": usage,
                },
            )

    async def _remember_conversation(self, ctx: TaskContext, since: float) -> None:
        """Text dieses Auftrags (Bitte und Antworten, keine Werkzeugdaten) für recall durchsuchbar machen."""
        memory = getattr(self.runner, "memory_service", None)
        if memory is None:
            return
        try:
            session = await self.runner.session_service.get_session(
                app_name=APP_NAME, user_id=USER_ID, session_id=ctx.chat_id
            )
            if session is None:
                return
            started = time.time() - (time.monotonic() - since) - 1
            events = [
                e
                for e in session.events
                if (e.timestamp or 0) >= started
                and e.content
                and _text_of(e.content)
                and not any(p.function_call or p.function_response for p in e.content.parts or [])
            ]
            if events:
                await memory.add_events_to_memory(
                    app_name=APP_NAME, user_id=USER_ID, events=events, session_id=ctx.chat_id
                )
        except Exception:
            log.exception("Gesprächsgedächtnis nicht aktualisiert")

    async def _turn(
        self, ctx: TaskContext, session_id: str, message: types.Content, usage: dict[str, int]
    ) -> tuple[str, str | None]:
        run_config = RunConfig(streaming_mode=StreamingMode.SSE, max_llm_calls=self.max_llm_calls)
        streamed_in_turn = False
        wrote_any = False
        final = ""
        error: str | None = None
        async for ev in self.runner.run_async(
            user_id=USER_ID,
            session_id=session_id,
            new_message=message,
            run_config=run_config,
            abort_signal=ctx.abort,
        ):
            if ev.error_message or ev.error_code:
                error = ev.error_message or str(ev.error_code)
                continue
            text = _text_of(ev.content)
            if ev.partial:
                if text:
                    if not streamed_in_turn and wrote_any:
                        self.host.emit("task.text", {"taskId": ctx.task_id, "delta": "\n\n"})
                    self.host.emit("task.text", {"taskId": ctx.task_id, "delta": text})
                    streamed_in_turn = wrote_any = True
                continue
            if ev.usage_metadata:
                usage["prompt"] += ev.usage_metadata.prompt_token_count or 0
                usage["output"] += ev.usage_metadata.candidates_token_count or 0
                usage["llm_calls"] += 1
            if text and not streamed_in_turn:
                if wrote_any:
                    self.host.emit("task.text", {"taskId": ctx.task_id, "delta": "\n\n"})
                self.host.emit("task.text", {"taskId": ctx.task_id, "delta": text})
                wrote_any = True
            streamed_in_turn = False
            if ev.is_final_response() and text:
                final = text
        return final, error
