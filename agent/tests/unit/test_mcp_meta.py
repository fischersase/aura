"""Stufen und Umgebung für MCP-Server des Nutzers (extensions/mcp.py, AURA-62)."""

from types import SimpleNamespace

import pytest

from aura_agent.extensions import mcp
from aura_agent.harness.tiers import Tier


def _tool(server: str, name: str, **hints):
    annotations = SimpleNamespace(**hints) if hints else None
    return SimpleNamespace(name=f"mcp_{server}_{name}", _mcp_tool=SimpleNamespace(annotations=annotations))


def _tier(meta, args=None):
    t = meta.tier(args or {}) if callable(meta.tier) else meta.tier
    return t[0] if isinstance(t, tuple) else t


@pytest.fixture(autouse=True)
def servers(monkeypatch):
    monkeypatch.setattr(mcp, "_SERVERS", {})
    for d in (
        {"name": "local", "command": "notes-server"},
        {"name": "remote", "url": "https://mcp.example/sse"},
        {"name": "trusted", "url": "https://mcp.example/sse", "autoApprove": ["search"]},
    ):
        cfg = mcp.ServerConfig.from_dict(d)
        mcp._SERVERS[cfg.prefix] = cfg


def test_read_only_hint_counts_only_for_local_servers():
    assert _tier(mcp._mcp_meta(_tool("local", "list", readOnlyHint=True))) == Tier.T0
    assert _tier(mcp._mcp_meta(_tool("remote", "list", readOnlyHint=True))) == Tier.T2
    assert _tier(mcp._mcp_meta(_tool("local", "wipe", readOnlyHint=True, destructiveHint=True))) == Tier.T2
    assert _tier(mcp._mcp_meta(_tool("local", "write"))) == Tier.T2


def test_auto_approve_still_applies_to_remote_servers():
    assert _tier(mcp._mcp_meta(_tool("trusted", "search", readOnlyHint=True))) == Tier.T1
    assert _tier(mcp._mcp_meta(_tool("trusted", "send"))) == Tier.T2


def test_stdio_servers_get_no_credentials_from_the_environment(monkeypatch):
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "from-env")
    monkeypatch.setenv("GITHUB_TOKEN", "from-env")
    monkeypatch.setenv("PATH", "/usr/bin")
    [(_, toolset)] = mcp.build_toolsets(
        [{"name": "envtest", "command": "srv", "env": {"API_TOKEN": "configured"}}]
    )
    env = toolset._connection_params.server_params.env
    assert env["PATH"] == "/usr/bin"
    assert env["API_TOKEN"] == "configured"  # what the user configured for this server is passed on
    assert "AWS_SECRET_ACCESS_KEY" not in env
    assert "GITHUB_TOKEN" not in env
