"""Abgeschottete Umgebung für Desktop-Evals.

Jede Aufgabe bekommt einen frischen Benutzerordner, einen eigenen Session-D-Bus,
eigene gsettings (keyfile) und nachgebaute Programme (Testfenster mit echten
App-IDs, die die echten Programme überdecken). Alles läuft in einem unsichtbaren
Xvfb-Bildschirm. Der echte Desktop, echte Dateien, echte Musik und die echte
Lautstärke werden nie berührt.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import textwrap
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import aura_agent.testing
from aura_agent.platform import atspi, x11
from aura_agent.testing.fake_mpris import start_player

TESTWIN = Path(aura_agent.testing.__file__).with_name("testwin.py")
GTK_APP = Path(aura_agent.testing.__file__).with_name("gtk_app.py")

# Nachgebaute Programme: .desktop-ID wie das echte Programm, damit es überdeckt wird.
FAKE_APPS = {
    "org.gnome.Calculator": ("Calculator", "Rechner", "Gnome-calculator"),
    "antigravity-ide": ("Antigravity IDE", "Antigravity", "Antigravity"),
    "org.gnome.TextEditor": ("Text Editor", "Texteditor", "Gnome-text-editor"),
    "firefox_firefox": ("Firefox", "Mozilla Firefox", "firefox"),
    # Installed Chrome web app (AURA-92): its content cannot be read, the agent has to say so.
    "chrome-fmgjjmmmlfnkbppncabfkddbjimcfncm-Default": (
        "Gmail",
        "Gmail",
        "crx_fmgjjmmmlfnkbppncabfkddbjimcfncm",
    ),
}


@dataclass
class Display:
    proc: subprocess.Popen
    name: str

    @classmethod
    def start(cls) -> Display:
        r, w = os.pipe()
        proc = subprocess.Popen(
            ["Xvfb", "-displayfd", str(w), "-screen", "0", "1280x800x24", "-nolisten", "tcp"],
            pass_fds=(w,),
            stderr=subprocess.DEVNULL,
        )
        os.close(w)
        with os.fdopen(r) as f:
            return cls(proc, ":" + f.readline().strip())

    def stop(self) -> None:
        self.proc.terminate()
        self.proc.wait(timeout=5)


@dataclass
class EvalEnv:
    root: Path
    display: str
    home: Path = field(init=False)
    bus_proc: subprocess.Popen | None = None
    player_bus: Any = None
    player: Any = None
    saved_env: dict[str, str | None] = field(default_factory=dict)
    extra_procs: list[subprocess.Popen] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.home = self.root / "home"

    async def setup(
        self,
        files: dict[str, str] | None = None,
        player: dict[str, Any] | None = None,
        windows: list[str] | None = None,
        gtk: bool = False,
    ) -> None:
        for d in ("Dokumente", "Downloads", "Bilder", "Musik", ".local/share", ".config", ".cache"):
            (self.home / d).mkdir(parents=True, exist_ok=True)
        share = self.root / "share" / "applications"
        share.mkdir(parents=True, exist_ok=True)
        for app_id, (name, title, cls) in FAKE_APPS.items():
            (share / f"{app_id}.desktop").write_text(
                textwrap.dedent(f"""\
          [Desktop Entry]
          Type=Application
          Name={name}
          Exec={sys.executable} {TESTWIN} "{title}" {cls}
          StartupWMClass={cls}
          """)
            )
        for rel, content in (files or {}).items():
            p = self.home / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
        bus = subprocess.Popen(  # noqa: ASYNC220
            ["dbus-daemon", "--session", "--nofork", "--print-address=1"], stdout=subprocess.PIPE, text=True
        )
        self.bus_proc = bus
        address = bus.stdout.readline().strip() if bus.stdout else ""
        env = {
            "HOME": str(self.home),
            "XDG_DATA_HOME": str(self.home / ".local/share"),
            "XDG_CONFIG_HOME": str(self.home / ".config"),
            "XDG_CACHE_HOME": str(self.home / ".cache"),
            "XDG_DATA_DIRS": f"{self.root / 'share'}:/usr/local/share:/usr/share",
            "GSETTINGS_BACKEND": "keyfile",
            "DBUS_SESSION_BUS_ADDRESS": address,
            "DISPLAY": self.display,
            "PULSE_SERVER": "unix:/nonexistent",
            "XDG_SESSION_TYPE": "x11",
            "WAYLAND_DISPLAY": None,
        }
        for k, v in env.items():
            self.saved_env[k] = os.environ.get(k)
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        if player is not None:
            self.player_bus, self.player = await start_player(**player)
        atspi.CLIENT.kill()  # der Helfer soll den D-Bus dieser Umgebung nutzen
        if gtk:
            import asyncio

            self.extra_procs.append(
                subprocess.Popen(  # noqa: ASYNC220
                    ["/usr/libexec/at-spi-bus-launcher", "--launch-immediately"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            )
            await asyncio.sleep(0.7)
            self.extra_procs.append(
                subprocess.Popen(  # noqa: ASYNC220
                    [atspi.SYSTEM_PYTHON, str(GTK_APP)],
                    env={**os.environ, "AURA_TEST_STATE": str(self.gtk_state)},
                    stderr=subprocess.DEVNULL,
                )
            )
            await asyncio.sleep(1.5)
        for app_id in windows or []:
            name, title, cls = FAKE_APPS[app_id]
            subprocess.Popen([sys.executable, str(TESTWIN), title, cls], start_new_session=True)  # noqa: ASYNC220
        if windows:
            import asyncio

            for _ in range(50):
                if len(self.windows()) >= len(windows):
                    break
                await asyncio.sleep(0.1)

    def windows(self) -> list[x11.WindowInfo]:
        with x11.X11() as x:
            return x.windows()

    @property
    def gtk_state(self) -> Path:
        return self.root / "gtk-state.txt"

    def teardown(self) -> None:
        atspi.CLIENT.kill()
        for p in self.extra_procs:
            p.terminate()
            p.wait(timeout=5)
        _kill_testwins(self.display)
        if self.player_bus:
            self.player_bus.disconnect()
        if self.bus_proc:
            self.bus_proc.terminate()
            self.bus_proc.wait(timeout=5)
        for k, v in self.saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.root, ignore_errors=True)


def _kill_testwins(display: str) -> None:
    """Beendet nur Testfenster auf diesem Xvfb-Bildschirm (andere Läufe und Tests bleiben unberührt)."""
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            cmd = (proc / "cmdline").read_bytes()
            if str(TESTWIN).encode() not in cmd:
                continue
            env = (proc / "environ").read_bytes().split(b"\0")
            if f"DISPLAY={display}".encode() in env:
                os.kill(int(proc.name), 9)
        except (OSError, ProcessLookupError):
            continue
