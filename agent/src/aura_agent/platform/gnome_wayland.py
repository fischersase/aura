"""Fenster unter GNOME Wayland über die Erweiterung aura-bridge@aura (gnome-extension/ im Repo).

Unter Wayland sieht kein Programm fremde Fenster; die Erweiterung läuft in GNOME Shell und bietet über
den Session-D-Bus genau Liste, Fokus, Minimieren, Maximieren und Schließen an.
"""

from __future__ import annotations

import json
import os

from dbus_fast import BusType, Message, MessageType
from dbus_fast.aio import MessageBus

from .base import WindowInfo

NAME = "org.aura.Bridge"
PATH = "/org/aura/Bridge"
IFACE = "org.aura.Bridge"


def is_wayland() -> bool:
  return os.environ.get("XDG_SESSION_TYPE") == "wayland" or (bool(os.environ.get("WAYLAND_DISPLAY")) and not os.environ.get("DISPLAY"))


async def _call(member: str, sig: str = "", body: list | None = None):
  bus = await MessageBus(bus_type=BusType.SESSION).connect()
  try:
    reply = await bus.call(Message(destination=NAME, path=PATH, interface=IFACE, member=member, signature=sig, body=body or []))
  finally:
    bus.disconnect()
  if reply is None or reply.message_type == MessageType.ERROR:
    raise RuntimeError(str(reply.body[0]) if reply and reply.body else f"{member} fehlgeschlagen")
  return reply.body[0]


async def available() -> bool:
  try:
    await _call("ListWindows")
    return True
  except Exception:  # noqa: BLE001 - nicht installiert oder nicht aktiviert
    return False


async def windows() -> list[WindowInfo]:
  items = json.loads(await _call("ListWindows"))
  return [WindowInfo(id=f"w{w['id']}", title=w.get("title", ""), app=w.get("app", ""), instance=w.get("instance", ""),
                     pid=w.get("pid"), desktop=None, active=bool(w.get("active")), minimized=bool(w.get("minimized")))
          for w in items]


async def act(window_id: str, action: str) -> bool:
  member = {"focus": "Activate", "minimize": "Minimize", "maximize": "Maximize", "close": "Close"}[action]
  return bool(await _call(member, "t", [int(window_id.lstrip("w"))]))


NOT_INSTALLED = ("Unter Wayland braucht Aura für Fenster die GNOME-Erweiterung „Aura Bridge“. "
                 "Aura Zentrale → Systemprüfung → „Erweiterung installieren“, danach einmal ab- und anmelden.")
