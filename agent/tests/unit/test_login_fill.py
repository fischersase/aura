"""Website logins in the browser (tools/browser.py make_login_tools, AURA-124): the password never reaches the model."""

import json

import pytest

from aura_agent.harness.audit import AuditLog
from aura_agent.harness.guard import mask
from aura_agent.runtime.context import CURRENT, TaskContext
from aura_agent.testing.fake_host import FakeHost
from aura_agent.tools.browser import make_login_tools

SECRET = "Geheim-123!"


class FakeTypeTool:
    name = "browser_type"

    def __init__(self):
        self.calls = []

    async def run_async(self, *, args, tool_context):
        self.calls.append(args)
        # Playwright echoes the typed text in its code output; the tool must never pass this on.
        return {"content": [{"type": "text", "text": f"await page.fill('{args['text']}')"}], "isError": False}


class FakeToolset:
    def __init__(self):
        self.type_tool = FakeTypeTool()

    async def get_tools(self, readonly_context=None):
        return [self.type_tool]


@pytest.fixture
def setup(tmp_path):
    host = FakeHost()
    host.logins["BAHN"] = {
        "origin": "https://www.bahn.de",
        "username": "anna@example.org",
        "password": SECRET,
    }
    ctx = TaskContext(
        task_id="t1", chat_id="c1", host=host, audit=AuditLog(tmp_path / "a"), home=str(tmp_path)
    )
    ctx.origin = "https://www.bahn.de"
    token = CURRENT.set(ctx)
    toolset = FakeToolset()
    logins, fill = make_login_tools(toolset)
    yield ctx, toolset, logins, fill, tmp_path
    CURRENT.reset(token)


async def test_fill_types_both_fields_and_returns_no_secret(setup):
    ctx, toolset, logins, fill, tmp_path = setup
    assert await logins() == {
        "website": "https://www.bahn.de",
        "logins": [{"name": "BAHN", "username": "anna@example.org"}],
    }
    r = await fill(login="BAHN", password_target="e7", username_target="e5", submit=True)
    assert r["ok"] is True
    assert [c["target"] for c in toolset.type_tool.calls] == ["e5", "e7"]
    assert toolset.type_tool.calls[1]["text"] == SECRET and toolset.type_tool.calls[1]["submit"] is True
    assert SECRET not in json.dumps(r)
    assert SECRET in ctx.masked
    audit = "".join(p.read_text() for p in (tmp_path / "a").glob("*") if p.is_file())
    assert "login_filled" in audit and SECRET not in audit


async def test_other_origin_gets_nothing(setup):
    ctx, toolset, _, fill, _ = setup
    ctx.origin = "https://bahn-login.evil.example"
    r = await fill(login="BAHN", password_target="e7")
    assert "nicht" in r["error"]
    assert toolset.type_tool.calls == []
    assert SECRET not in json.dumps(r)


def test_masked_values_are_replaced_in_later_results():
    result = {"content": [{"type": "text", "text": f"- textbox 'Passwort': {SECRET}"}]}
    assert SECRET not in json.dumps(mask(result, {SECRET}))
    assert mask("nichts", set()) == "nichts"
