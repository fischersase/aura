"""Hintergrundprozesse starten, überwachen, steuern und beenden (Antigravity / SRE Stil).

Für langlaufende Dienste, VPN-Tunnel (z. B. openvpn), lokale Server oder Programme mit Konsolenausgabe,
die nicht nach wenigen Sekunden enden sollen. Jeder gestartete Prozess wird im TaskContext registriert,
sodass der Not-Aus (Emergency Stop) auch alle Hintergrundprozesse samt Prozessbaum sofort beendet.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..harness.tiers import Tier, aura_tool
from ..platform.proc import child_env, kill_tree, spawn_kwargs
from ..policy.shell_classifier import classify
from ..runtime.context import current
from .paths import expand
from .shell import shell_argv

MAX_BUFFER_CHARS = 32000


@dataclass
class ManagedProcess:
    process_id: str
    command: str
    cwd: str
    proc: asyncio.subprocess.Process
    started_at: float = field(default_factory=time.time)
    buffer: list[str] = field(default_factory=list)
    buffer_chars: int = 0
    reader_task: asyncio.Task[None] | None = None

    def append_output(self, text: str) -> None:
        if not text:
            return
        self.buffer.append(text)
        self.buffer_chars += len(text)
        while self.buffer and self.buffer_chars > MAX_BUFFER_CHARS:
            removed = self.buffer.pop(0)
            self.buffer_chars -= len(removed)

    def output_text(self, tail_chars: int = 8000) -> str:
        joined = "".join(self.buffer)
        return joined[-tail_chars:] if len(joined) > tail_chars else joined

    @property
    def running(self) -> bool:
        return self.proc.returncode is None


_REGISTRY: dict[str, ManagedProcess] = {}
_COUNTER = 0


async def _pump_stdout(mp: ManagedProcess) -> None:
    if mp.proc.stdout is None:
        return
    try:
        while True:
            chunk = await mp.proc.stdout.read(4096)
            if not chunk:
                break
            mp.append_output(chunk.decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001 - stream end on process kill
        return


def _bg_start_tier(a: dict[str, Any]) -> tuple[Tier, str]:
    cmd = str(a.get("command", ""))
    base_tier, reason = classify(cmd)
    if base_tier >= Tier.T3:
        return base_tier, reason
    return Tier.T2, reason or "Hintergrundprozess starten"


@aura_tool(
    tier=_bg_start_tier,
    label=lambda a: f"Hintergrundprozess: {a.get('command', '')}",
    effect=lambda a: f"Startet im Hintergrund: {a.get('command', '')}",
)
async def start_background_process(command: str, cwd: str = "~", wait_ms: int = 1500) -> dict[str, Any]:
    """Startet einen langlaufenden Befehl im Hintergrund (z. B. VPN-Client, Server, Watcher) und gibt die Prozess-ID sowie die erste Ausgabe zurück.

    Args:
      command: Der auszuführende Befehl.
      cwd: Arbeitsordner (Standard: "~").
      wait_ms: Wie viele Millisekunden auf die erste Ausgabe gewartet wird (200–5000, Standard 1500).
    """
    global _COUNTER
    cmd = command.strip()
    if not cmd:
        return {"error": "Bitte gib einen Befehl (command) an."}
    task = current()
    home = task.home if task else str(Path.home())
    workdir = expand(cwd, home)
    if not workdir.is_dir():
        return {"error": f"Arbeitsordner gibt es nicht: {workdir}"}

    proc = await asyncio.create_subprocess_exec(
        *shell_argv(cmd),
        cwd=str(workdir),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        **spawn_kwargs(),
        env=child_env({"PAGER": "cat", "GIT_PAGER": "cat", "TERM": "dumb"}),
    )
    if task:
        task.processes.add(proc)

    _COUNTER += 1
    proc_id = f"bg-{_COUNTER}"
    mp = ManagedProcess(process_id=proc_id, command=cmd, cwd=str(workdir), proc=proc)
    mp.reader_task = asyncio.create_task(_pump_stdout(mp))
    _REGISTRY[proc_id] = mp

    delay = max(0.2, min(5.0, float(wait_ms) / 1000.0))
    await asyncio.sleep(delay)

    status = "running" if mp.running else "exited"
    return {
        "process_id": proc_id,
        "pid": proc.pid,
        "status": status,
        "exit_code": proc.returncode,
        "output": mp.output_text() or "(noch keine Ausgabe)",
        "verified": f"{proc_id} (PID {proc.pid}, {status})",
    }


def _bg_manage_tier(a: dict[str, Any]) -> tuple[Tier, str]:
    act = str(a.get("action", "list")).lower().strip()
    if act in ("list", "status", "output"):
        return Tier.T0, ""
    return Tier.T1, f"Hintergrundprozess steuern ({act})"


@aura_tool(
    tier=_bg_manage_tier,
    label=lambda a: f"Hintergrundprozess {a.get('action', 'list')} {a.get('process_id', '')}".strip(),
)
async def manage_background_process(
    action: str = "list", process_id: str = "", input_text: str = ""
) -> dict[str, Any]:
    """Überwacht oder steuert laufende Hintergrundprozesse.

    Args:
      action: "list" (alle zeigen), "status" / "output" (Ausgabe und Status lesen), "send_input" (Text an stdin senden), "stop" (Prozessbaum beenden).
      process_id: Die Prozess-ID (z. B. "bg-1"), erforderlich außer bei "list".
      input_text: Zu sendende Zeile bei action="send_input".
    """
    act = action.lower().strip()
    if act == "list":
        items = [
            {
                "process_id": mp.process_id,
                "pid": mp.proc.pid,
                "command": mp.command[:120],
                "status": "running" if mp.running else "exited",
                "exit_code": mp.proc.returncode,
            }
            for mp in _REGISTRY.values()
        ]
        return {"count": len(items), "processes": items}

    mp = _REGISTRY.get(process_id.strip())
    if mp is None:
        return {"error": f"Unbekannte process_id: {process_id!r}. Nutze action='list' für alle Prozesse."}

    if act in ("status", "output"):
        return {
            "process_id": mp.process_id,
            "pid": mp.proc.pid,
            "command": mp.command,
            "status": "running" if mp.running else "exited",
            "exit_code": mp.proc.returncode,
            "output": mp.output_text() or "(keine Ausgabe)",
        }

    if act == "send_input":
        if not mp.running or mp.proc.stdin is None:
            return {"error": f"Prozess {mp.process_id} läuft nicht mehr oder nimmt keine Eingabe an."}
        data = (input_text + "\n").encode("utf-8", "replace")
        try:
            mp.proc.stdin.write(data)
            await mp.proc.stdin.drain()
        except OSError as e:
            return {"error": f"Senden fehlgeschlagen: {e}"}
        await asyncio.sleep(0.4)
        return {
            "ok": True,
            "process_id": mp.process_id,
            "status": "running" if mp.running else "exited",
            "output": mp.output_text() or "(keine Ausgabe)",
        }

    if act in ("stop", "kill"):
        if mp.running and mp.proc.pid is not None:
            kill_tree(mp.proc.pid)
            with contextlib.suppress(Exception):
                await asyncio.wait_for(mp.proc.wait(), timeout=2.0)
        if mp.reader_task and not mp.reader_task.done():
            mp.reader_task.cancel()
        return {
            "ok": True,
            "process_id": mp.process_id,
            "status": "stopped",
            "exit_code": mp.proc.returncode,
            "output": mp.output_text(tail_chars=2000),
            "verified": f"{mp.process_id} beendet",
        }

    return {"error": "action muss 'list', 'status', 'output', 'send_input' oder 'stop' sein."}
