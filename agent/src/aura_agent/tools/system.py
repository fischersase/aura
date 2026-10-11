"""Systeminfos und Medienstatus (T0). Mediensteuerung mit Nachprüfung kommt in Phase 2."""

from __future__ import annotations

import os
import platform
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

from dbus_fast import BusType, Message, MessageType, Variant
from dbus_fast.aio import MessageBus

from ..harness.tiers import Tier, aura_tool

MPRIS_PREFIX = "org.mpris.MediaPlayer2."
MPRIS_PATH = "/org/mpris/MediaPlayer2"
PLAYER_IFACE = "org.mpris.MediaPlayer2.Player"


def _meminfo() -> dict[str, int]:
  out = {}
  try:
    for line in Path("/proc/meminfo").read_text().splitlines():
      key, val = line.split(":", 1)
      out[key] = int(val.strip().split()[0]) // 1024
  except (OSError, ValueError):
    pass
  return out


def _battery() -> dict[str, Any] | None:
  for bat in sorted(Path("/sys/class/power_supply").glob("BAT*")):
    try:
      return {"percent": int((bat / "capacity").read_text()), "status": (bat / "status").read_text().strip()}
    except (OSError, ValueError):
      continue
  return None


@aura_tool(Tier.T0, label=lambda a: "Systeminfo")
def system_info() -> dict[str, Any]:
  """Systeminfos: Betriebssystem, Rechnername, CPU, Arbeitsspeicher, freier Speicherplatz, Akku, Uhrzeit."""
  mem = _meminfo()
  disk = shutil.disk_usage(str(Path.home()))
  os_name = platform.platform()
  try:
    for line in Path("/etc/os-release").read_text().splitlines():
      if line.startswith("PRETTY_NAME="):
        os_name = line.split("=", 1)[1].strip('"')
  except OSError:
    pass
  return {
      "os": os_name,
      "kernel": platform.release(),
      "host": platform.node(),
      "cpu_cores": os.cpu_count(),
      "load": [round(x, 2) for x in os.getloadavg()],
      "memory_mb": {"total": mem.get("MemTotal"), "available": mem.get("MemAvailable")},
      "disk_home_gb": {"total": round(disk.total / 1e9), "free": round(disk.free / 1e9)},
      "battery": _battery(),
      "session": os.environ.get("XDG_SESSION_TYPE", ""),
      "desktop": os.environ.get("XDG_CURRENT_DESKTOP", ""),
      "now": now_text(),
  }


WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"]


def now_text() -> str:
  now = datetime.now().astimezone()
  return f"{WEEKDAYS[now.weekday()]}, {now:%d.%m.%Y %H:%M} ({now.tzname()})"


def _unwrap(v: Any) -> Any:
  if isinstance(v, Variant):
    return _unwrap(v.value)
  if isinstance(v, dict):
    return {k: _unwrap(x) for k, x in v.items()}
  if isinstance(v, list):
    return [_unwrap(x) for x in v]
  return v


async def _call(bus: MessageBus, dest: str, iface: str, member: str, sig: str = "", body: list | None = None) -> Any:
  reply = await bus.call(Message(destination=dest, path=MPRIS_PATH, interface=iface, member=member, signature=sig, body=body or []))
  if reply is None or reply.message_type == MessageType.ERROR:
    raise RuntimeError(reply.body[0] if reply and reply.body else f"{member} fehlgeschlagen")
  return reply.body


async def mpris_players(bus: MessageBus) -> list[str]:
  names = (await bus.call(Message(destination="org.freedesktop.DBus", path="/org/freedesktop/DBus",
                                  interface="org.freedesktop.DBus", member="ListNames"))).body[0]
  return sorted(n for n in names if n.startswith(MPRIS_PREFIX))


async def player_state(bus: MessageBus, name: str) -> dict[str, Any]:
  props = _unwrap((await _call(bus, name, "org.freedesktop.DBus.Properties", "GetAll", "s", [PLAYER_IFACE]))[0])
  meta = props.get("Metadata") or {}
  artists = meta.get("xesam:artist") or []
  return {
      "player": name.removeprefix(MPRIS_PREFIX).split(".instance")[0],
      "bus_name": name,
      "status": props.get("PlaybackStatus"),
      "title": meta.get("xesam:title"),
      "artist": ", ".join(artists) if isinstance(artists, list) else artists,
      "album": meta.get("xesam:album"),
      "url": meta.get("xesam:url"),
      "volume": props.get("Volume"),
      "can": {"play": props.get("CanPlay"), "pause": props.get("CanPause"), "next": props.get("CanGoNext"), "previous": props.get("CanGoPrevious")},
  }


@aura_tool(Tier.T0, label=lambda a: "Medienwiedergabe")
async def media_status() -> dict[str, Any]:
  """Zeigt, was gerade abgespielt wird: Player (z. B. Chrome mit YouTube Music, Spotify), Titel, Künstler, Status (Playing/Paused)."""
  bus = await MessageBus(bus_type=BusType.SESSION).connect()
  try:
    players = []
    for name in await mpris_players(bus):
      try:
        players.append(await player_state(bus, name))
      except Exception as e:  # noqa: BLE001 - ein hängender Player darf die Liste nicht verhindern
        players.append({"bus_name": name, "error": str(e)})
    if not players:
      return {"players": [], "note": "Kein Medienplayer gefunden. Es läuft gerade nichts, das sich über MPRIS meldet."}
    return {"players": players}
  finally:
    bus.disconnect()
