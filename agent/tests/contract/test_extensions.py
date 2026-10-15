"""Eigene MCP-Server (echter stdio-Server) und Skills."""

import asyncio
import sys
from pathlib import Path

import aura_agent.testing
from aura_agent.harness.audit import AuditLog
from aura_agent.runtime.controller import TaskController
from aura_agent.runtime.server import build_runner
from aura_agent.runtime.settings import AgentSettings
from aura_agent.testing.fake_host import FakeHost
from aura_agent.testing.scripted_llm import Call, ScriptedLlm, tool_responses

NOTES_SERVER = Path(aura_agent.testing.__file__).with_name("notes_mcp.py")


async def run(ctl: TaskController) -> None:
    ctl.start("t", "c", "x")
    for _ in range(600):
        if not ctl.tasks:
            return
        await asyncio.sleep(0.05)
    raise AssertionError("Auftrag hängt")


async def test_user_mcp_server_tiers_and_results(tmp_path):
    notes = tmp_path / "notes.txt"
    notes.write_text("Milch kaufen\n")
    server = {
        "name": "notes",
        "command": sys.executable,
        "args": [str(NOTES_SERVER), str(notes)],
        "autoApprove": ["ping"],
    }
    settings = AgentSettings(
        data_dir=tmp_path / "agent", aura_dir=tmp_path / "aura", home=str(tmp_path), mcp_servers=[server]
    )
    llm = ScriptedLlm(
        [
            [Call("notes", {"request": "Notizen pflegen"})],
            [Call("mcp_notes_read_notes", {})],
            [Call("mcp_notes_ping", {})],
            [Call("mcp_notes_add_note", {"text": "Brot kaufen"})],
            "erledigt",
            "fertig",
        ]
    )
    host = FakeHost(["once"])
    ctl = TaskController(
        build_runner(settings, llm, browser=False), host, AuditLog(settings.data_dir / "audit"), settings.home
    )
    await run(ctl)
    assert [a["tool"] for a in host.approvals] == ["mcp_notes_add_note"]  # lesen T0, ping T1, anlegen T2
    assert "Brot kaufen" in notes.read_text()
    inner = [r for req in llm.requests for r in tool_responses(req)]
    assert any("Milch" in str(r.response) for r in inner if r.name == "mcp_notes_read_notes")


async def test_skills_are_listed_and_loaded(tmp_path):
    skill = tmp_path / "aura" / "skills" / "kaffee"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        "---\nname: kaffee\ndescription: Kaffee nach Hausrezept kochen\n---\n# Rezept\n18 g auf 300 ml, 94 Grad.\n"
    )
    (skill / "notiz.txt").write_text("x")
    settings = AgentSettings(data_dir=tmp_path / "agent", aura_dir=tmp_path / "aura", home=str(tmp_path))
    llm = ScriptedLlm([[Call("activate_skill", {"name": "kaffee"})], "ok"])
    ctl = TaskController(
        build_runner(settings, llm, browser=False),
        FakeHost(),
        AuditLog(settings.data_dir / "audit"),
        settings.home,
    )
    await run(ctl)
    system = llm.requests[0].config.system_instruction
    assert "kaffee: Kaffee nach Hausrezept kochen" in str(system)
    r = tool_responses(llm.requests[-1])[0].response
    assert "18 g auf 300 ml" in r["instructions"] and r["files"] == ["notiz.txt"]


async def test_disabled_skill_is_hidden(tmp_path):
    skill = tmp_path / "aura" / "skills" / "geheim"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: geheim\ndescription: aus\n---\nx\n")
    settings = AgentSettings(
        data_dir=tmp_path / "agent", aura_dir=tmp_path / "aura", disabled_skills=["geheim"]
    )
    llm = ScriptedLlm(["ok"])
    ctl = TaskController(
        build_runner(settings, llm, browser=False),
        FakeHost(),
        AuditLog(settings.data_dir / "audit"),
        settings.home,
    )
    await run(ctl)
    assert "geheim" not in str(llm.requests[0].config.system_instruction)
