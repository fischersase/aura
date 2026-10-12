"""Programme und Fenster in einem unsichtbaren Xvfb-Bildschirm."""

import asyncio
import sys
import textwrap
from pathlib import Path

import pytest

import aura_agent.testing
from aura_agent.tools import desktop

TESTWIN = Path(aura_agent.testing.__file__).with_name("testwin.py")


@pytest.fixture
def test_app(tmp_path, monkeypatch, xvfb):
  apps = tmp_path / "share" / "applications"
  apps.mkdir(parents=True)
  (apps / "aura-testwin.desktop").write_text(textwrap.dedent(f"""\
      [Desktop Entry]
      Type=Application
      Name=Aura Testfenster
      Exec={sys.executable} {TESTWIN}
      StartupWMClass=AuraTestwin
      """))
  monkeypatch.setenv("XDG_DATA_DIRS", str(tmp_path / "share"))
  monkeypatch.setattr(desktop, "LAUNCH_WAIT_S", 8.0)
  yield
  # nur die Testfenster dieses Bildschirms beenden
  from evals.desktop.env import _kill_testwins
  _kill_testwins(xvfb)


async def test_launch_app_waits_for_window_and_verifies(test_app):
  r = await desktop.launch_app("Aura Testfenster")
  assert r["verified"] is True, r
  assert r["window"]["app"] == "AuraTestwin"
  windows = (await desktop.list_windows())["windows"]
  assert any(w["app"] == "AuraTestwin" for w in windows)


async def test_launch_running_app_focuses_existing_window(test_app):
  first = await desktop.launch_app("Aura Testfenster")
  again = await desktop.launch_app("Aura Testfenster")
  assert again.get("already_running") is True and again["window"]["id"] == first["window"]["id"]


async def test_unknown_app_suggests_names(test_app):
  r = await desktop.launch_app("Aura Testfenstr")
  assert "Kein installiertes Programm" in r["error"] and "aura testfenster" in r["meintest_du"]


async def test_close_window_is_verified(test_app):
  r = await desktop.launch_app("Aura Testfenster")
  closed = await desktop.window_action(r["window"]["id"], "close")
  assert closed["verified"] is True
  await asyncio.sleep(0.2)
  assert not any(w["app"] == "AuraTestwin" for w in (await desktop.list_windows())["windows"])


async def test_window_by_name_and_ambiguity(test_app):
  await desktop.launch_app("Aura Testfenster")
  assert (await desktop.window_action("Testfenster", "focus"))["verified"] is True
  assert "Kein Fenster" in (await desktop.window_action("gibtsnicht", "focus"))["error"]
  assert "action muss" in (await desktop.window_action("Testfenster", "explode"))["error"]


def test_tiers():
  assert desktop._window_tier({"action": "close"})[0] == 2
  assert desktop._window_tier({"action": "focus"})[0] == 1
  assert desktop._open_tier({"target": "https://music.youtube.com"})[0] == 1
