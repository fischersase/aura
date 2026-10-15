"""Hermetic unit and contract tests for Aura Agent 3.0 (Antigravity + Universal Computer-Use)."""

from __future__ import annotations

import plistlib
from pathlib import Path
from typing import Any

import pytest

from aura_agent.agents.subagents import make_subagent_tools
from aura_agent.harness.audit import AuditLog
from aura_agent.harness.guard import GuardPlugin
from aura_agent.harness.tiers import Tier
from aura_agent.platform import macos
from aura_agent.policy.engine import PolicyEngine
from aura_agent.runtime.context import CURRENT, TaskContext
from aura_agent.runtime.controller import TaskController
from aura_agent.runtime.server import build_runner
from aura_agent.runtime.settings import AgentSettings
from aura_agent.testing.scripted_llm import Call, ScriptedLlm
from aura_agent.tools.apps import list_apps
from aura_agent.tools.packages import install_software, network_status, search_software
from aura_agent.tools.pointer import clipboard, drag_mouse, move_mouse, scroll_at
from aura_agent.tools.processes import (
    _bg_start_tier,
    manage_background_process,
    start_background_process,
)
from aura_agent.tools.web import (
    _DdgHtmlParser,
    _download_tier,
    _validate_public_url,
    download_file,
    html_to_text,
    web_fetch,
)


class _DummyHost:
    def __init__(self) -> None:
        self.inputs: list[dict[str, Any]] = []
        self.approvals: list[dict[str, Any]] = []

    async def input(self, req: dict[str, Any]) -> dict[str, Any]:
        self.inputs.append(req)
        if req.get("action") == "clipboard":
            if req.get("mode") == "write":
                return {"ok": True, "length": len(str(req.get("text", "")))}
            return {"ok": True, "text": "Kopierter Text"}
        return {"ok": True}

    async def screenshot(self, max_width: int = 1600) -> dict[str, Any]:
        return {"mime": "image/jpeg", "data": "dGVzdA=="}

    async def approve(self, req: dict[str, Any]) -> str:
        self.approvals.append(req)
        return "deny"

    def emit(self, method: str, params: dict[str, Any]) -> None:
        pass


def test_macos_bundle_discovery_and_window_controls(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    app_dir = tmp_path / "Applications"
    bundle = app_dir / "ProtonVPN.app" / "Contents"
    bundle.mkdir(parents=True)
    with (bundle / "Info.plist").open("wb") as f:
        plistlib.dump(
            {
                "CFBundleDisplayName": "Proton VPN",
                "CFBundleIdentifier": "ch.protonvpn.mac",
                "CFBundleExecutable": "ProtonVPN",
            },
            f,
        )
    monkeypatch.setattr(macos, "APP_DIRS", (app_dir,))
    bundles = macos.installed_bundles()
    assert len(bundles) == 1
    assert bundles[0]["name"] == "Proton VPN"
    assert bundles[0]["id"] == "ch.protonvpn.mac"
    assert bundles[0]["exe"] == "ProtonVPN"

    monkeypatch.setattr(
        macos,
        "run_osascript",
        lambda script, **kw: (0, "50,false" if "volume settings" in script else "true"),
    )
    assert macos.act("m:42:1", "focus") is True
    assert macos.set_volume(level=50, mute=False) == {"percent": 50, "muted": False}
    assert macos.set_dark_mode(True) == {"dark": True, "verified": True}


async def test_pointer_motorik_move_drag_scroll_clipboard(tmp_path: Path) -> None:
    assert move_mouse.__aura__.classify({"x": 100, "y": 200})[0] == Tier.T1
    assert (
        drag_mouse.__aura__.classify(
            {"element": "Helligkeitsregler", "start_x": 10, "start_y": 10, "end_x": 50, "end_y": 10}
        )[0]
        == Tier.T1
    )
    assert (
        drag_mouse.__aura__.classify(
            {"element": "Konto löschen", "start_x": 10, "start_y": 10, "end_x": 50, "end_y": 10}
        )[0]
        == Tier.T2
    )
    assert scroll_at.__aura__.classify({"x": 500, "y": 500, "direction": "down"})[0] == Tier.T1
    assert clipboard.__aura__.classify({"action": "read"})[0] == Tier.T0
    assert clipboard.__aura__.classify({"action": "write", "text": "Hallo"})[0] == Tier.T1

    host = _DummyHost()
    token = CURRENT.set(
        TaskContext(
            task_id="t1", chat_id="c1", host=host, audit=AuditLog(tmp_path / "audit"), home=str(tmp_path)
        )
    )
    try:
        r_move = await move_mouse(250, 300, "Menü Datei")
        assert r_move["ok"] and r_move["image"] is not None
        r_drag = await drag_mouse(100, 200, 400, 250, "Schieberegler Kontrast")
        assert r_drag["ok"] and r_drag["image"] is not None
        r_scroll = await scroll_at(500, 500, "down", 5)
        assert r_scroll["ok"] and r_scroll["image"] is not None
        r_clip_w = await clipboard("write", "Spanien VPN")
        assert r_clip_w == {"ok": True, "length": 11}
        r_clip_r = await clipboard("read")
        assert r_clip_r == {"ok": True, "text": "Kopierter Text"}

        assert "zwischen 0 und 1000" in (await move_mouse(1200, 10))["error"]
        assert "zwischen 0 und 1000" in (await drag_mouse(0, 0, 1500, 10, "Regler"))["error"]
        assert "direction muss" in (await scroll_at(100, 100, "diagonal"))["error"]
    finally:
        CURRENT.reset(token)


async def test_web_tools_ssrf_and_html_extraction(tmp_path: Path) -> None:
    assert _validate_public_url("http://127.0.0.1:9222/json") is not None
    assert _validate_public_url("http://localhost:8080/") is not None
    assert _validate_public_url("http://169.254.169.254/latest/meta-data") is not None
    assert _validate_public_url("http://192.168.1.1/admin") is not None
    assert _validate_public_url("file:///etc/passwd") is not None
    assert _validate_public_url("https://protonvpn.com/free-vpn") is None

    res = await web_fetch("http://127.0.0.1:8080/secret")
    assert "gesperrt" in res["error"]
    dl = await download_file("http://localhost/evil.sh", str(tmp_path))
    assert "gesperrt" in dl["error"]

    title, text = html_to_text(
        "<html><head><title>Spain VPN Guide</title><script>evil()</script></head>"
        "<body><h1>Connect to Spain</h1><p>Use WireGuard or OpenVPN.</p></body></html>"
    )
    assert title == "Spain VPN Guide"
    assert "evil()" not in text
    assert "## Connect to Spain" in text
    assert "Use WireGuard or OpenVPN." in text

    ddg = _DdgHtmlParser()
    ddg.feed(
        '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fvpn">Free Spain VPN</a>'
        '<a class="result__snippet">Fast connection to Madrid.</a>'
    )
    assert ddg.results == [
        {"title": "Free Spain VPN", "url": "https://example.org/vpn", "snippet": "Fast connection to Madrid."}
    ]

    assert (
        _download_tier({"url": "https://example.org/photo.jpg", "destination": str(tmp_path)})[0] == Tier.T1
    )
    assert (
        _download_tier({"url": "https://example.org/installer.deb", "destination": str(tmp_path)})[0]
        == Tier.T2
    )


async def test_packages_and_network_status_verification(monkeypatch: pytest.MonkeyPatch) -> None:
    bad = await install_software("vlc; rm -rf /")
    assert "Ungültige Paket-ID" in bad["error"]

    async def fake_exec(cmd: list[str], timeout: float = 20.0) -> tuple[int, str, str]:
        if cmd[0] == "flatpak" and cmd[1] == "search":
            return 0, "Proton VPN\tcom.protonvpn.www\t4.2.0\tFree VPN app", ""
        if cmd[0] == "winget" and cmd[1] == "search":
            return (
                0,
                "Name        Id                 Version\n--------------------------------------\nProton VPN  Proton.ProtonVPN   3.3.0",
                "",
            )
        if cmd[0] == "powershell.exe":
            return 0, "Ethernet\nProtonVPN TUN\n", ""
        if cmd[0] == "ip":
            return 0, "lo UNKNOWN 127.0.0.1/8\nwg-spain0 UNKNOWN 10.2.0.2/32\n", ""
        if cmd[0] == "nmcli":
            return 0, "Spain-VPN:wireguard:wg-spain0\n", ""
        return 0, "installed", ""

    monkeypatch.setattr("aura_agent.tools.packages.IS_WINDOWS", False)
    monkeypatch.setattr("aura_agent.tools.packages.IS_MACOS", False)
    monkeypatch.setattr("aura_agent.tools.packages._exec", fake_exec)
    monkeypatch.setattr("aura_agent.tools.packages._available_managers", lambda: ["flatpak"])
    found = await search_software("protonvpn")
    assert found["count"] == 1
    assert found["packages"][0]["id"] == "com.protonvpn.www"

    inst = await install_software("com.protonvpn.www", manager="flatpak")
    assert inst["ok"] is True
    assert "com.protonvpn.www" in inst["verified"]

    class _FakeResp:
        status_code = 200

        def json(self) -> dict[str, Any]:
            return {
                "ip": "185.199.108.15",
                "country": "Spain",
                "country_code": "ES",
                "city": "Madrid",
                "region": "Madrid",
                "connection": {"isp": "Proton AG"},
            }

    class _FakeClient:
        def __init__(self, **kw: Any) -> None:
            pass

        async def __aenter__(self) -> _FakeClient:
            return self

        async def __aexit__(self, *args: Any) -> None:
            pass

        async def get(self, url: str) -> _FakeResp:
            return _FakeResp()

    monkeypatch.setattr("aura_agent.tools.packages.httpx.AsyncClient", _FakeClient)
    net = await network_status()
    assert net["vpn_active"] is True
    assert any("wg-spain0" in x for x in net["vpn_interfaces"])
    assert net["country"] == "Spain"
    assert net["country_code"] == "ES"
    assert net["city"] == "Madrid"

    # Also verify Windows branch (winget + Get-NetAdapter)
    monkeypatch.setattr("aura_agent.tools.packages.IS_WINDOWS", True)
    monkeypatch.setattr("aura_agent.tools.packages._available_managers", lambda: ["winget"])
    win_found = await search_software("protonvpn")
    assert win_found["count"] == 1
    assert win_found["packages"][0]["id"] == "Proton.ProtonVPN"
    win_net = await network_status()
    assert win_net["vpn_active"] is True
    assert "ProtonVPN TUN" in win_net["vpn_interfaces"]


async def test_background_process_lifecycle(tmp_path: Path) -> None:
    assert _bg_start_tier({"command": "cat ~/.ssh/id_rsa"})[0] == Tier.T3
    assert _bg_start_tier({"command": "python3 -c 'print(1)'"})[0] == Tier.T2

    host = _DummyHost()
    token = CURRENT.set(
        TaskContext(
            task_id="t-bg", chat_id="c-bg", host=host, audit=AuditLog(tmp_path / "audit"), home=str(tmp_path)
        )
    )
    try:
        started = await start_background_process(
            "python3 -u -c \"import sys; print('READY'); line = sys.stdin.readline().strip(); print('ECHO:' + line)\"",
            cwd=str(tmp_path),
            wait_ms=400,
        )
        pid = started["process_id"]
        assert "READY" in started["output"]

        listed = await manage_background_process("list")
        assert any(p["process_id"] == pid for p in listed["processes"])

        sent = await manage_background_process("send_input", process_id=pid, input_text="HOLA_MADRID")
        assert sent["ok"] is True
        assert "ECHO:HOLA_MADRID" in sent["output"]

        stopped = await manage_background_process("stop", process_id=pid)
        assert stopped["status"] == "stopped"
    finally:
        CURRENT.reset(token)


async def test_subagents_and_auto_approve_mode(tmp_path: Path) -> None:
    llm = ScriptedLlm(["Gefunden: com.protonvpn.www unterstützt kostenlose Server.", "Erledigt."])
    define_subagent, invoke_subagent = make_subagent_tools(llm)

    defined = define_subagent(
        name="vpn_spain_expert",
        description="Spezialist für spanische VPN-Verbindungen",
        system_prompt="Suche und prüfe VPN-Verbindungen nach Spanien.",
        enable_write_tools=False,
    )
    assert defined["ok"] is True
    assert "vpn_spain_expert" in defined["available_subagents"]

    res = await invoke_subagent(
        subagent_type="vpn_spain_expert",
        role="VPN Spain Researcher",
        prompt="Prüfe passende VPN-Pakete.",
    )
    assert "com.protonvpn.www" in res["result"]

    # Verify auto_approve=True runs T2 without prompting host.approve, while still blocking T3!
    settings = AgentSettings(
        data_dir=tmp_path / "agent",
        aura_dir=tmp_path / "aura",
        home=str(tmp_path),
        auto_approve=True,
        browser=False,
        apps=False,
    )
    script = ScriptedLlm(
        [
            [Call("write_file", {"path": "~/spain_vpn_note.txt", "content": "Connected to Madrid"})],
            [Call("read_file", {"path": "~/.ssh/id_rsa"})],
            "Notiz gespeichert, SSH-Schlüssel wurde wie erwartet gesperrt.",
        ]
    )
    host = _DummyHost()
    audit = AuditLog(settings.data_dir / "audit")
    ctl = TaskController(
        build_runner(settings, script, browser=False),
        host,
        audit,
        settings.home,
    )
    ctl.start("t-auto", "c-auto", "Speichere die VPN-Notiz")
    import asyncio

    await asyncio.gather(*[t for t, _ in ctl.tasks.values()])
    assert (tmp_path / "spain_vpn_note.txt").read_text(encoding="utf-8") == "Connected to Madrid"
    assert host.approvals == []  # T2 write_file was auto-approved without prompting!
    audit_files = list(audit.dir.glob("*.jsonl"))
    assert audit_files and '"kind": "blocked"' in audit_files[0].read_text(encoding="utf-8")
    assert isinstance(list_apps()["apps"], list)
    assert GuardPlugin(PolicyEngine(), auto_approve=True).auto_approve is True
