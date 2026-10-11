"""Ein MPRIS-Player für Tests, auf einem eigenen D-Bus (nie auf dem echten Desktop)."""

from __future__ import annotations

from dbus_fast import PropertyAccess, Variant
from dbus_fast.aio import MessageBus
from dbus_fast.service import ServiceInterface, dbus_property, method

TRACKS = [("Me Porto Bonito", "Bad Bunny"), ("Tití Me Preguntó", "Bad Bunny"), ("un x100to", "Grupo Frontera")]


class Root(ServiceInterface):
  def __init__(self):
    super().__init__("org.mpris.MediaPlayer2")

  @dbus_property(access=PropertyAccess.READ)
  def Identity(self) -> "s":  # noqa: F821
    return "Testplayer"


class Player(ServiceInterface):
  def __init__(self, status: str = "Playing", stuck: bool = False):
    super().__init__("org.mpris.MediaPlayer2.Player")
    self.stuck = stuck  # ignoriert Befehle (wie ein Tab, der nicht reagiert)
    self.status = status
    self.track = 0
    self.calls: list[str] = []

  def _changed(self):
    self.emit_properties_changed({"PlaybackStatus": self.status})

  @method()
  def Play(self):
    self.calls.append("Play")
    if not self.stuck:
      self.status = "Playing"

  @method()
  def Pause(self):
    self.calls.append("Pause")
    if not self.stuck:
      self.status = "Paused"

  @method()
  def PlayPause(self):
    self.calls.append("PlayPause")
    self.status = "Paused" if self.status == "Playing" else "Playing"

  @method()
  def Stop(self):
    self.calls.append("Stop")
    if not self.stuck:
      self.status = "Stopped"

  @method()
  def Next(self):
    self.calls.append("Next")
    self.track = (self.track + 1) % len(TRACKS)

  @method()
  def Previous(self):
    self.calls.append("Previous")
    self.track = (self.track - 1) % len(TRACKS)

  @dbus_property(access=PropertyAccess.READ)
  def PlaybackStatus(self) -> "s":  # noqa: F821
    return self.status

  @dbus_property(access=PropertyAccess.READ)
  def Metadata(self) -> "a{sv}":  # noqa: F821
    title, artist = TRACKS[self.track]
    return {"xesam:title": Variant("s", title), "xesam:artist": Variant("as", [artist])}

  @dbus_property(access=PropertyAccess.READ)
  def Volume(self) -> "d":  # noqa: F821
    return 1.0

  @dbus_property(access=PropertyAccess.READ)
  def CanPlay(self) -> "b":  # noqa: F821
    return True

  @dbus_property(access=PropertyAccess.READ)
  def CanPause(self) -> "b":  # noqa: F821
    return True

  @dbus_property(access=PropertyAccess.READ)
  def CanGoNext(self) -> "b":  # noqa: F821
    return True

  @dbus_property(access=PropertyAccess.READ)
  def CanGoPrevious(self) -> "b":  # noqa: F821
    return True


async def start_player(name: str = "testplayer", status: str = "Playing", stuck: bool = False) -> tuple[MessageBus, Player]:
  bus = await MessageBus().connect()
  player = Player(status, stuck)
  bus.export("/org/mpris/MediaPlayer2", Root())
  bus.export("/org/mpris/MediaPlayer2", player)
  await bus.request_name(f"org.mpris.MediaPlayer2.{name}")
  return bus, player
