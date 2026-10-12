"""Windows-Backend gegen echte Fenster, Startmenü, UI Automation, PowerShell, Papierkorb und Registry.

Läuft nur unter Windows (CI: windows-latest). Gegenstück zu den Linux-Vertragstests in tests/contract/.
"""

import asyncio
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from aura_agent.harness.tiers import Tier
from aura_agent.policy.shell_classifier import classify

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="nur unter Windows")


def by_name(snapshot, name):
  return next(e for e in snapshot["elements"] if e["name"] == name)


async def test_list_focus_minimize_and_close_window(win_app):
  from aura_agent.tools import desktop

  _, title = win_app
  wins = (await desktop.list_windows())["windows"]
  mine = next(w for w in wins if w["title"] == title)
  assert mine["id"].startswith("0x") and mine["app"].startswith("python")
  r = await desktop.window_action(mine["id"], "minimize")
  assert r["verified"] is True, r
  r = await desktop.window_action(title, "focus")
  assert r["verified"] is True, r
  r = await desktop.window_action(mine["id"], "close")
  assert r["verified"] is True, r


async def test_launch_app_from_start_menu_shortcut(monkeypatch):
  from aura_agent.platform import win_apps
  from aura_agent.tools import desktop

  from ..conftest import WIN_APP, _pythonw

  name = f"Aura Startmenütest {os.getpid()}"
  folder = Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Start Menu" / "Programs"
  lnk = folder / f"{name}.lnk"
  ps = (f"$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{lnk}'); $s.TargetPath='{_pythonw()}'; "
        f"$s.Arguments='\"{WIN_APP}\" \"{name}\"'; $s.Save()")
  subprocess.run(["powershell.exe", "-NoProfile", "-Command", ps], check=True)  # noqa: ASYNC221 - Testvorbereitung
  monkeypatch.setattr(win_apps, "_cache", None)
  try:
    r = await desktop.launch_app(name)
    assert r["verified"] is True, r
    assert r["window"]["title"] == name
    again = await desktop.launch_app(name)
    assert again.get("already_running") is True, again
    closed = await desktop.window_action(r["window"]["id"], "close")
    assert closed["verified"] is True
  finally:
    lnk.unlink(missing_ok=True)


async def test_ui_automation_snapshot_set_text_and_click(win_app):
  from aura_agent.tools import ui

  _, title = win_app
  apps = await ui.ui_snapshot()
  assert any(title in w for a in apps["apps"] for w in a["windows"]), apps
  snap = await ui.ui_snapshot(title)
  field = next(e for e in snap["elements"] if e["role"] == "entry")
  r = await ui.ui_set_text(field["index"], "Notizfeld", "Hallo Welt")
  assert r["verified"] is True, r
  r = await ui.ui_act(by_name(snap, "Speichern")["index"], "Knopf Speichern")
  assert r["verified"] is True, r
  after = await ui.ui_snapshot(title)
  assert any(e["name"] == "Gespeichert: Hallo Welt" for e in after["elements"]), after


async def test_ui_consequential_button_needs_honest_description(win_app):
  from aura_agent.tools import ui

  _, title = win_app
  snap = await ui.ui_snapshot(title)
  delete = by_name(snap, "Konto löschen")
  r = await ui.ui_act(delete["index"], "Knopf unten")
  assert "heißt „Konto löschen“" in r["error"]
  after = await ui.ui_snapshot(title)
  assert not any(e["name"] == "GELÖSCHT" for e in after["elements"])
  assert ui.ui_act.__aura__.classify({"index": delete["index"], "element": "Knopf Konto löschen"})[0] == Tier.T2


async def test_powershell_runs_reads_and_keeps_umlauts(tmp_path):
  from aura_agent.tools.shell import run_command

  assert classify("Get-ChildItem")[0] == Tier.T0 and classify("Remove-Item x")[0] == Tier.T2
  (tmp_path / "größe.txt").write_text("x")
  r = await run_command(f"Get-ChildItem '{tmp_path}' | Select-Object -ExpandProperty Name")
  assert r["exit_code"] == 0 and "größe.txt" in r["output"], r


async def test_powershell_timeout_kills_process_tree():
  from aura_agent.tools.shell import run_command

  start = time.monotonic()
  r = await run_command("Start-Process -NoNewWindow -FilePath ping -ArgumentList '-n','60','127.0.0.1'; Start-Sleep 60", timeout_s=5)
  assert "abgebrochen" in r["error"] and time.monotonic() - start < 20


async def test_trash_uses_recycle_bin(tmp_path, monkeypatch):
  from aura_agent.tools import files

  monkeypatch.setenv("USERPROFILE", str(tmp_path))
  d = tmp_path / "alt"
  d.mkdir()
  (d / "x.txt").write_text("x")
  r = await files.trash(str(d))
  assert r["verified"] is True and not d.exists(), r


async def test_dark_mode_and_registry_settings():
  from aura_agent.platform import win_registry as reg
  from aura_agent.tools import win_settings

  before = reg.read(win_settings.PERSONALIZE, "AppsUseLightTheme")
  try:
    assert (await win_settings.dark_mode(True))["verified"] is True
    assert (await win_settings.dark_mode(False))["verified"] is True
  finally:
    if before is not None:
      reg.write(win_settings.PERSONALIZE, "AppsUseLightTheme", str(before[0]))
  key = r"HKCU\Software\AuraTest"
  try:
    r = await win_settings.settings(key, "Zahl", "5")
    assert r["verified"] is True and r["after"] == 5, r
    assert (await win_settings.settings(key, "Zahl"))["value"] == 5
  finally:
    subprocess.run(["reg", "delete", key, "/f"], capture_output=True, check=False)  # noqa: ASYNC221 - Aufräumen


async def test_media_volume_and_system_info_do_not_crash():
  from aura_agent.tools import system

  media = await system.media_status()
  assert isinstance(media["players"], list)
  vol = await system.volume()
  assert "percent" in vol or "error" in vol
  info = system.system_info()
  assert "Windows" in info["os"] and info["memory_mb"]["total"] > 0


def test_installed_apps_lists_start_menu():
  from aura_agent.tools.apps import installed_apps

  apps = installed_apps()
  assert len(apps) > 5 and all(a.name for a in apps)


async def test_full_agent_selftest_runs_on_windows():
  proc = await asyncio.create_subprocess_exec(sys.executable, "-I", "-m", "aura_agent", "--selftest",
                                              stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
  out, _ = await proc.communicate()
  assert proc.returncode == 0, out.decode(errors="replace")
