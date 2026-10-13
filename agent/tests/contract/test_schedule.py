"""Scheduled tasks from the chat (AURA-121): schedule_task asks first and sends host.scheduleTask as in the schema."""

import asyncio
import json
from pathlib import Path

import jsonschema

from aura_agent.harness.audit import AuditLog
from aura_agent.runtime.controller import TaskController
from aura_agent.runtime.server import build_runner
from aura_agent.runtime.settings import AgentSettings
from aura_agent.testing.fake_host import FakeHost
from aura_agent.testing.scripted_llm import Call, ScriptedLlm

SCHEMA = json.loads(
    (Path(__file__).parents[3] / "protocol" / "aura-agent.schema.json").read_text(encoding="utf-8")
)
HOST = SCHEMA["$defs"]["hostRequests"]


async def run(tmp_path, steps, decisions):
    s = AgentSettings(data_dir=tmp_path / "agent", aura_dir=tmp_path / "aura", home=str(tmp_path))
    host = FakeHost(decisions)
    ctl = TaskController(build_runner(s, ScriptedLlm(steps)), host, AuditLog(s.data_dir / "audit"), s.home)
    ctl.start("t1", "c1", "x")
    while ctl.tasks:
        await asyncio.sleep(0.01)
    return host


async def test_schedule_asks_with_plain_trigger_then_stores(tmp_path):
    call = Call(
        "schedule_task",
        {
            "title": "Zahnarzt",
            "prompt": "Erinnere mich: Zahnarzt um 10.",
            "kind": "once",
            "at": "2026-10-14T09:00",
        },
    )
    host = await run(tmp_path, [[call], [Call("list_scheduled_tasks", {})], "Geplant."], ["once"])
    [approval] = host.approvals
    assert "einmal am 2026-10-14T09:00" in approval["label"]
    assert "Zahnarzt um 10" in approval["effect"]
    [req] = host.scheduled
    jsonschema.validate(req, HOST["host.scheduleTask"]["params"])
    assert req["trigger"] == {"kind": "once", "at": "2026-10-14T09:00"}


async def test_denied_schedule_stores_nothing_and_weekdays_trigger(tmp_path):
    call = Call(
        "schedule_task",
        {
            "title": "Briefing",
            "prompt": "Termine zusammenfassen",
            "kind": "daily",
            "time": "08:00",
            "days": [1, 2, 3, 4, 5],
        },
    )
    host = await run(tmp_path, [[call], "Nicht geplant."], ["deny"])
    assert host.scheduled == []
    assert "täglich um 08:00 (Mo, Di, Mi, Do, Fr)" in host.approvals[0]["label"]
