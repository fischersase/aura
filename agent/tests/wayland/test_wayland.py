"""Fenster unter GNOME Wayland: echte, unsichtbare GNOME-Shell mit der Erweiterung aura-bridge.

Braucht gnome-shell (GNOME 45+); in der GitHub-CI gibt es das nicht, dort wird der Test übersprungen.
"""

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).parent


@pytest.mark.skipif(not shutil.which("gnome-shell"), reason="gnome-shell nicht installiert (z. B. CI)")
def test_window_tools_under_gnome_wayland():
  cmd = f"{sys.executable} {HERE / 'window_tools_check.py'}"
  r = subprocess.run(["env", "-i", f"HOME={Path.home()}", "PATH=/usr/bin:/bin", str(HERE / "headless_gnome.sh"), cmd],
                     capture_output=True, text=True, timeout=120, check=False)
  lines = {ln.split(" ", 1)[0]: ln for ln in r.stdout.splitlines() if ln and ln.split(" ", 1)[0].isupper()}
  assert "Aura GTK Test" in lines.get("LIST", ""), r.stdout + r.stderr[-2000:]
  for action in ("MINIMIZE", "FOCUS", "MAXIMIZE", "CLOSE"):
    assert lines.get(action, "").startswith(f"{action} True"), r.stdout
  assert lines.get("AFTER") == "AFTER 0"
