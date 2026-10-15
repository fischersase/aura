"""Eigene Hooks des Nutzers (~/.aura/hooks.json), angelehnt an Claude Code und Gemini CLI.

Format:
  {
    "before_tool": [{"tool": "run_command", "command": "/home/me/bin/pruefe.sh"}],
    "after_tool":  [{"tool": "*", "command": "logger -t aura"}]
  }
Unter Windows z. B. "C:\\Users\\me\\pruefe.ps1" (läuft mit PowerShell) oder eine .cmd-Datei.

Ein Hook bekommt den Aufruf als JSON auf stdin: {"event", "tool", "args", "label", "tier", "task"} (nach dem Werkzeug
zusätzlich "result"). Vor dem Werkzeug gilt:
  Exit-Code 2 → sperren (stderr ist die Begründung), stdout {"decision": "ask"} → immer fragen,
  {"decision": "deny"} → sperren, sonst weiter wie gewohnt. Ein Hook kann nichts freigeben, was die Stufen sperren.
Hooks nach dem Werkzeug dienen nur der Beobachtung (Protokoll, Benachrichtigung).
Zeitlimit 10 s; ein fehlerhafter oder hängender before-Hook sperrt (sicherer Standard).
"""

from __future__ import annotations

import asyncio
import contextlib
import fnmatch
import json
import logging
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from ..platform.base import IS_WINDOWS
from ..platform.proc import child_env, kill_tree, spawn_kwargs

log = logging.getLogger(__name__)
TIMEOUT_S = 10.0


def hook_argv(command: str) -> list[str]:
    """Befehl eines Hooks zerlegen. Windows: Pfade mit \\ bleiben erhalten, .ps1 läuft über PowerShell."""
    if not IS_WINDOWS:
        parts = shlex.split(command)
    else:
        parts = [
            p[1:-1] if len(p) >= 2 and p[0] == p[-1] == '"' else p for p in shlex.split(command, posix=False)
        ]
        if parts and parts[0].lower().endswith(".ps1"):
            return [
                "powershell.exe",
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                *parts,
            ]
    if not parts:
        raise ValueError("leerer Hook-Befehl")
    return parts


@dataclass(frozen=True)
class Hook:
    tool: str
    command: str


@dataclass(frozen=True)
class HookVerdict:
    decision: str  # "continue" | "ask" | "deny"
    reason: str = ""


class Hooks:
    def __init__(self, file: Path | None) -> None:
        self.before: list[Hook] = []
        self.after: list[Hook] = []
        if file and file.exists():
            try:
                data = json.loads(file.read_text(encoding="utf-8"))
                self.before = [
                    Hook(str(h.get("tool", "*")), str(h["command"]))
                    for h in data.get("before_tool", [])
                    if h.get("command")
                ]
                self.after = [
                    Hook(str(h.get("tool", "*")), str(h["command"]))
                    for h in data.get("after_tool", [])
                    if h.get("command")
                ]
            except (OSError, json.JSONDecodeError, KeyError, TypeError, AttributeError) as e:
                log.warning("hooks.json unlesbar, Hooks ignoriert: %s", e)

    @staticmethod
    async def _run(hook: Hook, payload: dict[str, Any]) -> tuple[int, str, str]:
        proc = await asyncio.create_subprocess_exec(
            *hook_argv(hook.command),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=child_env(),
            **spawn_kwargs(new_group=True),
        )
        try:
            out, err = await asyncio.wait_for(
                proc.communicate(json.dumps(payload, ensure_ascii=False, default=str).encode()), TIMEOUT_S
            )
        except TimeoutError:
            kill_tree(proc.pid)
            with contextlib.suppress(Exception):
                await asyncio.wait_for(proc.wait(), 2.0)
            return 124, "", f"Hook {hook.command} nach {TIMEOUT_S:.0f} s abgebrochen"
        except asyncio.CancelledError:
            kill_tree(proc.pid)
            with contextlib.suppress(Exception):
                await asyncio.wait_for(proc.wait(), 2.0)
            raise
        return (
            proc.returncode or 0,
            out.decode(errors="replace").strip(),
            err.decode(errors="replace").strip(),
        )

    async def before_tool(self, payload: dict[str, Any]) -> HookVerdict:
        verdict = HookVerdict("continue")
        for hook in self.before:
            if not fnmatch.fnmatchcase(payload["tool"], hook.tool):
                continue
            try:
                code, out, err = await self._run(hook, {"event": "before_tool", **payload})
            except (OSError, ValueError) as e:
                return HookVerdict("deny", f"Hook {hook.command} ließ sich nicht starten: {e}")
            if code == 2:
                return HookVerdict("deny", err or f"Hook {hook.command} hat die Aktion gesperrt")
            if code != 0:
                return HookVerdict("deny", f"Hook {hook.command} ist fehlgeschlagen ({code}): {err[:200]}")
            try:
                parsed: Any = json.loads(out) if out.startswith("{") else None
                decision = (
                    cast("dict[str, Any]", parsed).get("decision") if isinstance(parsed, dict) else None
                )
            except json.JSONDecodeError:
                decision = None
            if decision == "deny":
                return HookVerdict("deny", f"Hook {hook.command} hat die Aktion gesperrt")
            if decision == "ask":
                verdict = HookVerdict("ask", f"Hook {hook.command} verlangt eine Rückfrage")
        return verdict

    async def after_tool(self, payload: dict[str, Any]) -> None:
        for hook in self.after:
            if fnmatch.fnmatchcase(payload["tool"], hook.tool):
                try:
                    await self._run(hook, {"event": "after_tool", **payload})
                except (OSError, ValueError) as e:
                    log.warning("after-Hook %s: %s", hook.command, e)
