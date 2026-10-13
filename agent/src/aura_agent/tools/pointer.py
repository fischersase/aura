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


def _click_tier(a: dict[str, Any]) -> tuple[Tier, str]:
    if CONSEQUENTIAL.search(str(a.get("element", ""))):
        return Tier.T2, "Klick auf etwas Folgenreiches"
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
    return (Tier.T1, "") if keys in SAFE_KEYS else (Tier.T2, "Tastenkombination im aktiven Fenster")


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
