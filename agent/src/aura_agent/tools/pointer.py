"""Maus und Tastatur über Bildschirmkoordinaten: Notlösung für Programme ohne Barrierefreiheit (ADR 0005).

Erst ui_snapshot (AT-SPI) oder browser versuchen. Koordinaten 0–1000 beziehen sich auf das letzte
screenshot-Bild. Nach jeder Eingabe kommt automatisch ein neues Bildschirmfoto zurück, damit das Modell
die Wirkung prüft. Die Eingabe selbst macht die Aura-App (X11 und Wayland).
"""

from __future__ import annotations

import asyncio
from typing import Any

from ..harness.tiers import Tier, aura_tool
from ..runtime.context import current
from .browser import CONSEQUENTIAL
from .screen import screenshot

SAFE_KEYS = {
    "escape",
    "esc",
    "tab",
    "up",
    "down",
    "left",
    "right",
    "pageup",
    "pagedown",
    "home",
    "end",
    "shift+tab",
    "space",
}


# After a web app turned out to be unreadable (AURA-92), clicks and keys on screenshots are guesswork: ask first.
BLIND_IN_WEB_APP = (
    "Inhalt der Web-App ist für Aura nicht lesbar; Klicks und Tasten nach Bildschirmfoto sind unzuverlässig"
)


def _blind_in_web_app() -> bool:
    task = current()
    return task is not None and task.web_content_unavailable


def _click_tier(a: dict[str, Any]) -> tuple[Tier, str]:
    if CONSEQUENTIAL.search(str(a.get("element", ""))):
        return Tier.T2, "Klick auf etwas Folgenreiches"
    if _blind_in_web_app():
        return Tier.T2, BLIND_IN_WEB_APP
    return Tier.T1, ""


async def _after(result: dict[str, Any]) -> dict[str, Any]:
    if result.get("error"):
        return result
    await asyncio.sleep(0.7)
    shot = await screenshot()
    return {**result, "image": shot.get("image")} if shot.get("image") is not None else result


@aura_tool(
    _click_tier, label=lambda a: f"{a.get('element', '')} ({a.get('x')}, {a.get('y')})", required=("element",)
)
async def click_at(
    x: float, y: float, element: str, double: bool = False, right: bool = False
) -> dict[str, Any]:
    """Klickt an eine Stelle im letzten Bildschirmfoto (x, y von 0 bis 1000; 0,0 = oben links). Nur als Notlösung,
    wenn ui_snapshot das Programm nicht kennt. Danach kommt ein neues Bildschirmfoto zurück.

    Args:
      x: Waagrecht 0–1000.
      y: Senkrecht 0–1000.
      element: Was dort ist, z. B. „Knopf Abspielen“.
      double: Doppelklick.
      right: Rechtsklick.
    """
    task = current()
    if task is None:
        return {"error": "Keine Verbindung zur App."}
    if not (0 <= float(x) <= 1000 and 0 <= float(y) <= 1000):
        return {"error": "x und y müssen zwischen 0 und 1000 liegen."}
    r = await task.host.input(
        {
            "action": "click",
            "x": float(x),
            "y": float(y),
            "double": bool(double),
            "button": "right" if right else "left",
        }
    )
    return await _after(r)


@aura_tool(
    lambda a: (Tier.T2, "tippt in das gerade aktive Fenster"),
    label=lambda a: str(a.get("text", ""))[:120],
    effect=lambda a: f"Tippen ins aktive Fenster: {a.get('text', '')}",
)
async def type_text(text: str) -> dict[str, Any]:
    """Tippt Text in das gerade aktive Fenster (vorher hineinklicken). Notlösung; Felder lieber mit ui_set_text.

    Args:
      text: Der Text.
    """
    task = current()
    if task is None:
        return {"error": "Keine Verbindung zur App."}
    return await _after(await task.host.input({"action": "type", "text": text}))


def _keys_tier(a: dict[str, Any]) -> tuple[Tier, str]:
    keys = str(a.get("keys", "")).lower().replace(" ", "")
    if keys in SAFE_KEYS and not _blind_in_web_app():
        return Tier.T1, ""
    return Tier.T2, BLIND_IN_WEB_APP if _blind_in_web_app() else "Tastenkombination im aktiven Fenster"


@aura_tool(_keys_tier, label=lambda a: str(a.get("keys", "")))
async def press_keys(keys: str) -> dict[str, Any]:
    """Drückt eine Taste oder Tastenkombination im aktiven Fenster, z. B. "enter", "ctrl+s", "escape".

    Args:
      keys: Taste oder Kombination.
    """
    task = current()
    if task is None:
        return {"error": "Keine Verbindung zur App."}
    return await _after(await task.host.input({"action": "keys", "keys": keys}))


def _nav_tier(_a: dict[str, Any]) -> tuple[Tier, str]:
    if _blind_in_web_app():
        return Tier.T2, BLIND_IN_WEB_APP
    return Tier.T1, ""


@aura_tool(
    _nav_tier,
    label=lambda a: f"Maus bewegen ({a.get('x')}, {a.get('y')}) {a.get('element', '')}".strip(),
)
async def move_mouse(x: float, y: float, element: str = "") -> dict[str, Any]:
    """Bewegt den Mauszeiger an eine Stelle im Bildschirmfoto (x, y von 0 bis 1000), ohne zu klicken (z. B. für Hover-Menüs oder Tooltips).

    Args:
      x: Waagrecht 0–1000.
      y: Senkrecht 0–1000.
      element: Optionaler Hinweis, worüber die Maus schwebt.
    """
    task = current()
    if task is None:
        return {"error": "Keine Verbindung zur App."}
    if not (0 <= float(x) <= 1000 and 0 <= float(y) <= 1000):
        return {"error": "x und y müssen zwischen 0 und 1000 liegen."}
    r = await task.host.input({"action": "move", "x": float(x), "y": float(y), "element": element})
    return await _after(r)


@aura_tool(
    _click_tier,
    label=lambda a: (
        f"{a.get('element', '')} ziehen ({a.get('start_x')},{a.get('start_y')} -> {a.get('end_x')},{a.get('end_y')})"
    ),
    required=("element",),
)
async def drag_mouse(
    start_x: float,
    start_y: float,
    end_x: float,
    end_y: float,
    element: str,
    right: bool = False,
) -> dict[str, Any]:
    """Zieht mit gedrückter Maustaste von (start_x, start_y) nach (end_x, end_y) (alle Werte 0–1000; z. B. für Schieberegler, Bildbearbeitung, Auswahlrahmen oder Drag-and-Drop).

    Args:
      start_x: Start waagrecht 0–1000.
      start_y: Start senkrecht 0–1000.
      end_x: Ziel waagrecht 0–1000.
      end_y: Ziel senkrecht 0–1000.
      element: Was gezogen wird, z. B. „Helligkeitsregler“ oder „Auswahlrahmen“.
      right: Rechte statt linke Maustaste.
    """
    task = current()
    if task is None:
        return {"error": "Keine Verbindung zur App."}
    for val in (start_x, start_y, end_x, end_y):
        if not (0 <= float(val) <= 1000):
            return {"error": "Alle Koordinaten müssen zwischen 0 und 1000 liegen."}
    r = await task.host.input(
        {
            "action": "drag",
            "x": float(start_x),
            "y": float(start_y),
            "endX": float(end_x),
            "endY": float(end_y),
            "button": "right" if right else "left",
        }
    )
    return await _after(r)


@aura_tool(
    _nav_tier,
    label=lambda a: f"Scrollen ({a.get('direction', 'down')}) bei ({a.get('x')}, {a.get('y')})",
)
async def scroll_at(x: float, y: float, direction: str = "down", amount: int = 3) -> dict[str, Any]:
    """Scrollt mit dem Mausrad an Position (x, y) (0–1000).

    Args:
      x: Waagrecht 0–1000.
      y: Senkrecht 0–1000.
      direction: Richtung: "down", "up", "left" oder "right".
      amount: Anzahl der Rasterschritte (1–20, Standard 3).
    """
    task = current()
    if task is None:
        return {"error": "Keine Verbindung zur App."}
    if not (0 <= float(x) <= 1000 and 0 <= float(y) <= 1000):
        return {"error": "x und y müssen zwischen 0 und 1000 liegen."}
    dir_norm = direction.lower().strip()
    if dir_norm not in ("down", "up", "left", "right"):
        return {"error": "direction muss down, up, left oder right sein."}
    r = await task.host.input(
        {
            "action": "scroll",
            "x": float(x),
            "y": float(y),
            "direction": dir_norm,
            "amount": max(1, min(20, int(amount))),
        }
    )
    return await _after(r)


def _clipboard_tier(a: dict[str, Any]) -> tuple[Tier, str]:
    mode = str(a.get("action", "read")).lower().strip()
    if mode == "write":
        return Tier.T1, "In Zwischenablage kopieren"
    return Tier.T0, ""


@aura_tool(
    _clipboard_tier,
    label=lambda a: (
        "Zwischenablage lesen"
        if str(a.get("action", "read")).lower() != "write"
        else f"Zwischenablage schreiben: {str(a.get('text', ''))[:60]}"
    ),
)
async def clipboard(action: str = "read", text: str = "") -> dict[str, Any]:
    """Liest oder schreibt Text in die System-Zwischenablage (schneller und zuverlässiger als langes Tippen mit type_text: erst clipboard(action="write", text=...), dann press_keys("ctrl+v")).

    Args:
      action: "read" (lesen) oder "write" (schreiben).
      text: Zu kopierender Text (nur bei action="write").
    """
    task = current()
    if task is None:
        return {"error": "Keine Verbindung zur App."}
    mode = action.lower().strip()
    if mode not in ("read", "write"):
        return {"error": "action muss 'read' oder 'write' sein."}
    return await task.host.input({"action": "clipboard", "mode": mode, "text": text})
