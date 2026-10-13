"""Scheduled and recurring tasks from the chat (AURA-121, FR-PAR-020).

"Erinnere mich morgen um 9 an …", "Schau jeden Montag um 8, ob …": the agent turns the wish into a structured trigger;
the app stores and runs it (src/scheduler.js). Planning is T2: the approval card shows the trigger in plain language,
so a page or file cannot plant a recurring task unnoticed.
"""

from __future__ import annotations

from typing import Any

from ..harness.tiers import Tier, aura_tool
from ..runtime.context import current

WEEKDAYS = ["", "Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]


def _when(a: dict[str, Any]) -> str:
    kind = a.get("kind")
    if kind == "once":
        return f"einmal am {a.get('at', '?')}"
    if kind == "interval":
        return f"alle {a.get('minutes', '?')} Minuten"
    days = a.get("days") or []
    names = ", ".join(WEEKDAYS[d] for d in days if isinstance(d, int) and 1 <= d <= 7)
    return f"täglich um {a.get('time', '?')}" + (f" ({names})" if names else "")


def _trigger(kind: str, at: str, time: str, days: list[int] | None, minutes: int) -> dict[str, Any]:
    if kind == "once":
        return {"kind": "once", "at": at}
    if kind == "interval":
        return {"kind": "interval", "minutes": minutes}
    return {"kind": "daily", "time": time, **({"days": days} if days else {})}


@aura_tool(
    Tier.T2,
    label=lambda a: f"{a.get('title', '')} – {_when(a)}",
    effect=lambda a: f"Plant „{a.get('title', '')}“ {_when(a)}: {str(a.get('prompt', ''))[:200]}",
)
async def schedule_task(
    title: str,
    prompt: str,
    kind: str,
    at: str = "",
    time: str = "",
    days: list[int] | None = None,
    minutes: int = 0,
) -> dict[str, Any]:
    """Plant einen Auftrag für später oder regelmäßig (Erinnerung, tägliche Zusammenfassung, regelmäßige Prüfung).

    Aura führt ihn zur geplanten Zeit im Hintergrund aus, solange Aura läuft, und meldet das Ergebnis.

    Args:
      title: Kurzer Titel, z. B. "Müll rausbringen".
      prompt: Der Auftrag, so wie Aura ihn dann ausführen soll, z. B. "Erinnere mich: Müll rausbringen."
      kind: "once" (einmal), "daily" (täglich oder an bestimmten Wochentagen) oder "interval" (alle N Minuten).
      at: Bei once: Datum und Uhrzeit, z. B. "2026-10-14T09:00".
      time: Bei daily: Uhrzeit "HH:MM", z. B. "08:00".
      days: Bei daily optional: Wochentage 1=Mo … 7=So, z. B. [1, 2, 3, 4, 5] für werktags.
      minutes: Bei interval: Abstand in Minuten (mindestens 15).
    """
    task = current()
    if task is None:
        return {"error": "Planen geht nur während eines Auftrags."}
    res = await task.host.schedule_task(
        {
            "taskId": task.task_id,
            "title": title,
            "prompt": prompt,
            "trigger": _trigger(kind, at, time, days, minutes),
        }
    )
    if res.get("error"):
        return {"error": str(res["error"])}
    return {"geplant": res.get("title"), "wann": res.get("when"), "id": res.get("id")}


@aura_tool(Tier.T0, label=lambda a: "geplante Aufgaben")
async def list_scheduled_tasks() -> dict[str, Any]:
    """Zeigt die geplanten Aufgaben (Titel, wann, nächster Lauf, letztes Ergebnis)."""
    task = current()
    if task is None:
        return {"error": "Nur während eines Auftrags."}
    return await task.host.list_tasks()


@aura_tool(
    Tier.T2,
    label=lambda a: str(a.get("id", "")),
    effect=lambda a: f"Geplante Aufgabe {a.get('id', '')} löschen",
)
async def cancel_scheduled_task(id: str) -> dict[str, Any]:
    """Löscht eine geplante Aufgabe (id aus list_scheduled_tasks).

    Args:
      id: Die id der Aufgabe.
    """
    task = current()
    if task is None:
        return {"error": "Nur während eines Auftrags."}
    return await task.host.cancel_task(id)
