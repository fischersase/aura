"""Tests für Säule 1–4: Geräte-Steuerung (Bluetooth, Helligkeit, Audio, WLAN, Modi),
Browser-Agent 2.0 (Cookie/Overlay-Dismisser, Vision/Scroll-Tools, Snapshot-Compacting),
Deep-Research (DDG-Lite, Reddit) und Computer-Use 2.0 (UI-Koordinaten- & Paste-Fallback).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest

from aura_agent.agents.root import ROOT_TOOL_NAMES, TOOLS
from aura_agent.agents.subagents import COMPUTER_TOOLS, READ_ONLY_TOOLS, SYSTEM_TOOLS
from aura_agent.harness.guard import compact_browser_snapshot
from aura_agent.harness.tiers import EXTERNAL, Tier, meta_of
from aura_agent.runtime.context import CURRENT, TaskContext
from aura_agent.tools import browser, device, ui, web

# ---------- Säule 1: Geräte- & Hardware-Kontrolle ----------


def test_device_tools_registered_in_root_and_subagents():
    names = {fn.__name__ for fn in TOOLS}
    for required in ("bluetooth", "brightness", "audio_device", "wifi", "device_mode", "reddit_search"):
        assert required in names
        assert required in ROOT_TOOL_NAMES
    assert web.reddit_search in READ_ONLY_TOOLS
    for dev_tool in (
        device.bluetooth,
        device.brightness,
        device.audio_device,
        device.wifi,
        device.device_mode,
    ):
        assert dev_tool in COMPUTER_TOOLS
        assert dev_tool in SYSTEM_TOOLS


def test_device_tool_tiers():
    assert meta_of(device.bluetooth).classify({"action": "list"})[0] == Tier.T0
    assert meta_of(device.bluetooth).classify({"action": "connect", "device": "Sony"})[0] == Tier.T1
    assert meta_of(device.bluetooth).classify({"action": "off"})[0] == Tier.T1

    assert meta_of(device.brightness).classify({})[0] == Tier.T0
    assert meta_of(device.brightness).classify({"level": 80})[0] == Tier.T1
    assert meta_of(device.brightness).classify({"delta": 20})[0] == Tier.T1

    assert meta_of(device.audio_device).classify({"action": "list"})[0] == Tier.T0
    assert meta_of(device.audio_device).classify({"action": "set", "device": "Sony"})[0] == Tier.T1

    assert meta_of(device.wifi).classify({"action": "status"})[0] == Tier.T0
    assert meta_of(device.wifi).classify({"action": "list"})[0] == Tier.T0
    assert meta_of(device.wifi).classify({"action": "connect", "network": "Home"})[0] == Tier.T1
    assert meta_of(device.wifi).classify({"action": "off"})[0] == Tier.T2
    assert meta_of(device.wifi).classify({"action": "disconnect"})[0] == Tier.T2

    assert meta_of(device.device_mode).classify({"feature": "dnd"})[0] == Tier.T0
    assert meta_of(device.device_mode).classify({"feature": "dnd", "on": True})[0] == Tier.T1
    assert meta_of(device.device_mode).classify({"feature": "night_light", "on": True})[0] == Tier.T1
    assert meta_of(device.device_mode).classify({"feature": "lock_screen"})[0] == Tier.T1
    assert meta_of(device.device_mode).classify({"feature": "sleep"})[0] == Tier.T2


def test_device_fuzzy_matching_and_bluetoothctl_parser():
    devs = [
        {"name": "Sony WH-1000XM5", "address": "AA:BB:CC:DD:EE:01"},
        {"name": "JBL Flip 6", "address": "AA:BB:CC:DD:EE:02"},
    ]
    assert device._match_device(devs, "sony", "name", "address") == devs[0]
    assert device._match_device(devs, "WH-1000", "name", "address") == devs[0]
    assert device._match_device(devs, "AA:BB:CC:DD:EE:02", "name", "address") == devs[1]
    assert device._match_device(devs, "AirPods", "name", "address") is None

    parsed = device._parse_bluetoothctl_devices(
        "Device AA:BB:CC:DD:EE:01 Sony WH-1000XM5\nDevice 11:22:33:44:55:66 AirPods Pro\n"
    )
    assert parsed == [
        {"address": "AA:BB:CC:DD:EE:01", "name": "Sony WH-1000XM5"},
        {"address": "11:22:33:44:55:66", "name": "AirPods Pro"},
    ]


# ---------- Säule 2: Browser-Agent 2.0 ----------


def test_cookie_and_popup_clicks_are_t1_while_purchases_stay_t2():
    click = EXTERNAL["browser_click"]
    # Harmlose Cookie- & Popup-Klicks dürfen keinen T2-Freigabedialog auslösen
    for benign in (
        'button "Alle akzeptieren"',
        'button "Accept all"',
        'button "Cookies akzeptieren"',
        'button "Zustimmen und weiter"',
        'button "Auswahl bestätigen"',
        'button "Confirm my choices"',
        'button "Alle ablehnen"',
        'button "Nur notwendige"',
        'button "Schließen"',
        'button "Nicht jetzt"',
    ):
        assert click.classify({"element": benign})[0] == Tier.T1, f"Expected T1 for {benign}"

    # Echte folgenreiche Aktionen müssen T2 bleiben
    for risky in (
        'button "Jetzt kaufen"',
        'button "Bestellung bestätigen"',
        'button "Kauf akzeptieren"',
        'button "Flug buchen"',
        'button "Konto löschen"',
        'button "Absenden"',
    ):
        assert click.classify({"element": risky})[0] == Tier.T2, f"Expected T2 for {risky}"

    # CAPTCHA bleibt T3
    assert click.classify({"element": 'checkbox "Ich bin kein Roboter"'})[0] == Tier.T3

    # Neue Vision/Scroll/Hover-Tools sind im Tool-Filter und in EXTERNAL
    for name in (
        "browser_hover",
        "browser_drag",
        "browser_mouse_wheel",
        "browser_mouse_click_xy",
        "browser_resize",
    ):
        assert name in browser.BROWSER_TOOLS
        assert name in EXTERNAL


def test_extract_find_buttons_and_safety():
    sample = """### Result
Found 3 matches:
- generic [ref=e1]:
  - dialog "Cookie-Einstellungen" [ref=e2]:
    - button "Alle ablehnen" [ref=e4]
    - button "Jetzt kaufen" [ref=e5]
    - button "Ich bin kein Roboter" [ref=e6]
"""
    hits = browser.extract_find_buttons(sample)
    assert hits == [("e4", "Alle ablehnen")]
    # Popup-Kontextprüfung greift bei generischen Seiten ohne dialog/banner
    plain_page = '### Result\nFound 1 match:\n- main [ref=e1]:\n  - button "Schließen" [ref=e9]\n'
    assert browser.extract_find_buttons(plain_page, require_overlay_context=True) == []
    assert browser.extract_find_buttons(sample, require_overlay_context=True) == [("e4", "Alle ablehnen")]


@dataclass
class _FakeTool:
    name: str
    handler: Any

    async def run_async(self, *, args: dict[str, Any], tool_context: Any = None) -> Any:
        return self.handler(args)


@dataclass
class _FakeToolset:
    tools: list[_FakeTool]

    async def get_tools(self) -> list[_FakeTool]:
        return self.tools


async def test_browser_dismiss_overlays_clicks_reject_and_respects_captcha():
    clicked: list[dict[str, Any]] = []
    dismissed = False

    def fake_find(args: dict[str, Any]) -> dict[str, Any]:
        nonlocal dismissed
        rx = args.get("regex", "")
        if "captcha" in rx:
            return {"content": [{"type": "text", "text": "No matches"}]}
        if not dismissed and "alle ablehnen" in rx:
            return {
                "content": [
                    {
                        "type": "text",
                        "text": 'Found 1 match:\n- dialog "Cookies" [ref=e2]:\n  - button "Alle ablehnen" [ref=e4]',
                    }
                ]
            }
        return {"content": [{"type": "text", "text": "No matches"}]}

    def fake_click(args: dict[str, Any]) -> dict[str, Any]:
        nonlocal dismissed
        clicked.append(args)
        dismissed = True
        return {"content": [{"type": "text", "text": "Clicked"}]}

    ts = _FakeToolset([_FakeTool("browser_find", fake_find), _FakeTool("browser_click", fake_click)])
    tool = browser.make_overlay_tools(ts)[0]  # type: ignore[arg-type]
    res = await tool(prefer="reject")
    assert res["ok"] is True
    assert res["dismissed"] == ["Alle ablehnen"]
    assert len(clicked) == 1 and clicked[0]["target"] == "e4"

    # Bei CAPTCHA darf nichts geklickt werden
    clicked.clear()
    ts_cap = _FakeToolset(
        [
            _FakeTool(
                "browser_find",
                lambda a: {
                    "content": [{"type": "text", "text": 'Found 1 match:\n- checkbox "reCAPTCHA" [ref=e9]'}]
                },
            ),
            _FakeTool("browser_click", fake_click),
        ]
    )
    tool_cap = browser.make_overlay_tools(ts_cap)[0]  # type: ignore[arg-type]
    res_cap = await tool_cap()
    assert res_cap.get("captcha_detected") is True
    assert clicked == []


def test_compact_browser_snapshot_preserves_dialogs_and_prices():
    noise = "\n".join(f'  - link "Menüpunkt {i}" [ref=m{i}]' for i in range(600))
    snap = (
        "### Page\n- Page URL: https://example.com/flights\n- Page Title: Flüge nach Tokio\n\n"
        "### Snapshot\n- document [ref=e0]:\n"
        f"{noise}\n"
        '  - dialog "Cookie-Hinweis" [ref=d1]:\n'
        '    - button "Alle ablehnen" [ref=d2]\n'
        '    - button "Alle akzeptieren" [ref=d3]\n'
        "  - main [ref=m0]:\n"
        '    - heading "Tokio (HND) ab 489 €" [ref=p1]\n'
        '    - button "Details anzeigen" [ref=p2]\n'
        f"{noise}\n"
    )
    assert len(snap) > 20000
    compacted = compact_browser_snapshot(snap, limit=18000)
    assert compacted is not None
    assert len(compacted) <= 18500
    assert 'dialog "Cookie-Hinweis"' in compacted
    assert 'button "Alle ablehnen" [ref=d2]' in compacted
    assert 'heading "Tokio (HND) ab 489 €"' in compacted


# ---------- Säule 3: Deep-Research (DDG Lite & Reddit) ----------


def test_ddg_lite_parser():
    html_doc = """
    <table>
      <tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.mydealz.de%2Fdeals%2Fjapan-flug">Japan Flüge ab 450€</a></td></tr>
      <tr><td class="result-snippet">Hin- und Rückflug nach Tokio im April inkl. Gepäck.</td></tr>
    </table>
    """
    p = web._DdgLiteParser()
    p.feed(html_doc)
    assert len(p.results) == 1
    assert p.results[0]["url"] == "https://www.mydealz.de/deals/japan-flug"
    assert "450€" in p.results[0]["title"]
    assert "Tokio" in p.results[0]["snippet"]


async def test_reddit_search_parses_json(monkeypatch: pytest.MonkeyPatch):
    payload = {
        "data": {
            "children": [
                {
                    "data": {
                        "title": "Cheap cherry blossom flights Europe to Tokyo via MXP/BUD",
                        "subreddit": "flights",
                        "score": 142,
                        "num_comments": 38,
                        "permalink": "/r/flights/comments/abc/japan_sakura/",
                        "selftext": "Try open-jaw MXP-NRT and KIX-FRA with Air China or ANA.",
                    }
                }
            ]
        }
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert "/r/flights/search.json" in str(request.url)
        return httpx.Response(200, json=payload)

    transport = httpx.MockTransport(handler)
    orig_client = httpx.AsyncClient

    def patched_client(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return orig_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched_client)
    res = await web.reddit_search("Japan cherry blossom", subreddit="flights")
    assert res["count"] == 1
    assert res["results"][0]["subreddit"] == "flights"
    assert res["results"][0]["score"] == 142
    assert "MXP-NRT" in res["results"][0]["snippet"]


# ---------- Säule 4: Computer-Use 2.0 (UI-Koordinaten- & Paste-Fallback) ----------


@dataclass
class _FakeHost:
    inputs: list[dict[str, Any]] = field(default_factory=list)

    async def input(self, req: dict[str, Any]) -> dict[str, Any]:
        self.inputs.append(req)
        return {"ok": True}

    def emit(self, _method: str, _params: dict[str, Any]) -> None:
        pass


async def test_ui_act_and_set_text_coordinate_fallbacks(monkeypatch: pytest.MonkeyPatch, tmp_path: Any):
    class _FakeA11y:
        async def call(self, method: str, **params: Any) -> dict[str, Any]:
            if method == "act":
                return {"done": False, "error": "Element kann click nicht."}
            if method == "set_text":
                return {"error": "Element ist kein beschreibbares Textfeld."}
            if method == "read":
                return {"text": "Hallo Tokio"}
            return {}

    monkeypatch.setattr(ui.a11y, "available", lambda: True)
    monkeypatch.setattr(ui.a11y, "CLIENT", _FakeA11y())

    host = _FakeHost()
    ctx = TaskContext(task_id="t1", chat_id="c1", host=host, audit=None, home=str(tmp_path))  # type: ignore[arg-type]
    ctx.ui_elements = {
        1: {"index": 1, "role": "push button", "name": "Verbinden", "box": [100, 200, 80, 40]},
        2: {"index": 2, "role": "entry", "name": "Suche", "box": [300, 100, 200, 30]},
    }
    tok = CURRENT.set(ctx)
    try:
        res_act = await ui.ui_act(1, "Knopf Verbinden")
        assert res_act["done"] is True
        assert res_act["action"] == "click_abs"
        assert res_act["at"] == [140, 220]
        assert host.inputs[0]["action"] == "click_abs"

        host.inputs.clear()
        res_txt = await ui.ui_set_text(2, "Suchfeld", "Hallo Tokio")
        assert res_txt["verified"] is True
        assert res_txt["fallback"] == "clipboard_paste"
        assert [i["action"] for i in host.inputs] == ["click_abs", "clipboard", "keys", "keys"]
    finally:
        CURRENT.reset(tok)
