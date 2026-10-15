"""Deleting a chat removes the agent's session and episodes (NFR-PRIV-007, AURA-106)."""

import asyncio
import json
import sqlite3
from contextlib import closing

from aura_agent.rpc.peer import Peer
from aura_agent.runtime.server import AgentServer
from aura_agent.testing.scripted_llm import ScriptedLlm

from .test_protocol import check


def rows(db, chat_id: str) -> int:
    if not db.exists():
        return 0
    with closing(sqlite3.connect(db)) as c:
        try:
            return c.execute(
                "SELECT COUNT(*) FROM memory_events WHERE session_id = ?", (chat_id,)
            ).fetchone()[0]
        except sqlite3.OperationalError:
            return 0


def sessions(db, chat_id: str) -> int:
    with closing(sqlite3.connect(db)) as c:
        tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        table = next(t for t in tables if t.endswith("sessions"))
        return c.execute(f"SELECT COUNT(*) FROM {table} WHERE id = ?", (chat_id,)).fetchone()[0]  # noqa: S608


class Client:
    def __init__(self, tmp_path):
        self.reader = asyncio.StreamReader()
        self.sent: list[dict] = []
        self.peer = Peer(self.reader, lambda b: self.sent.append(json.loads(b)))
        AgentServer(self.peer, model=ScriptedLlm(["Notiert: der Drucker heißt Kranich.", "ok", "ok"]))
        self.serve = asyncio.create_task(self.peer.serve())
        self.rid = 0
        self.data = tmp_path / "agent"

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
                return hit[0]
            await asyncio.sleep(0.02)
        raise AssertionError(f"no answer to {method}")

    async def run(self, task_id: str, chat_id: str, text: str) -> None:
        await self.call("task.start", {"taskId": task_id, "chatId": chat_id, "text": text})
        for _ in range(300):
            if any(m.get("method") == "task.done" and m["params"]["taskId"] == task_id for m in self.sent):
                return
            await asyncio.sleep(0.05)
        raise AssertionError("task did not finish")

    async def close(self) -> None:
        self.reader.feed_eof()
        await self.serve


async def test_forget_deletes_session_and_episodes_of_one_chat(tmp_path):
    from aura_agent.memory.store import FactStore

    c = Client(tmp_path)
    await c.call(
        "initialize",
        {"protocol": 1, "warmUp": False, "settings": {"dataDir": str(c.data), "auraDir": str(tmp_path)}},
    )
    await c.run("t1", "chat-a", "Mein Drucker heißt Kranich")
    await c.run("t2", "chat-b", "Hallo")
    store = FactStore(tmp_path)
    store.remember("Drucker heißt Kranich", "Geräte", chat_id="chat-a", source="learned")
    store.remember("Lieblingsfarbe Grün", "Allgemein", chat_id="chat-b", source="learned")
    assert rows(c.data / "memory.db", "chat-a") > 0
    assert sessions(c.data / "sessions.db", "chat-a") == 1

    r = await c.call("chat.forget", {"chatId": "chat-a"})
    check("requests", "chat.forget", r["result"], "result")
    assert r["result"]["sessions"] == 1
    assert r["result"]["episodes"] > 0
    assert rows(c.data / "memory.db", "chat-a") == 0
    assert sessions(c.data / "sessions.db", "chat-a") == 0
    assert [f["text"] for f in store.list()] == ["Lieblingsfarbe Grün"]
    # The other chat is untouched.
    assert rows(c.data / "memory.db", "chat-b") > 0
    assert sessions(c.data / "sessions.db", "chat-b") == 1
    # Full-text search no longer finds the forgotten chat.
    with closing(sqlite3.connect(c.data / "memory.db")) as db:
        texts = " ".join(r[0] for r in db.execute("SELECT content_json FROM memory_events"))
    assert "Kranich" not in texts
    # Forgetting twice is harmless.
    again = await c.call("chat.forget", {"chatId": "chat-a"})
    assert again["result"] == {"sessions": 0, "episodes": 0}
    await c.close()


async def test_retain_removes_orphans_but_keeps_known_and_voice_chats(tmp_path):
    c = Client(tmp_path)
    await c.call(
        "initialize",
        {"protocol": 1, "warmUp": False, "settings": {"dataDir": str(c.data), "auraDir": str(tmp_path)}},
    )
    await c.run("t1", "deleted-chat", "Mein Drucker heißt Kranich")
    await c.run("t2", "known-chat", "Hallo")
    await c.run("t3", "voice-2026-10-13", "Wie spät ist es")
    r = await c.call("chat.retain", {"chatIds": ["known-chat"]})
    check("requests", "chat.retain", r["result"], "result")
    assert r["result"]["chats"] == 1
    assert sessions(c.data / "sessions.db", "deleted-chat") == 0
    assert sessions(c.data / "sessions.db", "known-chat") == 1
    assert sessions(c.data / "sessions.db", "voice-2026-10-13") == 1
    await c.close()


async def test_invalid_params_are_rejected(tmp_path):
    c = Client(tmp_path)
    await c.call(
        "initialize",
        {"protocol": 1, "warmUp": False, "settings": {"dataDir": str(c.data), "auraDir": str(tmp_path)}},
    )
    c.reader.feed_data(b'{"jsonrpc":"2.0","id":99,"method":"chat.forget","params":{"chatId":""}}\n')
    c.reader.feed_data(b'{"jsonrpc":"2.0","id":98,"method":"chat.retain","params":{"chatIds":"x"}}\n')
    await asyncio.sleep(0.1)
    errors = {m["id"]: m for m in c.sent if m.get("id") in (98, 99)}
    assert errors[99]["error"]["code"] == -32602
    assert errors[98]["error"]["code"] == -32602
    await c.close()
