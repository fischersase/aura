"""Shell-Befehle mit Einstufung (siehe policy/shell_classifier.py): bash unter Linux, PowerShell unter Windows.

Jeder Befehl läuft in einer eigenen Prozessgruppe, damit der Not-Aus auch
Kindprozesse sicher beendet (platform/proc.py).
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
from pathlib import Path
from typing import Any

from ..harness.guard import clip
from ..harness.tiers import aura_tool
from ..platform.base import IS_WINDOWS
from ..platform.proc import child_env, kill_tree, spawn_kwargs
from ..policy.shell_classifier import classify
from ..runtime.context import current
from .paths import expand

MAX_OUTPUT = 12000
# Fortschrittsbalken aus, Ausgabe als UTF-8 (sonst kommen Umlaute in der OEM-Codepage).
PS_PRELUDE = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); "


async def warm_up_shell() -> None:
    """Windows: PowerShell einmal im Hintergrund starten. Der erste Start nach dem Hochfahren dauert sonst
    mehrere Sekunden (beobachtet bis über 10 s auf frischen CI-Rechnern), jeder weitere unter einer Sekunde."""
    if not IS_WINDOWS:
        return
    with contextlib.suppress(OSError):
        proc = await asyncio.create_subprocess_exec(
            *shell_argv("exit 0"),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            **spawn_kwargs(),
        )
        await proc.wait()


def shell_argv(command: str) -> list[str]:
    if IS_WINDOWS:
        # Als -EncodedCommand (UTF-16LE, base64): keine Probleme mit Anführungszeichen. Eingestuft wird der Befehl selbst.
        encoded = base64.b64encode((PS_PRELUDE + command).encode("utf-16-le")).decode()
        return [
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encoded,
        ]
    return ["/bin/bash", "-lc", command]


@aura_tool(
    tier=lambda a: classify(a.get("command", "")),
    label=lambda a: a.get("command", ""),
    effect=lambda a: a.get("command", ""),
)
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
        *shell_argv(command),
        cwd=str(workdir),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        **spawn_kwargs(),
        env=child_env({"PAGER": "cat", "GIT_PAGER": "cat", "TERM": "dumb"}),
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
    result: dict[str, Any] = {
        "exit_code": proc.returncode,
        "output": clip(out.decode(errors="replace"), MAX_OUTPUT) or "(keine Ausgabe)",
    }
    if timed_out:
        result["error"] = f"Nach {timeout} s abgebrochen."
    return result


def _kill(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is None:
        kill_tree(proc.pid)


if IS_WINDOWS:
    run_command.__doc__ = (
        (run_command.__doc__ or "")
        .replace("einen bash-Befehl auf dem Linux-PC", "einen PowerShell-Befehl auf dem Windows-PC")
        .replace(
            "Nur lesende Befehle",
            "Pfade dürfen mit ~ beginnen. Nur lesende Befehle (Get-…, dir, Select-Object …)",
        )
    )
