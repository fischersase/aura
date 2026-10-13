import asyncio
import json

import pytest

from aura_agent.rpc.peer import METHOD_NOT_FOUND, Peer, RpcError


def pipe_pair():
    """Zwei Peers, deren Ausgaben jeweils beim anderen ankommen."""
    ra, rb = asyncio.StreamReader(), asyncio.StreamReader()
    a = Peer(ra, rb.feed_data)
    b = Peer(rb, ra.feed_data)
    return a, b, ra, rb


async def test_requests_in_both_directions():
    a, b, ra, rb = pipe_pair()
    b.on("add", lambda p: asyncio.sleep(0, result=p["x"] + p["y"]))

    async def approve(p):
        # b fragt während der Bearbeitung zurück bei a
        return {"decision": await b.request("host.approve", {"tool": p["tool"]})}

    b.on("work", approve)
    a.on("host.approve", lambda p: asyncio.sleep(0, result="once" if p["tool"] == "ls" else "deny"))
    tasks = [asyncio.create_task(a.serve()), asyncio.create_task(b.serve())]
    assert await a.request("add", {"x": 2, "y": 3}) == 5
    assert await a.request("work", {"tool": "ls"}) == {"decision": "once"}
    assert await a.request("work", {"tool": "rm"}) == {"decision": "deny"}
    with pytest.raises(RpcError) as e:
        await a.request("nope")
    assert e.value.code == METHOD_NOT_FOUND
    ra.feed_eof()
    rb.feed_eof()
    await asyncio.gather(*tasks)


async def test_notifications_and_closed_connection_fail_pending():
    reader = asyncio.StreamReader()
    sent: list[dict] = []
    p = Peer(reader, lambda b: sent.append(json.loads(b)))
    got = []
    p.on("task.text", lambda params: asyncio.sleep(0, result=got.append(params)))
    serve = asyncio.create_task(p.serve())
    reader.feed_data(b'{"jsonrpc":"2.0","method":"task.text","params":{"delta":"hi"}}\n')
    pending = asyncio.create_task(p.request("host.screenshot", {}))
    await asyncio.sleep(0.01)
    assert got == [{"delta": "hi"}]
    assert sent[-1]["method"] == "host.screenshot"
    reader.feed_eof()
    await serve
    with pytest.raises(RpcError):
        await pending


async def test_invalid_json_gets_parse_error():
    reader = asyncio.StreamReader()
    sent: list[dict] = []
    p = Peer(reader, lambda b: sent.append(json.loads(b)))
    serve = asyncio.create_task(p.serve())
    reader.feed_data(b"kein json\n")
    reader.feed_eof()
    await serve
    assert sent[0]["error"]["code"] == -32700


async def test_malformed_responses_do_not_stop_the_connection():
    reader = asyncio.StreamReader()
    sent: list[dict] = []
    p = Peer(reader, lambda b: sent.append(json.loads(b)))
    serve = asyncio.create_task(p.serve())
    first = asyncio.create_task(p.request("host.screenshot", {}))
    await asyncio.sleep(0.01)
    rid = sent[-1]["id"]
    reader.feed_data(b'{"id": [1], "result": {}}\n')  # unhashable id
    reader.feed_data(json.dumps({"id": rid, "error": "kaputt"}).encode() + b"\n")  # error is not an object
    with pytest.raises(RpcError) as e:
        await first
    assert "kaputt" in e.value.message
    # The connection still works afterwards.
    second = asyncio.create_task(p.request("host.screenshot", {}))
    await asyncio.sleep(0.01)
    reader.feed_data(json.dumps({"id": sent[-1]["id"], "result": {"ok": True}}).encode() + b"\n")
    assert await second == {"ok": True}
    reader.feed_eof()
    await serve
