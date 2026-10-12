"""Medien unter Windows über die System Media Transport Controls (SMTC), das Gegenstück zu MPRIS.

Jeder Player, der sich in der Medienübersicht von Windows zeigt (Spotify, Chrome/Edge mit YouTube Music,
Medienwiedergabe …), ist eine Sitzung mit Titel, Status und Steuerung. Zugriff über pywinrt.
"""

from __future__ import annotations

from typing import Any, Self

# GlobalSystemMediaTransportControlsSessionPlaybackStatus
STATUS = {0: "Stopped", 1: "Stopped", 2: "Changing", 3: "Stopped", 4: "Playing", 5: "Paused"}
METHODS = {"play": "try_play_async", "pause": "try_pause_async", "toggle": "try_toggle_play_pause_async",
           "next": "try_skip_next_async", "previous": "try_skip_previous_async", "stop": "try_stop_async"}


def player_name(aumid: str) -> str:
  """Lesbarer Name aus der App-ID: "Spotify.exe" → spotify, "Microsoft.ZuneMusic_8wekyb3d8bbwe!App" → zunemusic."""
  base = aumid.split("!")[0].replace("/", "\\").rsplit("\\", 1)[-1]
  if "_" in base and "." in base.split("_")[0]:
    base = base.split("_")[0].rsplit(".", 1)[-1]
  return base.removesuffix(".exe").removesuffix(".EXE").lower()


class Smtc:
  """async with Smtc() as m: await m.states() / await m.send(id, "pause") / await m.state(id)"""

  async def __aenter__(self) -> Self:
    from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager as Manager

    self.mgr = await Manager.request_async()
    return self

  async def __aexit__(self, *exc: object) -> None:
    self.mgr = None

  def _sessions(self) -> dict[str, Any]:
    return {s.source_app_user_model_id: s for s in self.mgr.get_sessions()}

  async def _state(self, s: Any) -> dict[str, Any]:
    info = s.get_playback_info()
    try:
      props = await s.try_get_media_properties_async()
    except OSError:
      props = None
    c = info.controls
    aumid = s.source_app_user_model_id
    return {
        "player": player_name(aumid),
        "id": aumid,
        "status": STATUS.get(int(info.playback_status), str(info.playback_status)),
        "title": getattr(props, "title", None) or None,
        "artist": getattr(props, "artist", None) or None,
        "album": getattr(props, "album_title", None) or None,
        "can": {"play": c.is_play_enabled, "pause": c.is_pause_enabled, "next": c.is_next_enabled, "previous": c.is_previous_enabled},
    }

  async def states(self) -> list[dict[str, Any]]:
    return [await self._state(s) for s in self.mgr.get_sessions()]

  async def state(self, key: str) -> dict[str, Any]:
    s = self._sessions().get(key)
    return await self._state(s) if s else {}

  async def send(self, key: str, action: str) -> None:
    s = self._sessions().get(key)
    if s is None:
      raise RuntimeError("Der Player ist nicht mehr da.")
    if not await getattr(s, METHODS[action])():
      raise RuntimeError("Der Player hat den Befehl abgelehnt.")
