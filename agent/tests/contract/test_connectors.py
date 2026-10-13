"""Connector proposals end to end (AURA-96): agent → host.searchRegistry / host.proposeConnector, as in the schema."""

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

ROOT = Path(__file__).parents[3]
SCHEMA = json.loads((ROOT / "protocol" / "aura-agent.schema.json").read_text(encoding="utf-8"))
HOST = SCHEMA["$defs"]["hostRequests"]
CATALOG = json.loads((ROOT / "src" / "catalog" / "connectors.json").read_text(encoding="utf-8"))["connectors"]


async def run(tmp_path, llm, host, **settings):
    s = AgentSettings(
        data_dir=tmp_path / "agent", aura_dir=tmp_path / "aura", home=str(tmp_path), connectors=CATALOG, **settings
    )
    ctl = TaskController(build_runner(s, llm), host, AuditLog(s.data_dir / "audit"), s.home)
    ctl.start("t1", "c1", "Zeig mir meine offenen Jira-Tickets")
    while ctl.tasks:
        await asyncio.sleep(0.01)
    return s


async def test_jira_request_ends_in_a_connect_card(tmp_path):
    host = FakeHost()
    host.proposal_decisions = ["never"]
    llm = ScriptedLlm(
        [
            [Call("find_connector", {"need": "jira tickets"})],
            [Call("propose_connector", {"id": "atlassian", "reason": "Damit ich deine Tickets lesen kann."})],
            "Ohne Verbindung zu Jira habe ich keinen Zugriff.",
        ]
    )
    await run(tmp_path, llm, host)
    [card] = host.proposals
    jsonschema.validate(card, HOST["host.proposeConnector"]["params"])
    assert card["id"] == "atlassian"
    # Both tools ran without an approval card: finding is T0, proposing T1 (the card is the user's decision).
    assert host.approvals == []
    steps = {p["tool"]: p["state"] for p in host.of("task.step") if p["state"] in ("ok", "error")}
    assert steps == {"find_connector": "ok", "propose_connector": "ok"}
    audit = "".join(p.read_text() for p in (tmp_path / "agent" / "audit").glob("*") if p.is_file())
    assert "connector_proposed" in audit


async def test_registry_search_goes_through_the_app(tmp_path):
    host = FakeHost()
    host.registry = [{"id": "io.github.acme/spotify", "title": "Spotify", "publisher": "acme"}]
    llm = ScriptedLlm([[Call("find_connector", {"need": "spotify playlists"})], "ok"])
    await run(tmp_path, llm, host)
    assert host.registry_queries == ["spotify playlists"]
    jsonschema.validate({"query": host.registry_queries[0]}, HOST["host.searchRegistry"]["params"])
    jsonschema.validate({"results": host.registry}, HOST["host.searchRegistry"]["result"])


def test_settings_carry_catalog_and_declined_ids():
    s = AgentSettings.from_params({"connectors": CATALOG + ["junk"], "declinedConnectors": ["github"]})
    assert [c["id"] for c in s.connectors] == [c["id"] for c in CATALOG]
    assert s.declined_connectors == ["github"]
    jsonschema.validate(
        {"protocol": 1, "settings": {"connectors": CATALOG, "declinedConnectors": ["github"]}},
        SCHEMA["$defs"]["requests"]["initialize"]["params"],
    )


async def test_without_catalog_there_are_no_connector_tools(tmp_path):
    s = AgentSettings(data_dir=tmp_path / "agent", aura_dir=tmp_path / "aura", home=str(tmp_path))
    runner = build_runner(s, ScriptedLlm(["x"]))
    names = {getattr(t, "__name__", getattr(t, "name", "")) for t in runner.agent.tools}
    assert "find_connector" not in names
