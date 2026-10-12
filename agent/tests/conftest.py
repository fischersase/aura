import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

WINDOWS = sys.platform == "win32"

# Linux-Backends (D-Bus, X11, GNOME): unter Windows gar nicht erst sammeln, ihre Pakete fehlen dort.
# Das Windows-Gegenstück steht in tests/windows/.
collect_ignore = ["contract/test_media.py", "contract/test_desktop.py", "wayland"] if WINDOWS else []


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
  monkeypatch.setenv("USERPROFILE", str(home))  # Windows: Path.home()
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


@pytest.fixture
def gtk_app(xvfb, private_dbus):
  """GTK-Testprogramm mit eigenem AT-SPI-Bus (im Xvfb, auf dem eigenen D-Bus)."""
  import time

  from aura_agent.platform import atspi

  launcher = "/usr/libexec/at-spi-bus-launcher"
  if not os.path.exists(launcher) or subprocess.run(
      [atspi.SYSTEM_PYTHON, "-c", "import gi; gi.require_version('Gtk','3.0'); gi.require_version('Atspi','2.0')"],
      capture_output=True, check=False).returncode:
    pytest.skip("AT-SPI oder GTK 3 fehlen (at-spi2-core, python3-gi, gir1.2-gtk-3.0, gir1.2-atspi-2.0)")
  atspi.CLIENT.kill()
  bus = subprocess.Popen([launcher, "--launch-immediately"], stderr=subprocess.DEVNULL)
  time.sleep(0.7)
  app_file = os.path.join(os.path.dirname(atspi.__file__), "..", "testing", "gtk_app.py")
  app = subprocess.Popen([atspi.SYSTEM_PYTHON, app_file], stderr=subprocess.DEVNULL)
  # Warten, bis sich das Programm bei der Barrierefreiheit gemeldet hat (auf CI-Runnern deutlich langsamer).
  helper = os.path.join(os.path.dirname(atspi.__file__), "atspi_helper.py")
  for _ in range(30):
    out = subprocess.run([atspi.SYSTEM_PYTHON, helper], input='{"id":1,"method":"apps"}\n', capture_output=True, text=True, timeout=10,
                         check=False).stdout
    if "gtk_app.py" in out:
      break
    time.sleep(0.5)
  else:
    pytest.fail("GTK-Testprogramm meldet sich nicht über AT-SPI")
  yield app
  atspi.CLIENT.kill()
  for p in (app, bus):
    p.terminate()
    p.wait(timeout=5)


def _pythonw() -> str:
  exe = Path(sys.executable)
  w = exe.with_name("pythonw.exe")
  return str(w if w.exists() else exe)


WIN_APP = Path(__file__).parent.parent / "src" / "aura_agent" / "testing" / "win_app.py"


@pytest.fixture
def win_app():
  """Win32-Testprogramm (Feld, Speichern, Konto löschen); liefert (Prozess, Fenstertitel)."""
  if not WINDOWS:
    pytest.skip("nur unter Windows")
  from aura_agent.platform import a11y, win32

  title = f"Aura Testprogramm {os.getpid()}"
  app = subprocess.Popen([_pythonw(), str(WIN_APP), title])
  for _ in range(40):
    if any(w.title == title for w in win32.windows()):
      break
    time.sleep(0.25)
  else:
    app.kill()
    pytest.fail("Testfenster erscheint nicht")
  yield app, title
  a11y.CLIENT.kill()
  app.kill()
  app.wait(timeout=5)
