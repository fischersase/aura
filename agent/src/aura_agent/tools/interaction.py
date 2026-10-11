"""Planen und Nachfragen: Aufgabenliste (wie write_todos in Gemini CLI) und Rückfrage an den Nutzer."""

from __future__ import annotations

from typing import Any

from google.adk.tools.tool_context import ToolContext

from ..harness.tiers import Tier, aura_tool
from ..runtime.context import current

STATUSES = ("pending", "in_progress", "done", "cancelled")
ASK_TIMEOUT_S = 600


def _normalize(items: Any) -> list[dict[str, str]]:
  out = []
  for it in items or []:
    if isinstance(it, str):
      out.append({"text": it, "status": "pending"})
    elif isinstance(it, dict):
      text = str(it.get("text") or it.get("description") or it.get("task") or "").strip()
      status = str(it.get("status", "pending")).lower()
      if text:
        out.append({"text": text, "status": status if status in STATUSES else "pending"})
  return out


@aura_tool(Tier.T0, label=lambda a: f"{len(a.get('items') or [])} Punkte")
def todo_write(items: list[dict[str, str]], tool_context: ToolContext) -> dict[str, Any]:
  """Legt die Aufgabenliste für den aktuellen Auftrag an oder aktualisiert sie (immer die ganze Liste schicken).

  Bei Aufträgen mit mehreren Schritten zuerst planen, dann abarbeiten. Genau ein Punkt ist "in_progress".

  Args:
    items: Liste von {"text": "…", "status": "pending" | "in_progress" | "done" | "cancelled"}.
  """
  todos = _normalize(items)
  if not todos:
    return {"error": "items ist leer oder hat das falsche Format: [{\"text\": \"…\", \"status\": \"pending\"}]"}
  tool_context.state["todos"] = todos
  task = current()
  if task:
    task.host.emit("task.plan", {"taskId": task.task_id, "items": todos})
  open_items = [t["text"] for t in todos if t["status"] in ("pending", "in_progress")]
  return {"ok": True, "open": open_items, "done": sum(t["status"] == "done" for t in todos)}


@aura_tool(Tier.T0, label=lambda a: str(a.get("question", ""))[:120])
async def ask_user(question: str, options: list[str] | None = None) -> dict[str, Any]:
  """Fragt den Nutzer und wartet auf die Antwort. Nutzen, wenn etwas unklar ist, statt zu raten
  (z. B. welche von mehreren Dateien, welches Konto, ob etwas wirklich gelöscht werden soll).

  Args:
    question: Die Frage, kurz und konkret.
    options: Optional 2–5 Antwortmöglichkeiten; der Nutzer kann trotzdem frei antworten.
  """
  task = current()
  if task is None:
    return {"error": "Keine Verbindung zum Nutzer."}
  try:
    res = await task.host.ask({"taskId": task.task_id, "question": question, "options": list(options or [])[:5]})
  except Exception as e:  # noqa: BLE001 - ohne Antwort weiterarbeiten, aber ehrlich
    return {"error": f"Keine Antwort vom Nutzer ({e})."}
  answer = str((res or {}).get("answer", "")).strip()
  if not answer:
    return {"answer": "", "note": "Der Nutzer hat nicht geantwortet. Nichts Folgenreiches tun, sondern nachfragen oder abbrechen."}
  return {"answer": answer}
