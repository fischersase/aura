"""Die Hülle um jedes Werkzeug (ADR 0003).

Ablauf je Aufruf: Stufe bestimmen → bei T3 sperren → bei T2 den Nutzer fragen
→ ausführen → Ergebnis kürzen und protokollieren. Fehler und unbekannte
Werkzeuge werden zu Fehlerergebnissen, die das Modell sieht, statt den Lauf
abzubrechen. Gilt auch für Werkzeuge in Spezialisten-Agenten (AgentTool erbt
Plugins, siehe Kanarientest).
"""

from __future__ import annotations

import json
import time
from typing import Any

from google.adk.plugins.base_plugin import BasePlugin
from google.adk.tools.agent_tool import AgentTool
from google.adk.tools.base_tool import BaseTool
from google.adk.tools.tool_context import ToolContext

from ..runtime.context import current
from .tiers import Tier, meta_of

MAX_RESULT_CHARS = 12000

DENIED = ("Der Nutzer hat im Freigabe-Dialog auf „Ablehnen“ geklickt. Die Aktion wurde NICHT ausgeführt. "
           "Sag ihm das so und frag nicht erneut nach derselben Aktion.")
BLOCKED = "Diese Aktion ist gesperrt (Stufe T3: {reason}). Sie wurde NICHT ausgeführt."


def clip(text: str, limit: int = MAX_RESULT_CHARS) -> str:
  if len(text) <= limit:
    return text
  half = limit // 2
  return f"{text[:half]}\n… ({len(text) - limit} Zeichen ausgelassen) …\n{text[-half:]}"


def _clip_result(result: Any) -> Any:
  if isinstance(result, dict):
    return {k: _clip_result(v) for k, v in result.items()}
  if isinstance(result, str):
    return clip(result)
  return result


def _failed(result: Any) -> bool:
  if not isinstance(result, dict):
    return False
  if result.get("error"):
    return True
  code = result.get("exit_code")
  return code not in (None, 0)


class GuardPlugin(BasePlugin):
  def __init__(self) -> None:
    super().__init__(name="aura_guard")
    self._started: dict[str, float] = {}
    # Aufrufe, die die Hülle selbst beantwortet hat (abgelehnt, gesperrt, unbekannt).
    # ADK ruft danach trotzdem after_tool_callback auf; dort werden sie übersprungen.
    self._answered: set[str] = set()

  async def before_tool_callback(
      self, *, tool: BaseTool, tool_args: dict[str, Any], tool_context: ToolContext
  ) -> dict[str, Any] | None:
    task = current()
    step_id = tool_context.function_call_id or f"s{time.monotonic_ns()}"
    if task is None:
      return None
    task.steps += 1

    if tool.description == "Tool not found":
      task.audit.write("tool_unknown", task=task.task_id, tool=tool.name)
      self._answered.add(step_id)
      return {"error": f"Das Werkzeug „{tool.name}“ gibt es nicht. Nutze nur die angebotenen Werkzeuge."}

    if isinstance(tool, AgentTool):
      task.step(step_id, tool.name, str(tool_args.get("request", ""))[:200], "run", agent=tool.name)
      self._started[step_id] = time.monotonic()
      return None

    meta = meta_of(tool)
    tier, reason = meta.classify(tool_args)
    label = meta.describe(tool.name, tool_args)
    common = {"task": task.task_id, "tool": tool.name, "args": tool_args, "tier": int(tier), "agent": tool_context.agent_name}

    if tier >= Tier.T3:
      task.step(step_id, tool.name, label, "denied", tier=int(tier))
      task.audit.write("blocked", **common, reason=reason)
      self._answered.add(step_id)
      return {"error": BLOCKED.format(reason=reason or "nicht erlaubt")}

    decision = "auto"
    if tier >= Tier.T2 and not (task.allow_all or tool.name in task.allowed_tools):
      task.step(step_id, tool.name, label, "ask", tier=int(tier))
      effect = meta.effect(tool_args) if meta.effect else label
      task.audit.write("approval_requested", **common, reason=reason)
      try:
        decision = await task.host.approve({
            "taskId": task.task_id, "stepId": step_id, "tool": tool.name, "label": label,
            "tier": int(tier), "reason": reason, "effect": effect,
        })
      except Exception as e:  # noqa: BLE001 - ohne Antwort gilt die Aktion als abgelehnt
        task.audit.write("approval_failed", **common, error=str(e))
        decision = "deny"
      task.audit.write("approval", **common, decision=decision)
      if decision == "task":
        task.allow_all = True
      elif decision != "once":
        task.step(step_id, tool.name, label, "denied", tier=int(tier))
        self._answered.add(step_id)
        return {"error": DENIED}

    task.step(step_id, tool.name, label, "run", tier=int(tier))
    task.audit.write("tool_start", **common, decision=decision)
    self._started[step_id] = time.monotonic()
    return None

  async def after_tool_callback(
      self, *, tool: BaseTool, tool_args: dict[str, Any], tool_context: ToolContext, result: dict[str, Any]
  ) -> dict[str, Any] | None:
    task = current()
    if task is None:
      return None
    step_id = tool_context.function_call_id or ""
    if step_id in self._answered:
      self._answered.discard(step_id)
      return None
    ms = round((time.monotonic() - self._started.pop(step_id, time.monotonic())) * 1000)
    failed = _failed(result)
    task.tool_errors_in_row = task.tool_errors_in_row + 1 if failed else 0
    label = str(tool_args.get("request", ""))[:200] if isinstance(tool, AgentTool) else meta_of(tool).describe(tool.name, tool_args)
    task.step(step_id, tool.name, label, "error" if failed else "ok", ms=ms)
    task.audit.write("tool_result", task=task.task_id, tool=tool.name, ok=not failed, ms=ms,
                     error=result.get("error") if isinstance(result, dict) else None)
    clipped = _clip_result(result)
    return clipped if json.dumps(clipped, default=str) != json.dumps(result, default=str) else None

  async def on_tool_error_callback(
      self, *, tool: BaseTool, tool_args: dict[str, Any], tool_context: ToolContext, error: Exception
  ) -> dict[str, Any] | None:
    task = current()
    message = f"{type(error).__name__}: {error}"
    if task is not None:
      step_id = tool_context.function_call_id or ""
      self._started.pop(step_id, None)
      task.tool_errors_in_row += 1
      task.step(step_id, tool.name, meta_of(tool).describe(tool.name, tool_args), "error")
      task.audit.write("tool_error", task=task.task_id, tool=tool.name, error=message)
    return {"error": message}
