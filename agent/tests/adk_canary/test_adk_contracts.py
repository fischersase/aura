"""Kanarientests: Verhält sich ADK so, wie die Aura-Architektur es annimmt?

Schlägt einer davon nach einem ADK-Update fehl, muss die betroffene
Architekturentscheidung (docs/adr) neu geprüft werden, bevor das Update
übernommen wird.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest
from google.adk.agents import LlmAgent
from google.adk.memory import SqliteMemoryService
from google.adk.plugins.base_plugin import BasePlugin
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.sessions.sqlite_session_service import SqliteSessionService
from google.adk.tools.agent_tool import AgentTool
from google.genai import types

from aura_agent.testing.scripted_llm import Call, ScriptedLlm, tool_responses

APP = "canary"


def msg(text: str) -> types.Content:
  return types.Content(role="user", parts=[types.Part(text=text)])


async def run(runner: Runner, session_id: str, text: str, **kw: Any) -> list:
  return [e async for e in runner.run_async(user_id="u", session_id=session_id, new_message=msg(text), **kw)]


async def new_runner(agent: LlmAgent, plugins: list | None = None, session_service=None) -> tuple[Runner, str]:
  sessions = session_service or InMemorySessionService()
  runner = Runner(app_name=APP, agent=agent, session_service=sessions, plugins=plugins or [])
  session = await sessions.create_session(app_name=APP, user_id="u")
  return runner, session.id


class Gate(BasePlugin):
  """Simuliert GuardedTool als Plugin: protokolliert und blockiert ein Werkzeug."""

  def __init__(self, deny: set[str]) -> None:
    super().__init__(name="gate")
    self.deny = deny
    self.seen: list[str] = []

  async def before_tool_callback(self, *, tool, tool_args, tool_context):
    self.seen.append(tool.name)
    if tool.name in self.deny:
      return {"error": "Der Nutzer hat diese Aktion abgelehnt."}
    return None


def delete_file(path: str) -> dict:
  """Löscht eine Datei."""
  raise AssertionError("darf nie laufen, Gate blockiert")


def read_file(path: str) -> dict:
  """Liest eine Datei."""
  return {"content": "hallo"}


async def test_plugin_sees_and_blocks_tools_inside_agent_tool():
  """Regeln greifen auch in Spezialisten-Agenten (AgentTool erbt die Plugins)."""
  inner_llm = ScriptedLlm([[Call("read_file", {"path": "a"})], [Call("delete_file", {"path": "a"})], "fertig"])
  inner = LlmAgent(name="files", model=inner_llm, description="Dateien", tools=[read_file, delete_file])
  root_llm = ScriptedLlm([[Call("files", {"request": "lösche a"})], "erledigt"])
  root = LlmAgent(name="aura", model=root_llm, tools=[AgentTool(agent=inner)])
  gate = Gate(deny={"delete_file"})
  runner, sid = await new_runner(root, plugins=[gate])
  await run(runner, sid, "lösche a")
  assert gate.seen == ["files", "read_file", "delete_file"]
  # Das innere Modell bekommt die Ablehnung als Werkzeugergebnis zu sehen.
  denied = [r for r in tool_responses(inner_llm.requests[-1]) if r.name == "delete_file"]
  assert denied and "abgelehnt" in str(denied[0].response)


async def test_plugin_can_answer_unknown_tool_names():
  """Erfundene Werkzeugnamen bringen den Lauf nicht zum Absturz, wenn ein Plugin antwortet."""

  class Unknown(BasePlugin):
    def __init__(self):
      super().__init__(name="unknown")

    async def before_tool_callback(self, *, tool, tool_args, tool_context):
      if tool.description == "Tool not found":
        return {"error": f"Werkzeug {tool.name} gibt es nicht. Verfügbar: read_file"}
      return None

  llm = ScriptedLlm([[Call("open_the_pod_bay_doors", {})], "ok"])
  runner, sid = await new_runner(LlmAgent(name="aura", model=llm, tools=[read_file]), plugins=[Unknown()])
  await run(runner, sid, "x")
  assert "gibt es nicht" in str(tool_responses(llm.requests[-1])[0].response)


async def test_abort_signal_stops_a_running_tool_quickly():
  started = asyncio.Event()

  async def slow_command(command: str) -> dict:
    """Langsamer Befehl."""
    started.set()
    await asyncio.sleep(30)
    return {"ok": True}

  llm = ScriptedLlm([[Call("slow_command", {"command": "sleep 30"})], "fertig"])
  runner, sid = await new_runner(LlmAgent(name="aura", model=llm, tools=[slow_command]))
  abort = asyncio.Event()

  async def stop_soon():
    await started.wait()
    abort.set()

  t0 = time.monotonic()
  stopper = asyncio.create_task(stop_soon())
  await asyncio.wait_for(run(runner, sid, "x", abort_signal=abort), timeout=10)
  await stopper
  assert time.monotonic() - t0 < 2.0


async def test_tool_exception_reaches_on_tool_error_callback():
  """Eine Ausnahme im Werkzeug lässt sich als Fehler ans Modell zurückgeben."""

  def broken() -> dict:
    """Kaputt."""
    raise RuntimeError("Datei gesperrt")

  class Catch(BasePlugin):
    def __init__(self):
      super().__init__(name="catch")

    async def on_tool_error_callback(self, *, tool, tool_args, tool_context, error):
      return {"error": str(error)}

  llm = ScriptedLlm([[Call("broken", {})], "ok"])
  runner, sid = await new_runner(LlmAgent(name="aura", model=llm, tools=[broken]), plugins=[Catch()])
  await run(runner, sid, "x")
  assert "Datei gesperrt" in str(tool_responses(llm.requests[-1])[0].response)


async def test_sqlite_sessions_survive_a_restart(tmp_path):
  db = str(tmp_path / "sessions.db")
  llm = ScriptedLlm(["Antwort eins", "Antwort zwei"])
  agent = LlmAgent(name="aura", model=llm)
  runner, sid = await new_runner(agent, session_service=SqliteSessionService(db))
  await run(runner, sid, "Frage eins")
  # Neuer Dienst auf derselben Datei, wie nach einem Neustart des Sidecars.
  sessions2 = SqliteSessionService(db)
  runner2 = Runner(app_name=APP, agent=agent, session_service=sessions2)
  await run(runner2, sid, "Frage zwei")
  seen = [p.text for c in llm.requests[-1].contents for p in c.parts or [] if p.text]
  assert "Frage eins" in seen and "Antwort eins" in seen


async def test_sqlite_memory_finds_earlier_sessions(tmp_path):
  sessions = InMemorySessionService()
  llm = ScriptedLlm(["Der Drucker im Büro heißt Brother HL-L2350DW."])
  runner, sid = await new_runner(LlmAgent(name="aura", model=llm), session_service=sessions)
  await run(runner, sid, "Wie heißt mein Drucker?")
  memory = SqliteMemoryService(tmp_path / "memory.db")
  await memory.add_session_to_memory(await sessions.get_session(app_name=APP, user_id="u", session_id=sid))
  found = await memory.search_memory(app_name=APP, user_id="u", query="Drucker")
  assert any("Brother" in (p.text or "") for m in found.memories for p in m.content.parts or [])
  await memory.close()


@pytest.mark.parametrize("n", [1])
async def test_runner_streams_only_final_events_without_stream_mode(n):
  """Ohne SSE-Streaming kommen nur vollständige Ereignisse (keine partial)."""
  llm = ScriptedLlm(["hallo"])
  runner, sid = await new_runner(LlmAgent(name="aura", model=llm))
  events = await run(runner, sid, "x")
  assert all(not e.partial for e in events)
