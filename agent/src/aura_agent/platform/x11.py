"""Fenster unter X11 über EWMH (python-xlib), ohne externe Programme.

Mit Fenstermanager (GNOME/mutter, Chrome Remote Desktop) gilt _NET_CLIENT_LIST.
Ohne Fenstermanager (Xvfb in den Evals) werden die sichtbaren Fenster direkt
aus dem Fensterbaum gelesen. Alle Aufrufe sind blockierend; Werkzeuge rufen
sie mit asyncio.to_thread auf.
"""

from __future__ import annotations

import os
from typing import Any, Self

from Xlib import X, Xatom, display, error, protocol
from Xlib.xobject.drawable import Window

from .base import WindowInfo

__all__ = ["X11", "WindowInfo", "available"]


def available() -> bool:
  return bool(os.environ.get("DISPLAY"))


class X11:
  def __init__(self) -> None:
    self.d = display.Display()
    self.root = self.d.screen().root

  def close(self) -> None:
    self.d.close()

  def __enter__(self) -> Self:
    return self

  def __exit__(self, *exc: object) -> None:
    self.close()

  def _atom(self, name: str) -> int:
    return self.d.intern_atom(name)

  def _prop(self, win: Window, name: str, kind: int = X.AnyPropertyType) -> Any:
    try:
      p = win.get_full_property(self._atom(name), kind)
    except error.XError:
      return None
    return p.value if p else None

  def _text(self, win: Window, name: str) -> str:
    v = self._prop(win, name)
    if v is None:
      return ""
    return v.decode("utf-8", "replace") if isinstance(v, bytes) else str(v)

  def _clients(self) -> list[Window]:
    ids = self._prop(self.root, "_NET_CLIENT_LIST")
    if ids is not None:
      return [self.d.create_resource_object("window", int(i)) for i in ids]
    # Kein Fenstermanager: sichtbare Fenster der obersten Ebene mit WM_CLASS.
    out = []
    for w in self.root.query_tree().children:
      try:
        if w.get_attributes().map_state == X.IsViewable and w.get_wm_class():
          out.append(w)
      except error.XError:
        continue
    return out

  def _active_id(self) -> int | None:
    v = self._prop(self.root, "_NET_ACTIVE_WINDOW")
    if v is not None and len(v):
      return int(v[0])
    try:
      focus = self.d.get_input_focus().focus
      return int(focus.id) if hasattr(focus, "id") else None
    except error.XError:
      return None

  def windows(self) -> list[WindowInfo]:
    active = self._active_id()
    hidden = self._atom("_NET_WM_STATE_HIDDEN")
    out = []
    for w in self._clients():
      try:
        cls = w.get_wm_class() or ("", "")
        title = self._text(w, "_NET_WM_NAME") or (w.get_wm_name() or "")
        if isinstance(title, bytes):
          title = title.decode("utf-8", "replace")
        pid = self._prop(w, "_NET_WM_PID", Xatom.CARDINAL)
        desk = self._prop(w, "_NET_WM_DESKTOP", Xatom.CARDINAL)
        state = self._prop(w, "_NET_WM_STATE", Xatom.ATOM)
        out.append(WindowInfo(
            id=hex(w.id), title=str(title), app=cls[1], instance=cls[0],
            pid=int(pid[0]) if pid is not None and len(pid) else None,
            desktop=int(desk[0]) if desk is not None and len(desk) else None,
            active=w.id == active, minimized=bool(state is not None and hidden in list(state)),
        ))
      except error.XError:
        continue
    return out

  def _window(self, wid: str | int) -> Window:
    return self.d.create_resource_object("window", int(wid, 16) if isinstance(wid, str) else wid)

  def _client_message(self, win: Window, name: str, data: list[int]) -> None:
    ev = protocol.event.ClientMessage(window=win, client_type=self._atom(name), data=(32, (data + [0] * 5)[:5]))
    self.root.send_event(ev, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
    self.d.sync()  # auf den Server warten: bei sofort geschlossener Verbindung gingen Befehle unter Last verloren (AURA-58)

  def focus(self, wid: str) -> None:
    win = self._window(wid)
    if self._prop(self.root, "_NET_SUPPORTED") is not None:
      self._client_message(win, "_NET_ACTIVE_WINDOW", [2, X.CurrentTime, 0])
    else:
      win.map()
      win.raise_window()
      win.set_input_focus(X.RevertToParent, X.CurrentTime)
      self.d.sync()  # auf den Server warten: bei sofort geschlossener Verbindung gingen Befehle unter Last verloren (AURA-58)

  def minimize(self, wid: str) -> None:
    self._client_message(self._window(wid), "WM_CHANGE_STATE", [3])  # IconicState

  def maximize(self, wid: str, on: bool = True) -> None:
    self._client_message(self._window(wid), "_NET_WM_STATE", [1 if on else 0, self._atom("_NET_WM_STATE_MAXIMIZED_VERT"),
                                                              self._atom("_NET_WM_STATE_MAXIMIZED_HORZ"), 2])

  def close_window(self, wid: str) -> None:
    win = self._window(wid)
    if self._prop(self.root, "_NET_SUPPORTED") is not None:
      self._client_message(win, "_NET_CLOSE_WINDOW", [X.CurrentTime, 2])
    else:
      win.destroy()
      self.d.sync()  # auf den Server warten: bei sofort geschlossener Verbindung gingen Befehle unter Last verloren (AURA-58)
