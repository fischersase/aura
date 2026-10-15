"""Programme über ihre Bedienelemente steuern (AT-SPI unter Linux, UI Automation unter Windows) statt über Pixel (ADR 0005).

ui_snapshot liest Knöpfe, Felder und Texte eines Programms mit Index; ui_act und ui_set_text
bedienen ein Element per Index. Der Index gilt bis zum nächsten ui_snapshot.
Funktioniert mit GTK- und Qt-Programmen (Linux) und den meisten Windows-Programmen (Editor, Explorer,
Rechner, Einstellungen, Office …); Browser und Electron-Programme melden ihre Inhalte oft nicht
(dafür gibt es den browser-Spezialisten).
"""

from __future__ import annotations

import re
from typing import Any

from ..harness.tiers import Tier, aura_tool
from ..platform import a11y
from ..runtime.context import current
from .apps import WEB_APP_NOTE
from .browser import CONSEQUENTIAL

# Browsers whose web content is hidden from accessibility APIs by default (AT-SPI process names, Windows exe names).
BROWSER_APP = re.compile(r"chrom|msedge|microsoft.edge|brave|vivaldi|opera")
# Below this many readable elements a browser window shows only its frame and toolbar, not the page.
MIN_WEB_ELEMENTS = 15

_last: dict[int, dict[str, Any]] = {}  # Index → Element aus dem letzten ui_snapshot


def _elements() -> dict[int, dict[str, Any]]:
    task = current()
    if task is not None and task.ui_elements:
        return task.ui_elements
    return _last


def _consequential(a: dict[str, Any]) -> tuple[Tier, str]:
    index = str(a.get("index", ""))
    known = _elements().get(int(index)) if index.lstrip("-").isdigit() else None
    text = f"{a.get('element', '')} {(known or {}).get('name', '')}"
    if CONSEQUENTIAL.search(text):
        return Tier.T2, "kann etwas löschen, senden, kaufen oder bestätigen"
    return Tier.T1, ""


def _not_available() -> dict[str, Any] | None:
    if not a11y.available():
        return {"error": a11y.MISSING}
    return None


@aura_tool(Tier.T0, label=lambda a: str(a.get("app") or "Programme"))
async def ui_snapshot(app: str = "", window: str = "") -> dict[str, Any]:
    """Liest die Bedienelemente eines Programms (Knöpfe, Felder, Menüs, Texte) mit Index für ui_act/ui_set_text.

    Ohne app: Liste der Programme, die sich so bedienen lassen.

    Args:
      app: Programmname oder Fenstertitel, z. B. "gnome-text-editor", "Dateien", "Rechner".
      window: Optional ein Teil des Fenstertitels.
    """
    if err := _not_available():
        return err
    if not app:
        return await a11y.CLIENT.call("apps")
    r = await a11y.CLIENT.call("snapshot", app=app, window=window, max=250)
    task = current()
    _last.clear()
    if task is not None:
        task.ui_elements.clear()
    for e in r.get("elements") or []:
        _last[e["index"]] = e
        if task is not None:
            task.ui_elements[e["index"]] = e
    if web_content_unavailable(r):
        if task is not None:
            task.web_content_unavailable = True
        return {**r, "web_content_unavailable": True, "error": WEB_APP_NOTE}
    return r


def web_content_unavailable(snapshot: dict[str, Any]) -> bool:
    """A Chrome/Edge window whose page content is not in the accessibility tree (AURA-92).

    Chrome exposes web content only with --force-renderer-accessibility or a running screen reader; otherwise the
    tree holds just the window frame and a few toolbar buttons.
    """
    if snapshot.get("error"):
        return False
    apps = " ".join(str(a) for a in snapshot.get("apps") or []).lower()
    return bool(BROWSER_APP.search(apps)) and len(snapshot.get("elements") or []) < MIN_WEB_ELEMENTS


@aura_tool(
    _consequential,
    label=lambda a: f"{a.get('element', '')} ({a.get('action', 'click')})",
    required=("element",),
)
async def ui_act(index: int, element: str, action: str = "click") -> dict[str, Any]:
    """Bedient ein Element aus dem letzten ui_snapshot: klicken, umschalten, aktivieren.

    Args:
      index: Index aus ui_snapshot.
      element: Was das ist, z. B. „Knopf Speichern“ (muss zum Element passen).
      action: "click" (Standard), "toggle", "activate", "press".
    """
    if err := _not_available():
        return err
    known = _elements().get(int(index))
    if not known:
        return {"error": f"Index {index} ist nicht aus dem letzten ui_snapshot. Rufe ui_snapshot erneut auf."}
    # Die Einstufung beruht auf der Beschreibung; heißt das echte Element nach etwas Folgenreichem,
    # muss die Beschreibung das auch sagen, sonst wird nicht geklickt.
    if CONSEQUENTIAL.search(known.get("name", "")) and not CONSEQUENTIAL.search(element):
        return {
            "error": f"Das Element heißt „{known['name']}“. Beschreibe es so in element; dann fragt die App den Nutzer."
        }
    r = await a11y.CLIENT.call("act", index=int(index), action=action)
    if r.get("error"):
        return r
    return {**r, "verified": bool(r.get("done")), "note": "Prüfe das Ergebnis mit ui_snapshot."}


def _text_tier(a: dict[str, Any]) -> tuple[Tier, str]:
    known = (
        _elements().get(int(a.get("index", -1))) if str(a.get("index", "")).lstrip("-").isdigit() else None
    )
    if known and known.get("role") == "password text":
        return Tier.T3, "Passwortfelder füllt Aura nicht aus"
    return Tier.T1, ""


@aura_tool(
    _text_tier,
    label=lambda a: f"{a.get('element', '')}: {str(a.get('text', ''))[:80]}",
    required=("element",),
)
async def ui_set_text(index: int, element: str, text: str) -> dict[str, Any]:
    """Setzt den Text eines Eingabefelds aus dem letzten ui_snapshot (ersetzt den bisherigen Inhalt).

    Args:
      index: Index aus ui_snapshot.
      element: Welches Feld, z. B. „Suchfeld“.
      text: Der neue Text.
    """
    if err := _not_available():
        return err
    if int(index) not in _elements():
        return {"error": f"Index {index} ist nicht aus dem letzten ui_snapshot. Rufe ui_snapshot erneut auf."}
    r = await a11y.CLIENT.call("set_text", index=int(index), text=text)
    if r.get("error"):
        return r
    ok = (r.get("text") or "") == text
    return {
        "text": r.get("text"),
        "verified": ok,
        **({} if ok else {"error": "Text wurde nicht übernommen."}),
    }
