"""Vertragstests: Alles, was der Agent an Electron schickt, entspricht protocol/aura-agent.schema.json.

Die Gegenseite (src/agent2/bridge.js) wird im Node-Test test/agent2.test.js
gegen den echten Agenten geprüft.
"""

import asyncio
import json
from pathlib import Path

import jsonschema
import pytest

from aura_agent.harness.audit import AuditLog
from aura_agent.rpc.peer import Peer
from aura_agent.runtime.controller import TaskController
from aura_agent.runtime.server import AgentServer, build_runner
from aura_agent.runtime.settings import AgentSettings
from aura_agent.testing.fake_host import FakeHost
from aura_agent.testing.scripted_llm import Call, ScriptedLlm

SCHEMA = json.loads((Path(__file__).parents[3] / "protocol" / "aura-agent.schema.json").read_text())
DEFS = SCHEMA["$defs"]


def check(kind: str, method: str, payload: dict, part: str | None = None) -> None:
    spec = DEFS[kind][method]
    jsonschema.validate(payload, spec[part] if part else spec)


async def test_notifications_and_approvals_match_schema(tmp_path):
    settings = AgentSettings(data_dir=tmp_path / "agent", aura_dir=tmp_path / "aura", home=str(tmp_path))
    llm = ScriptedLlm(
        [
            [Call("todo_write", {"items": [{"text": "Ordner ansehen", "status": "in_progress"}]})],
            [Call("ask_user", {"question": "Wirklich?", "options": ["ja", "nein"]})],
            [Call("list_dir", {"path": str(tmp_path)}), Call("run_command", {"command": "rm x"})],
            [Call("run_command", {"command": "cat ~/.ssh/id_rsa"})],
            "fertig",
        ]
    )
    host = FakeHost(["deny"], answers=["ja"])
    ctl = TaskController(
        build_runner(settings, llm), host, AuditLog(settings.data_dir / "audit"), settings.home
    )
    ctl.start("t1", "c1", "x")
    while ctl.tasks:
        await asyncio.sleep(0.01)
    methods = {m for m, _ in host.events}
    assert {"task.step", "task.text", "task.done", "task.plan"} <= methods
    for q in host.questions:
        check("hostRequests", "host.ask", q, "params")
    for method, params in host.events:
        check("notifications", method, params)
    for req in host.approvals:
        check("hostRequests", "host.approve", req, "params")


async def test_rpc_methods_match_schema(tmp_path):
    reader = asyncio.StreamReader()
    sent: list[dict] = []
    peer = Peer(reader, lambda b: sent.append(json.loads(b)))
    AgentServer(peer, model=ScriptedLlm(["ok"]))
    serve = asyncio.create_task(peer.serve())

    def send(rid, method, params):
        check("requests", method, params, "params")
        reader.feed_data(
            (json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}) + "\n").encode()
        )

    send(
        1,
        "initialize",
        {
            "protocol": 1,
            "warmUp": False,
            "settings": {"dataDir": str(tmp_path / "agent"), "auraDir": str(tmp_path)},
        },
    )
    send(2, "catalog.list", {})
    send(3, "task.start", {"taskId": "t1", "chatId": "c1", "text": "hallo"})
    for _ in range(300):  # bis der Auftrag fertig ist (unter Windows in der CI deutlich langsamer)
        if any(m.get("method") == "task.done" for m in sent):
            break
        await asyncio.sleep(0.05)
    send(4, "task.cancel", {"taskId": "nope"})
    send(5, "ping", {})
    await asyncio.sleep(0.1)
    reader.feed_eof()
    await serve
    results = {m["id"]: m for m in sent if "id" in m and m.get("id") is not None}
    for rid, method in (
        (1, "initialize"),
        (2, "catalog.list"),
        (3, "task.start"),
        (4, "task.cancel"),
        (5, "ping"),
    ):
        assert "result" in results[rid], results[rid]
        check("requests", method, results[rid]["result"], "result")
    done = [m["params"] for m in sent if m.get("method") == "task.done"]
    assert done and done[0]["text"] == "ok"


async def test_wrong_protocol_version_is_rejected(tmp_path):
    reader = asyncio.StreamReader()
    sent: list[dict] = []
    peer = Peer(reader, lambda b: sent.append(json.loads(b)))
    AgentServer(peer, model=ScriptedLlm([]))
    serve = asyncio.create_task(peer.serve())
    reader.feed_data(b'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":99}}\n')
    await asyncio.sleep(0.05)
    reader.feed_eof()
    await serve
    assert "Protokollversion" in sent[0]["error"]["message"]


@pytest.mark.parametrize("decision", ["once", "task", "deny"])
def test_host_decisions_are_in_schema(decision):
    check("hostRequests", "host.approve", {"decision": decision}, "result")
