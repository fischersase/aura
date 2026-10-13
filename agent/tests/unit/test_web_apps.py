"""Installed web apps (Gmail as a Chrome app …): honest answer instead of clicking around (AURA-92)."""

import pytest

from aura_agent.harness.audit import AuditLog
from aura_agent.harness.tiers import Tier
from aura_agent.runtime.context import CURRENT, TaskContext
from aura_agent.testing.fake_host import FakeHost
from aura_agent.tools import apps, desktop, ui
from aura_agent.tools.pointer import click_at, press_keys

GMAIL = """[Desktop Entry]
Version=1.0
Terminal=false
Type=Application
Name=Gmail
Exec=/opt/google/chrome/google-chrome --profile-directory=Default --app-id=fmgjjmmmlfnkbppncabfkddbjimcfncm
Icon=chrome-fmgjjmmmlfnkbppncabfkddbjimcfncm-Default
StartupWMClass=crx_fmgjjmmmlfnkbppncabfkddbjimcfncm
"""


@pytest.fixture
def task(tmp_path):
    ctx = TaskContext(
        task_id="t", chat_id="c", host=FakeHost(), audit=AuditLog(tmp_path / "a"), home=str(tmp_path)
    )
    token = CURRENT.set(ctx)
    yield ctx
    CURRENT.reset(token)


def _app(**kw):
    base = {"id": "x", "file": None, "name": "X", "names": "x", "exec": "", "wm_class": ""}
    return apps.App(**{**base, **kw})


def test_chrome_app_desktop_file_is_a_web_app(tmp_path, monkeypatch):
    d = tmp_path / "applications"
    d.mkdir()
    (d / "chrome-fmgjjmmmlfnkbppncabfkddbjimcfncm-Default.desktop").write_text(GMAIL)
    monkeypatch.setattr(apps, "app_dirs", lambda: [d])
    monkeypatch.setattr(apps, "IS_WINDOWS", False)
    [gmail] = [a for a in apps.installed_apps() if a.name == "Gmail"]
    assert gmail.is_web_app
    assert gmail.wm_class == "crx_fmgjjmmmlfnkbppncabfkddbjimcfncm"


def test_windows_web_app_entries():
    assert _app(entry={"app_id": "Chrome._crx_fmgjjmmmlfnkbppncabfkddbjimcfncm"}).is_web_app
    lnk = r"C:\Users\u\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Chrome Apps\Gmail.lnk"
    assert _app(id=lnk, entry={"lnk": lnk}).is_web_app
    assert not _app(id="firefox", exec="firefox %u").is_web_app
    assert not _app(entry={"app_id": r"C:\Program Files\Google\Chrome\Application\chrome.exe"}).is_web_app


def test_web_app_results_carry_the_note_and_mark_the_task(task):
    marked = desktop._web_app(_app(id="chrome-abc-Default", exec="google-chrome --app-id=abc"))
    assert marked["web_app"] is True
    assert "Verbindung" in marked["note"]
    assert task.web_content_unavailable
    assert desktop._web_app(_app(id="firefox")) == {}


def test_browser_window_without_page_content_is_detected():
    few = [{"index": i, "role": "push button", "name": "x"} for i in range(4)]
    many = [{"index": i, "role": "link", "name": "x"} for i in range(80)]
    assert ui.web_content_unavailable({"apps": ["Google-chrome"], "elements": few})
    assert ui.web_content_unavailable({"apps": ["msedge.exe"], "elements": []})
    assert not ui.web_content_unavailable({"apps": ["Google-chrome"], "elements": many})
    assert not ui.web_content_unavailable({"apps": ["gnome-text-editor"], "elements": few})
    assert not ui.web_content_unavailable({"error": "Kein Programm", "apps": ["Google-chrome"]})


async def test_ui_snapshot_reports_unreadable_web_app(task, monkeypatch):
    async def call(method, **params):
        return {
            "count": 3,
            "elements": [{"index": 0, "role": "push button", "name": "Schließen"}],
            "apps": ["Google-chrome"],
        }

    monkeypatch.setattr(ui, "_not_available", lambda: None)
    monkeypatch.setattr(ui.a11y.CLIENT, "call", call)
    r = await ui.ui_snapshot("Gmail")
    assert r["web_content_unavailable"] is True
    assert "Web-App" in r["error"]
    assert task.web_content_unavailable


def test_blind_clicks_and_keys_ask_after_an_unreadable_web_app(task):
    click = click_at.__aura__.classify
    keys = press_keys.__aura__.classify
    assert click({"x": 500, "y": 500, "element": "Posteingang"})[0] == Tier.T1
    assert keys({"keys": "tab"})[0] == Tier.T1
    task.web_content_unavailable = True
    tier, reason = click({"x": 500, "y": 500, "element": "Posteingang"})
    assert tier == Tier.T2
    assert "nicht lesbar" in reason
    assert keys({"keys": "tab"})[0] == Tier.T2
