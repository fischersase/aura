"""Systeminfos und Medienstatus (T0). Mediensteuerung mit Nachprüfung kommt in Phase 2."""

from __future__ import annotations

import asyncio
import os
import platform
import re
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


# ---------- Medien steuern (MPRIS) ----------

MEDIA_ACTIONS = {"play": "Play", "pause": "Pause", "toggle": "PlayPause", "next": "Next", "previous": "Previous", "stop": "Stop"}


def _pick_player(states: list[dict[str, Any]], player: str) -> dict[str, Any] | None:
  if player:
    q = player.lower()
    hits = [s for s in states if q in (s.get("player") or "").lower() or q in (s.get("title") or "").lower()]
    return hits[0] if hits else None
  for status in ("Playing", "Paused"):
    hits = [s for s in states if s.get("status") == status]
    if hits:
      return hits[0]
  return states[0] if states else None


@aura_tool(Tier.T1, label=lambda a: f"{a.get('action', '')}{' ' + a['player'] if a.get('player') else ''}")
async def media_control(action: str, player: str = "") -> dict[str, Any]:
  """Steuert die Medienwiedergabe (Musik, Videos, z. B. YouTube Music in Chrome oder Spotify) und prüft das Ergebnis.

  Args:
    action: "play", "pause", "toggle", "next", "previous" oder "stop".
    player: Optional: welcher Player (z. B. "spotify", "chromium"). Standard: der gerade spielende.
  """
  method = MEDIA_ACTIONS.get(action)
  if not method:
    return {"error": f"Unbekannte Aktion „{action}“. Erlaubt: {', '.join(MEDIA_ACTIONS)}."}
  bus = await MessageBus(bus_type=BusType.SESSION).connect()
  try:
    states = []
    for name in await mpris_players(bus):
      try:
        states.append(await player_state(bus, name))
      except Exception:  # noqa: BLE001, S112 - hängende Player überspringen
        continue
    target = _pick_player(states, player)
    if not target:
      return {"error": "Kein passender Medienplayer gefunden. Läuft gerade Musik oder ein Video?"}
    before = target
    keys = ("player", "status", "title", "artist")
    # Schon im gewünschten Zustand: nichts senden, das ist erfüllt.
    if (action == "pause" and before.get("status") in ("Paused", "Stopped")) or (action == "play" and before.get("status") == "Playing") \
        or (action == "stop" and before.get("status") == "Stopped"):
      return {"before": {k: before.get(k) for k in keys}, "after": {k: before.get(k) for k in keys}, "verified": True,
              "note": f"War schon {before.get('status')}."}
    await _call(bus, target["bus_name"], PLAYER_IFACE, method)
    after = before
    want = {"play": "Playing", "pause": "Paused", "stop": "Stopped"}.get(action)
    for _ in range(15):
      await asyncio.sleep(0.2)
      after = await player_state(bus, target["bus_name"])
      if want and after.get("status") == want:
        break
      if action == "toggle" and after.get("status") != before.get("status"):
        break
      if action in ("next", "previous") and (after.get("title"), after.get("artist")) != (before.get("title"), before.get("artist")):
        break
    if want:
      ok = after.get("status") == want
    elif action == "toggle":
      ok = after.get("status") != before.get("status")
    else:
      ok = (after.get("title"), after.get("artist")) != (before.get("title"), before.get("artist"))
    out: dict[str, Any] = {"before": {k: before.get(k) for k in keys}, "after": {k: after.get(k) for k in keys}, "verified": ok}
    if not ok:
      out["error"] = "Der Befehl wurde gesendet, aber der Player meldet keine passende Änderung."
    return out
  finally:
    bus.disconnect()


# ---------- Lautstärke ----------

async def _run(*cmd: str) -> tuple[int, str]:
  p = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
  out, _ = await p.communicate()
  return p.returncode or 0, out.decode(errors="replace")


async def _volume_state() -> dict[str, Any]:
  _, vol = await _run("pactl", "get-sink-volume", "@DEFAULT_SINK@")
  _, mute = await _run("pactl", "get-sink-mute", "@DEFAULT_SINK@")
  pct = re.findall(r"(\d+)%", vol)
  return {"percent": int(pct[0]) if pct else None, "muted": "yes" in mute.lower() or "ja" in mute.lower()}


def _volume_tier(a: dict[str, Any]) -> Tier:
  return Tier.T0 if a.get("level") is None and a.get("mute") is None else Tier.T1


@aura_tool(_volume_tier, label=lambda a: "Lautstärke" + (f" {a['level']} %" if a.get("level") is not None else "") +
           ({True: " stumm", False: " Ton an"}.get(a.get("mute"), "")))
async def volume(level: int | None = None, mute: bool | None = None) -> dict[str, Any]:
  """Liest oder setzt die Systemlautstärke. Ohne Argumente: aktuelle Lautstärke.

  Args:
    level: Lautstärke in Prozent (0–150).
    mute: true = stumm, false = Ton an.
  """
  if not shutil.which("pactl"):
    return {"error": "pactl fehlt (Paket pulseaudio-utils)."}
  if level is not None:
    lv = max(0, min(int(level), 150))
    code, out = await _run("pactl", "set-sink-volume", "@DEFAULT_SINK@", f"{lv}%")
    if code:
      return {"error": out.strip()}
  if mute is not None:
    code, out = await _run("pactl", "set-sink-mute", "@DEFAULT_SINK@", "1" if mute else "0")
    if code:
      return {"error": out.strip()}
  state = await _volume_state()
  if level is None and mute is None:
    return state
  ok = (level is None or state["percent"] == max(0, min(int(level), 150))) and (mute is None or state["muted"] == bool(mute))
  return {**state, "verified": ok, **({} if ok else {"error": "Lautstärke wurde nicht wie gewünscht übernommen."})}


# ---------- Systemeinstellungen (gsettings) ----------

# Einstellungen, die Aura ohne Rückfrage ändern darf (umkehrbar, harmlos).
SETTINGS_T1 = {
    ("org.gnome.desktop.interface", "color-scheme"), ("org.gnome.desktop.interface", "gtk-theme"),
    ("org.gnome.desktop.interface", "text-scaling-factor"), ("org.gnome.desktop.interface", "clock-show-seconds"),
    ("org.gnome.desktop.interface", "clock-show-weekday"), ("org.gnome.desktop.interface", "show-battery-percentage"),
    ("org.gnome.settings-daemon.plugins.color", "night-light-enabled"),
    ("org.gnome.settings-daemon.plugins.color", "night-light-temperature"),
    ("org.gnome.desktop.notifications", "show-banners"), ("org.gnome.desktop.background", "picture-uri"),
    ("org.gnome.desktop.background", "picture-uri-dark"), ("org.gnome.desktop.sound", "event-sounds"),
}
SETTINGS_T3 = ("org.gnome.desktop.lockdown", "org.gnome.desktop.privacy", "org.gnome.desktop.screensaver",
               "org.gnome.login-screen", "org.gnome.desktop.remote-desktop")


def _settings_tier(a: dict[str, Any]) -> tuple[Tier, str]:
  schema, key = str(a.get("schema", "")), str(a.get("key", ""))
  if schema.startswith(SETTINGS_T3):
    return Tier.T3, "Sicherheits- und Sperreinstellungen"
  if a.get("value") is None:
    return Tier.T0, ""
  if (schema, key) in SETTINGS_T1:
    return Tier.T1, ""
  return Tier.T2, "Systemeinstellung außerhalb der freigegebenen Liste"


@aura_tool(_settings_tier, label=lambda a: f"{a.get('schema', '')} {a.get('key', '')}" + (f" = {a['value']}" if a.get("value") is not None else ""))
async def settings(schema: str, key: str, value: str | None = None) -> dict[str, Any]:
  """Liest oder ändert eine GNOME-Einstellung (gsettings), z. B. Dunkelmodus, Nachtlicht, Bitte-nicht-stören.

  Beispiele: schema "org.gnome.desktop.interface", key "color-scheme", value "'prefer-dark'";
  schema "org.gnome.desktop.notifications", key "show-banners", value "false" (= nicht stören).

  Args:
    schema: gsettings-Schema.
    key: Schlüssel.
    value: Neuer Wert in gsettings-Schreibweise. Ohne value wird nur gelesen.
  """
  code, before = await _run("gsettings", "get", schema, key)
  if code:
    return {"error": before.strip()}
  if value is None:
    return {"schema": schema, "key": key, "value": before.strip()}
  code, out = await _run("gsettings", "set", schema, key, value)
  if code:
    return {"error": out.strip()}
  _, after = await _run("gsettings", "get", schema, key)
  norm = lambda v: v.strip().strip("'\"")
  ok = norm(after) == norm(value)
  return {"schema": schema, "key": key, "before": before.strip(), "after": after.strip(), "verified": ok,
          **({} if ok else {"error": "Wert wurde nicht übernommen."})}


# ---------- Dunkelmodus (eigenes Werkzeug, weil der richtige Weg je System verschieden ist) ----------

THEME_DIRS = (Path("/usr/share/themes"), Path.home() / ".themes", Path.home() / ".local/share/themes")


def _theme_exists(name: str) -> bool:
  return any((d / name).is_dir() for d in THEME_DIRS)


async def _has_key(schema: str, key: str) -> bool:
  code, _ = await _run("gsettings", "range", schema, key)
  return code == 0


@aura_tool(Tier.T1, label=lambda a: "Dunkelmodus " + ("an" if a.get("on", True) else "aus"))
async def dark_mode(on: bool = True) -> dict[str, Any]:
  """Schaltet den Dunkelmodus des Desktops ein oder aus (richtige Einstellung für dieses System, mit Nachprüfung).

  Args:
    on: true = dunkel, false = hell.
  """
  iface = "org.gnome.desktop.interface"
  changed: dict[str, str] = {}
  if await _has_key(iface, "color-scheme"):
    want = "'prefer-dark'" if on else "'default'"
    await _run("gsettings", "set", iface, "color-scheme", want)
    _, now = await _run("gsettings", "get", iface, "color-scheme")
    changed["color-scheme"] = now.strip()
  _, theme = await _run("gsettings", "get", iface, "gtk-theme")
  theme = theme.strip().strip("'")
  base = theme.removesuffix("-dark")
  target = f"{base}-dark" if on else base
  if target != theme and (_theme_exists(target) or not on):
    await _run("gsettings", "set", iface, "gtk-theme", target)
  _, now_theme = await _run("gsettings", "get", iface, "gtk-theme")
  changed["gtk-theme"] = now_theme.strip()
  is_dark = "prefer-dark" in changed.get("color-scheme", "") or now_theme.strip().strip("'").endswith("-dark")
  ok = is_dark == on
  return {"dark": is_dark, "settings": changed, "verified": ok,
          **({} if ok else {"error": "Konnte den Dunkelmodus hier nicht umstellen (kein color-scheme und kein dunkles Theme gefunden)."})}
