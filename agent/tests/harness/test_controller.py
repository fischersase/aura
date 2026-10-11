"""Hüllen-Tests (L3): ganzer Auftragsablauf mit Drehbuch-Modell und Host-Attrappe."""

import asyncio
import time
from pathlib import Path

from aura_agent.harness.audit import AuditLog
from aura_agent.harness.guard import DENIED
from aura_agent.runtime.controller import EMPTY_ANSWER_NUDGE, TaskController
from aura_agent.runtime.server import build_runner
from aura_agent.runtime.settings import AgentSettings
from aura_agent.testing.fake_host import FakeHost
from aura_agent.testing.scripted_llm import Call, ScriptedLlm, tool_responses


def make(tmp_path: Path, steps, decisions=None):
  settings = AgentSettings(data_dir=tmp_path / "agent", aura_dir=tmp_path / "aura", home=str(tmp_path))
  llm = ScriptedLlm(steps)
  host = FakeHost(decisions)
  ctl = TaskController(build_runner(settings, llm), host, AuditLog(settings.data_dir / "audit"), settings.home)
  return ctl, host, llm, settings


async def finish(ctl: TaskController, timeout: float = 10) -> None:
  t0 = time.monotonic()
  while ctl.tasks and time.monotonic() - t0 < timeout:
    await asyncio.sleep(0.01)
  assert not ctl.tasks, "Auftrag hängt"


def states(host: FakeHost, tool: str) -> list[str]:
  return [p["state"] for p in host.of("task.step") if p["tool"] == tool]


async def test_read_only_tool_runs_without_asking(tmp_path):
  (tmp_path / "notiz.txt").write_text("Milch, Brot")
  ctl, host, llm, _ = make(tmp_path, [[Call("read_file", {"path": "~/notiz.txt"})], "Auf der Liste stehen Milch und Brot."])
  ctl.start("t1", "c1", "Was steht in notiz.txt?")
  await finish(ctl)
  assert host.approvals == []
  assert states(host, "read_file") == ["run", "ok"]
  assert "Milch" in str(tool_responses(llm.requests[-1])[0].response)
  assert host.done()["text"] == "Auf der Liste stehen Milch und Brot."
  assert host.text() == "Auf der Liste stehen Milch und Brot."


async def test_denied_command_is_not_run_and_model_is_told(tmp_path):
  target = tmp_path / "bleibt.txt"
  target.write_text("x")
  ctl, host, llm, _ = make(tmp_path, [[Call("run_command", {"command": f"rm {target}"})], "Abgelehnt, nichts gelöscht."], ["deny"])
  ctl.start("t1", "c1", "lösch bleibt.txt")
  await finish(ctl)
  assert target.exists()
  assert host.approvals[0]["tool"] == "run_command" and host.approvals[0]["tier"] == 2
  assert "rm" in host.approvals[0]["effect"]
  assert states(host, "run_command") == ["ask", "denied"]
  assert DENIED in str(tool_responses(llm.requests[-1])[0].response)


async def test_approved_command_runs(tmp_path):
  ctl, host, _, _ = make(tmp_path, [[Call("run_command", {"command": "touch neu.txt", "cwd": str(tmp_path)})], "Angelegt."], ["once"])
  ctl.start("t1", "c1", "leg neu.txt an")
  await finish(ctl)
  assert (tmp_path / "neu.txt").exists()
  assert states(host, "run_command") == ["ask", "run", "ok"]


async def test_allow_for_task_skips_later_questions(tmp_path):
  steps = [[Call("run_command", {"command": "touch a", "cwd": str(tmp_path)})],
           [Call("run_command", {"command": "touch b", "cwd": str(tmp_path)})], "Beide angelegt."]
  ctl, host, _, _ = make(tmp_path, steps, ["task"])
  ctl.start("t1", "c1", "leg a und b an")
  await finish(ctl)
  assert len(host.approvals) == 1
  assert (tmp_path / "a").exists() and (tmp_path / "b").exists()


async def test_forbidden_command_is_blocked_without_asking(tmp_path):
  ctl, host, llm, _ = make(tmp_path, [[Call("run_command", {"command": "cat ~/.ssh/id_rsa"})], "Das darf ich nicht."], ["once"])
  ctl.start("t1", "c1", "zeig meinen ssh key")
  await finish(ctl)
  assert host.approvals == []
  assert states(host, "run_command") == ["denied"]
  assert "gesperrt" in str(tool_responses(llm.requests[-1])[0].response)


async def test_unknown_tool_becomes_error_not_crash(tmp_path):
  ctl, host, llm, _ = make(tmp_path, [[Call("launch_rocket", {})], "Das kann ich nicht."])
  ctl.start("t1", "c1", "x")
  await finish(ctl)
  assert "gibt es nicht" in str(tool_responses(llm.requests[-1])[0].response)
  assert host.done()["text"] == "Das kann ich nicht."


async def test_empty_answer_is_rejected_once(tmp_path):
  ctl, host, llm, _ = make(tmp_path, [[Call("system_info", {})], "", "Ich habe die Systeminfos abgefragt."])
  ctl.start("t1", "c1", "wie viel RAM?")
  await finish(ctl)
  seen = [p.text for c in llm.requests[-1].contents for p in c.parts or [] if p.text]
  assert EMPTY_ANSWER_NUDGE in seen
  assert host.done()["text"] == "Ich habe die Systeminfos abgefragt."


async def test_cancel_kills_running_command_quickly(tmp_path):
  marker = tmp_path / "noch_da"
  cmd = f"sleep 30; touch {marker}"
  ctl, host, _, _ = make(tmp_path, [[Call("run_command", {"command": cmd})], "fertig"], ["once"])
  ctl.start("t1", "c1", "warte")
  for _ in range(200):
    if "run" in states(host, "run_command"):
      break
    await asyncio.sleep(0.01)
  await asyncio.sleep(0.2)
  t0 = time.monotonic()
  assert await ctl.cancel("t1")
  assert time.monotonic() - t0 < 2.5
  await finish(ctl)
  assert host.done()["cancelled"] is True
  await asyncio.sleep(0.2)
  assert not marker.exists()


async def test_session_remembers_previous_turns(tmp_path):
  ctl, _host, llm, _ = make(tmp_path, ["Hallo Anna.", "Du heißt Anna."])
  ctl.start("t1", "chat-1", "Ich heiße Anna")
  await finish(ctl)
  ctl.start("t2", "chat-1", "Wie heiße ich?")
  await finish(ctl)
  seen = [p.text for c in llm.requests[-1].contents for p in c.parts or [] if p.text]
  assert "Ich heiße Anna" in seen and "Hallo Anna." in seen


async def test_audit_records_the_whole_task(tmp_path):
  ctl, _, _, settings = make(tmp_path, [[Call("run_command", {"command": "rm x"})], "nein"], ["deny"])
  ctl.start("t1", "c1", "lösch x")
  await finish(ctl)
  f = next((settings.data_dir / "audit").glob("*.jsonl"))
  kinds = [__import__("json").loads(line)["kind"] for line in f.read_text().splitlines()]
  assert kinds == ["task_start", "approval_requested", "approval", "task_end"]
  assert AuditLog.verify(f)[0]


async def test_ask_user_question_and_answer_reach_the_model(tmp_path):
  steps = [[Call("ask_user", {"question": "Welche Datei?", "options": ["a.txt", "b.txt"]})], "Ok, b.txt."]
  settings = AgentSettings(data_dir=tmp_path / "agent", aura_dir=tmp_path / "aura", home=str(tmp_path))
  llm = ScriptedLlm(steps)
  host = FakeHost(answers=["b.txt"])
  ctl = TaskController(build_runner(settings, llm), host, AuditLog(settings.data_dir / "audit"), settings.home)
  ctl.start("t1", "c1", "lösch die Datei")
  await finish(ctl)
  assert host.questions[0]["question"] == "Welche Datei?" and host.questions[0]["options"] == ["a.txt", "b.txt"]
  assert tool_responses(llm.requests[-1])[0].response == {"answer": "b.txt"}


async def test_todo_write_emits_plan_and_keeps_it_in_session(tmp_path):
  items = [{"text": "Ordner finden", "status": "done"}, {"text": "Dateien zählen", "status": "in_progress"}]
  ctl, host, _llm, _ = make(tmp_path, [[Call("todo_write", {"items": items})], "fertig"])
  ctl.start("t1", "c1", "zähl Dateien")
  await finish(ctl)
  plan = host.of("task.plan")
  assert plan and plan[0]["items"] == items
  session = await ctl.runner.session_service.get_session(app_name="aura", user_id="local", session_id="c1")
  assert session.state["todos"] == items


async def test_loop_guard_warns_then_stops(tmp_path):
  same = [Call("list_dir", {"path": str(tmp_path)})]
  ctl, host, llm, _ = make(tmp_path, [same, same, same, same, same, "aufgegeben"])
  ctl.start("t1", "c1", "x")
  await finish(ctl)
  responses = [str(r.response) for req in llm.requests for r in tool_responses(req)[-1:]]
  assert "3× mit denselben Argumenten" in responses[2]
  assert "zum 5. Mal" in str(tool_responses(llm.requests[-1])[-1].response)
  assert states(host, "list_dir").count("ok") == 4


async def test_false_success_claim_is_corrected(tmp_path, private_dbus):
  from tests.contract.fake_mpris import start_player

  bus, player = await start_player(stuck=True)
  try:
    ctl, host, llm, _ = make(tmp_path, [[Call("media_control", {"action": "pause"})], "Die Musik ist pausiert.",
                                        "Korrektur: Pausieren hat nicht geklappt, der Player reagiert nicht."])
    ctl.start("t1", "c1", "pausiere")
    await finish(ctl)
  finally:
    bus.disconnect()
  assert player.calls == ["Pause"]
  seen = [p.text for c in llm.requests[-1].contents for p in c.parts or [] if p.text]
  assert any("NICHT wirksam" in t for t in seen)
  done = host.done()
  assert done["verified"] is False and done["text"].startswith("Korrektur")


async def test_verified_success_is_reported(tmp_path, private_dbus):
  from tests.contract.fake_mpris import start_player

  bus, _ = await start_player()
  try:
    ctl, host, llm, _ = make(tmp_path, [[Call("media_control", {"action": "pause"})], "Pausiert."])
    ctl.start("t1", "c1", "pausiere")
    await finish(ctl)
  finally:
    bus.disconnect()
  assert host.done()["verified"] is True and len(llm.requests) == 2
