"""OAuth MCP servers (AURA-95): the agent gets a fresh Authorization header per request from the app."""

import asyncio
import socket
from types import SimpleNamespace

import pytest
import uvicorn
from mcp.server.mcpserver import MCPServer

from aura_agent.extensions import mcp
from aura_agent.harness.audit import AuditLog
from aura_agent.runtime.context import CURRENT, TaskContext
from aura_agent.testing.fake_host import FakeHost

TOKEN = "Bearer test-access-token-123"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def protected(app):
    """Lets only requests with the right bearer token through, like a remote MCP server behind OAuth."""

    async def guarded(scope, receive, send):
        if scope["type"] == "http":
            headers = dict(scope.get("headers") or [])
            if headers.get(b"authorization", b"").decode() != TOKEN:
                await send(
                    {
                        "type": "http.response.start",
                        "status": 401,
                        "headers": [(b"content-type", b"text/plain")],
                    }
                )
                await send({"type": "http.response.body", "body": b"unauthorized"})
                return
        await app(scope, receive, send)

    return guarded


@pytest.fixture
async def remote_server():
    server = MCPServer("jira")

    @server.tool()
    def list_issues() -> str:
        """Open issues."""
        return "AURA-1"

    port = free_port()
    config = uvicorn.Config(
        protected(server.streamable_http_app()), host="127.0.0.1", port=port, log_level="warning"
    )
    uv = uvicorn.Server(config)
    task = asyncio.create_task(uv.serve())
    while not uv.started:
        await asyncio.sleep(0.02)
    yield f"http://127.0.0.1:{port}/mcp"
    uv.should_exit = True
    await task


def task_context(tmp_path, host):
    return TaskContext(
        task_id="t", chat_id="c", host=host, audit=AuditLog(tmp_path / "a"), home=str(tmp_path)
    )


async def test_tools_are_listed_with_the_header_from_the_app(remote_server, tmp_path, monkeypatch):
    monkeypatch.setattr(mcp, "_SERVERS", {})
    [(_cfg, toolset)] = mcp.build_toolsets([{"name": "jira", "url": remote_server, "auth": "oauth"}])
    host = FakeHost()
    host.auth_headers["jira"] = TOKEN
    token = CURRENT.set(task_context(tmp_path, host))
    try:
        tools = await toolset.get_tools(readonly_context=SimpleNamespace(state={}))
        assert [t.name for t in tools] == ["list_issues"]  # the prefix is added by ADK when tools are exposed
        assert host.auth_requests and set(host.auth_requests) == {"jira"}
    finally:
        CURRENT.reset(token)
        await toolset.close()
    # The token never reaches the audit log.
    audit = "".join(p.read_text() for p in (tmp_path / "a").glob("*") if p.is_file())
    assert "test-access-token" not in audit


async def test_without_sign_in_the_server_is_not_reachable(remote_server, tmp_path, monkeypatch):
    monkeypatch.setattr(mcp, "_SERVERS", {})
    [(_cfg, toolset)] = mcp.build_toolsets([{"name": "jira", "url": remote_server, "auth": "oauth"}])
    token = CURRENT.set(task_context(tmp_path, FakeHost()))
    try:
        with pytest.raises(Exception, match=r"Nicht verbunden|Anmeldung|401|unauthorized|Failed"):
            await toolset.get_tools(readonly_context=SimpleNamespace(state={}))
    finally:
        CURRENT.reset(token)
        await toolset.close()


def test_servers_without_oauth_get_no_header_provider(monkeypatch):
    monkeypatch.setattr(mcp, "_SERVERS", {})
    [(_c, plain)] = mcp.build_toolsets([{"name": "plain", "url": "http://127.0.0.1:9/mcp"}])
    assert plain.header_provider is None
