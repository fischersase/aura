"""Memory page and incognito (AURA-108): facts over RPC, pause and incognito keep memory untouched."""

import asyncio
import json
import sqlite3
from contextlib import closing

from aura_agent.memory.store import FactStore
from aura_agent.rpc.peer import Peer
from aura_agent.runtime.server import AgentServer
from aura_agent.testing.scripted_llm import Call, ScriptedLlm

from .test_protocol import check


class Client:
    def __init__(self, tmp_path, script):
        self.reader = asyncio.StreamReader()
        self.sent: list[dict] = []
        self.peer = Peer(self.reader, lambda b: self.sent.append(json.loads(b)))
        AgentServer(self.peer, model=ScriptedLlm(script))
        self.serve = asyncio.create_task(self.peer.serve())
        self.rid = 0
        self.tmp = tmp_path

    async def call(self, method: str, params: dict) -> dict:
        self.rid += 1
        rid = self.rid
        check("requests", method, params, "params")
        self.reader.feed_data(
            (json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}) + "\n").encode()
        )
        for _ in range(300):
            hit = [m for m in self.sent if m.get("id") == rid]
            if hit:
                if "result" in hit[0]:
                    check("requests", method, hit[0]["result"], "result")
                return hit[0]
            await asyncio.sleep(0.02)
        raise AssertionError(f"no answer to {method}")

    async def init(self, **settings) -> None:
        await self.call(
            "initialize",
            {
                "protocol": 1,
                "warmUp": False,
                "settings": {"dataDir": str(self.tmp / "agent"), "auraDir": str(self.tmp), **settings},
            },
        )

    async def run(self, task_id: str, chat_id: str, text: str, **extra) -> dict:
        await self.call("task.start", {"taskId": task_id, "chatId": chat_id, "text": text, **extra})
        for _ in range(300):
            done = [
                m for m in self.sent if m.get("method") == "task.done" and m["params"]["taskId"] == task_id
            ]
            if done:
                return done[0]["params"]
            await asyncio.sleep(0.05)
        raise AssertionError("task did not finish")

    async def close(self) -> None:
        self.reader.feed_eof()
        await self.serve


def episodes(tmp_path, chat_id: str) -> int:
    db = tmp_path / "agent" / "memory.db"
    if not db.exists():
        return 0
    with closing(sqlite3.connect(db)) as c:
        try:
            return c.execute(
                "SELECT COUNT(*) FROM memory_events WHERE session_id = ?", (chat_id,)
            ).fetchone()[0]
        except sqlite3.OperationalError:
            return 0


async def test_memory_list_update_delete(tmp_path):
    store = FactStore(tmp_path)
    store.remember("Lieblingsfarbe Blau", "Vorlieben")
    store.remember("Wohnt in Hamburg", "Allgemein")
    c = Client(tmp_path, ["ok"])
    await c.init()
    facts = (await c.call("memory.list", {}))["result"]["facts"]
    assert {f["text"] for f in facts} == {"Lieblingsfarbe Blau", "Wohnt in Hamburg"}
    blue = next(f for f in facts if f["text"].startswith("Lieblings"))
    assert (await c.call("memory.update", {"id": blue["id"], "text": "Lieblingsfarbe Grün"}))["result"]["ok"]
    assert (await c.call("memory.update", {"id": blue["id"], "text": "PIN ist 1234"}))["result"]["error"]
    assert (await c.call("memory.delete", {"id": blue["id"]}))["result"]["removed"] == 1
    assert [f["text"] for f in store.list()] == ["Wohnt in Hamburg"]
    assert (await c.call("memory.deleteAll", {}))["result"]["removed"] == 1
    assert store.list() == []
    assert "Hamburg" not in store.index.read_text()
    await c.close()


async def test_incognito_chat_neither_remembers_nor_keeps_episodes(tmp_path):
    c = Client(tmp_path, [[Call("remember", {"fact": "Mag Jazz", "topic": "Vorlieben"})], "ok", "ok"])
    await c.init()
    await c.run("t1", "secret-chat", "Merk dir, dass ich Jazz mag", incognito=True)
    assert FactStore(tmp_path).list() == []
    assert episodes(tmp_path, "secret-chat") == 0
    # The same in a normal chat stores both.
    await c.run("t2", "normal-chat", "Hallo")
    assert episodes(tmp_path, "normal-chat") > 0
    await c.close()


async def test_paused_memory_stores_nothing(tmp_path):
    c = Client(tmp_path, [[Call("remember", {"fact": "Mag Jazz", "topic": "Vorlieben"})], "ok"])
    await c.init(memoryPaused=True)
    await c.run("t1", "c1", "Merk dir, dass ich Jazz mag")
    assert FactStore(tmp_path).list() == []
    assert episodes(tmp_path, "c1") == 0
    assert (await c.call("memory.list", {}))["result"]["paused"] is True
    await c.close()


async def test_unconfigured_gemini_still_starts_and_tasks_report_the_missing_key(tmp_path):
    FactStore(tmp_path).remember("Wohnt in Hamburg")
    reader = asyncio.StreamReader()
    sent: list[dict] = []
    peer = Peer(reader, lambda b: sent.append(json.loads(b)))
    AgentServer(peer)  # real model selection, no scripted model
    serve = asyncio.create_task(peer.serve())

    def send(rid, method, params):
        reader.feed_data(
            (json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}) + "\n").encode()
        )

    settings = {"dataDir": str(tmp_path / "agent"), "auraDir": str(tmp_path), "provider": "gemini"}
    send(1, "initialize", {"protocol": 1, "warmUp": False, "settings": settings})
    send(2, "memory.list", {})
    send(3, "task.start", {"taskId": "t1", "chatId": "c1", "text": "Hallo"})
    for _ in range(200):
        if any(m.get("method") == "task.error" for m in sent):
            break
        await asyncio.sleep(0.05)
    results = {m["id"]: m for m in sent if m.get("id") is not None}
    assert "result" in results[1], results[1]
    assert [f["text"] for f in results[2]["result"]["facts"]] == ["Wohnt in Hamburg"]
    error = next(m["params"]["message"] for m in sent if m.get("method") == "task.error")
    assert error.startswith("Gemini ist gewählt, aber es ist kein API-Schlüssel hinterlegt")
    reader.feed_eof()
    await serve
