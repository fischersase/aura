"""Connector catalog, find_connector and propose_connector (AURA-96)."""

import json
from pathlib import Path

import jsonschema
import pytest

from aura_agent.harness.audit import AuditLog
from aura_agent.runtime.context import CURRENT, TaskContext
from aura_agent.testing.fake_host import FakeHost
from aura_agent.tools.connectors import RISK_REGISTRY, RISK_REVIEWED, make_connector_tools

CATALOG_DIR = Path(__file__).parents[3] / "src" / "catalog"
CATALOG = json.loads((CATALOG_DIR / "connectors.json").read_text(encoding="utf-8"))
SCHEMA = json.loads((CATALOG_DIR / "connectors.schema.json").read_text(encoding="utf-8"))
ENTRIES = CATALOG["connectors"]


def test_catalog_matches_its_schema():
    jsonschema.validate(CATALOG, SCHEMA)
    assert len({e["id"] for e in ENTRIES}) == len(ENTRIES)


def test_local_entry_without_pinned_version_is_refused():
    entry = {
        **ENTRIES[0],
        "id": "unpinned",
        "config": {"command": "npx", "args": ["-y", "@acme/mcp-server"]},
    }
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({"version": 1, "connectors": [entry]}, SCHEMA)
    entry["config"] = {"command": "npx", "args": ["-y", "@acme/mcp-server@1.4.2"]}
    jsonschema.validate({"version": 1, "connectors": [entry]}, SCHEMA)


def test_available_entries_need_tiers_and_a_review():
    entry = {k: v for k, v in ENTRIES[0].items() if k != "tiers"}
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({"version": 1, "connectors": [entry]}, SCHEMA)


def test_credentials_link_to_where_the_token_is_made():
    for e in ENTRIES:
        for c in e["credentials"]:
            assert c["help"], e["id"]
            if c["kind"] == "api-token":
                assert c["tokenUrl"].startswith("https://"), e["id"]


@pytest.fixture
def task(tmp_path):
    host = FakeHost()
    ctx = TaskContext(
        task_id="t1", chat_id="c1", host=host, audit=AuditLog(tmp_path / "a"), home=str(tmp_path)
    )
    token = CURRENT.set(ctx)
    yield ctx
    CURRENT.reset(token)


def tools(connected=(), declined=()):
    find, propose = make_connector_tools(ENTRIES, set(connected), set(declined))
    return find, propose


async def test_jira_tickets_find_atlassian_first(task):
    find, _ = tools()
    r = await find("Zeig mir meine offenen Jira-Tickets")
    assert r["source"] == "aura"
    first = r["candidates"][0]
    assert first["id"] == "atlassian"
    assert first["verified"] == "aura"
    assert first["connected"] is False
    assert any("Anmeldung" in n for n in first["needs"])
    assert task.host.registry_queries == []  # catalog hit: no registry search


async def test_github_needs_its_token(task):
    find, _ = tools()
    r = await find("github pull requests")
    assert r["candidates"][0]["id"] == "github"
    assert r["candidates"][0]["needs"] == ["Persönlicher Zugriffstoken (fine-grained)"]


async def test_connected_and_declined_entries(task):
    find, _ = tools(connected={"atlassian"})
    assert (await find("jira"))["candidates"][0]["connected"] is True
    find, _ = tools(declined={"atlassian"})
    r = await find("jira tickets")
    assert all(c["id"] != "atlassian" for c in r["candidates"])


async def test_no_catalog_hit_searches_the_registry_through_the_app(task):
    task.host.registry = [
        {"id": "io.github.acme/spotify", "title": "Spotify", "publisher": "acme", "needs": ["SPOTIFY_TOKEN"]},
        {"id": "io.github.x/a"},
        {"id": "io.github.x/b"},
        {"id": "io.github.x/c"},
    ]
    find, _ = tools()
    r = await find("spotify")
    assert task.host.registry_queries == ["spotify"]
    assert r["source"] == "registry"
    assert len(r["candidates"]) == 3
    assert {c["verified"] for c in r["candidates"]} == {"registry"}
    assert r["candidates"][0]["needs"] == ["SPOTIFY_TOKEN"]


async def test_registry_unreachable_is_reported(task):
    async def broken(_q):
        raise RuntimeError("offline")

    task.host.search_registry = broken
    find, _ = tools()
    r = await find("spotify")
    assert r["candidates"] == []
    assert "nicht erreichbar" in r["note"]


async def test_propose_shows_a_card_and_handles_every_decision(task):
    find, propose = tools()
    await find("jira")
    task.host.proposal_decisions = ["connect", "later", "never"]
    assert (await propose("atlassian", "Damit ich deine Tickets lesen kann."))["decision"] == "connect"
    card = task.host.proposals[0]
    assert card["id"] == "atlassian"
    assert card["taskId"] == "t1"
    assert card["risk"] == RISK_REVIEWED
    assert card["reason"] == "Damit ich deine Tickets lesen kann."
    assert (await propose("atlassian", "x"))["decision"] == "later"
    assert (await propose("atlassian", "x"))["decision"] == "never"
    # never: no further card, and find_connector no longer offers it
    r = await propose("atlassian", "x")
    assert "nicht mehr vorgeschlagen" in r["error"]
    assert len(task.host.proposals) == 3
    assert all(c["id"] != "atlassian" for c in (await find("jira tickets"))["candidates"])


async def test_registry_candidates_are_marked_unreviewed(task):
    task.host.registry = [{"id": "io.github.acme/spotify", "title": "Spotify"}]
    find, propose = tools()
    await find("spotify")
    await propose("io.github.acme/spotify", "Musik steuern")
    assert task.host.proposals[0]["verified"] == "registry"
    assert task.host.proposals[0]["risk"] == RISK_REGISTRY


async def test_propose_refuses_unknown_coming_and_connected(task):
    _, propose = tools(connected={"github"})
    assert "find_connector" in (await propose("nope", "x"))["error"]
    assert "noch nicht verfügbar" in (await propose("mail", "x"))["error"]
    assert "schon eingerichtet" in (await propose("github", "x"))["error"]
    assert task.host.proposals == []
