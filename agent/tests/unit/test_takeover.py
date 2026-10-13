"""Browser takeover and CAPTCHA rule (tools/browser.py, AURA-118)."""

import json
from pathlib import Path

import jsonschema
import pytest

from aura_agent.harness.audit import AuditLog
from aura_agent.harness.tiers import Tier
from aura_agent.runtime.context import CURRENT, TaskContext
from aura_agent.testing.fake_host import FakeHost
from aura_agent.tools import browser

SCHEMA = json.loads(
    (Path(__file__).parents[3] / "protocol" / "aura-agent.schema.json").read_text(encoding="utf-8")
)


def tier(name, args):
    t = browser.METAS[name].tier(args)
    return t[0] if isinstance(t, tuple) else t


@pytest.mark.parametrize(
    "element",
    [
        "Ich bin kein Roboter",
        "reCAPTCHA checkbox",
        "hCaptcha challenge",
        "Cloudflare Turnstile",
        "Verify you are human",
    ],
)
def test_captcha_elements_are_blocked(element):
    assert tier("browser_click", {"element": element, "target": "e1"}) == Tier.T3
    assert tier("browser_type", {"element": element, "text": "x"}) == Tier.T3


def test_normal_elements_are_not_blocked():
    assert tier("browser_click", {"element": "Suchen"}) == Tier.T1
    assert tier("browser_click", {"element": "Jetzt kaufen"}) == Tier.T2


@pytest.fixture
def task(tmp_path):
    ctx = TaskContext(
        task_id="t1", chat_id="c1", host=FakeHost(), audit=AuditLog(tmp_path / "a"), home=str(tmp_path)
    )
    token = CURRENT.set(ctx)
    yield ctx
    CURRENT.reset(token)


async def test_takeover_continue_and_cancel(task):
    task.host.takeover_decisions = ["continue", "cancel"]
    r = await browser.request_takeover("Bitte bei der Bahn anmelden")
    assert r["decision"] == "continue"
    assert "browser_snapshot" in r["note"]
    assert (await browser.request_takeover("CAPTCHA lösen"))["decision"] == "cancel"
    for req in task.host.takeovers:
        jsonschema.validate(req, SCHEMA["$defs"]["hostRequests"]["host.takeover"]["params"])
    assert task.host.takeovers[0] == {"taskId": "t1", "reason": "Bitte bei der Bahn anmelden"}
    # Pages after a takeover are not verified by Aura: the task counts as tainted.
    assert "request_takeover" in task.tainted_by
