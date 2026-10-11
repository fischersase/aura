import os
import shutil
import subprocess

import pytest


@pytest.fixture
def private_dbus(monkeypatch):
  """Eigener Session-Bus, damit Tests nie den echten Desktop (Musik, Einstellungen) berühren."""
  if not shutil.which("dbus-daemon"):
    pytest.skip("dbus-daemon fehlt")
  proc = subprocess.Popen(["dbus-daemon", "--session", "--nofork", "--print-address=1"], stdout=subprocess.PIPE, text=True)
  address = proc.stdout.readline().strip()
  monkeypatch.setenv("DBUS_SESSION_BUS_ADDRESS", address)
  yield address
  proc.terminate()
  proc.wait(timeout=5)


@pytest.fixture
def no_display(monkeypatch):
  monkeypatch.delenv("DISPLAY", raising=False)


@pytest.fixture
def fake_home(tmp_path, monkeypatch):
  """Temporärer Benutzerordner: Datei-Werkzeuge und gio arbeiten nie im echten ~."""
  home = tmp_path / "home"
  (home / ".local/share").mkdir(parents=True)
  monkeypatch.setenv("HOME", str(home))
  monkeypatch.setenv("XDG_DATA_HOME", str(home / ".local/share"))
  return home


@pytest.fixture
def xvfb(monkeypatch):
  """Unsichtbarer X-Bildschirm ohne Fenstermanager (wie in der CI)."""
  if not shutil.which("Xvfb"):
    pytest.skip("Xvfb fehlt")
  r, w = os.pipe()
  proc = subprocess.Popen(["Xvfb", "-displayfd", str(w), "-screen", "0", "1280x800x24", "-nolisten", "tcp"], pass_fds=(w,),
                          stderr=subprocess.DEVNULL)
  os.close(w)
  with os.fdopen(r) as f:
    num = f.readline().strip()
  monkeypatch.setenv("DISPLAY", f":{num}")
  monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
  yield f":{num}"
  proc.terminate()
  proc.wait(timeout=5)
