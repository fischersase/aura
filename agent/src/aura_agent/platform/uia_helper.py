"""UI-Automation-Helfer für Aura unter Windows: Gegenstück zu atspi_helper.py mit demselben Zeilenprotokoll.

  {"id": 1, "method": "apps"}                                  → Programme mit Fenstern
  {"id": 2, "method": "snapshot", "params": {"app": "…", "window": "…", "max": 300}}
  {"id": 3, "method": "act", "params": {"index": 12, "action": "click"}}
  {"id": 4, "method": "set_text", "params": {"index": 7, "text": "…"}}
  {"id": 5, "method": "read", "params": {"index": 7}}

Läuft als eigener Prozess (python -m aura_agent.platform.uia_helper), weil UI-Automation-Aufrufe bei hängenden
Programmen blockieren: Aura beendet und startet den Helfer dann neu. Die Rollen heißen wie bei AT-SPI
("push button", "entry", "password text" …), damit Werkzeuge und Stufen auf beiden Systemen gleich arbeiten.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from typing import Any

sys.coinit_flags = 0  # type: ignore[attr-defined]  # COM im Multithread-Modus: Elemente dürfen in Hilfsthreads benutzt werden

import comtypes
import comtypes.client

comtypes.client.GetModule("UIAutomationCore.dll")
from comtypes.gen import UIAutomationClient as U

from .win32 import exe_path

AUTO = comtypes.client.CreateObject(U.CUIAutomation, interface=U.IUIAutomation)
WALKER = AUTO.ControlViewWalker

ROLES = {
    50000: "push button",
    50001: "calendar",
    50002: "check box",
    50003: "combo box",
    50004: "entry",
    50005: "link",
    50006: "image",
    50007: "list item",
    50008: "list",
    50009: "menu",
    50010: "menu bar",
    50011: "menu item",
    50012: "progress bar",
    50013: "radio button",
    50014: "scroll bar",
    50015: "slider",
    50016: "spin button",
    50017: "status bar",
    50018: "page tab list",
    50019: "page tab",
    50020: "label",
    50021: "tool bar",
    50022: "tool tip",
    50023: "tree",
    50024: "tree item",
    50025: "custom",
    50026: "panel",
    50027: "thumb",
    50028: "table",
    50029: "table cell",
    50030: "document text",
    50031: "button",
    50032: "window",
    50033: "pane",
    50034: "heading",
    50035: "header item",
    50036: "table",
    50037: "title bar",
    50038: "separator",
    50039: "semantic zoom",
    50040: "app bar",
}
INTERACTIVE = {
    "push button",
    "toggle button",
    "check box",
    "radio button",
    "menu item",
    "entry",
    "password text",
    "combo box",
    "list item",
    "page tab",
    "slider",
    "spin button",
    "link",
    "tree item",
    "table cell",
    "menu",
    "button",
    "document text",
}
READABLE = {"label", "heading", "status bar", "dialog", "tool tip"}
CONTAINERS = {"window", "dialog", "panel", "page tab", "menu", "tool bar", "pane"}
MAX_NODES = 4000
MAX_DEPTH = 40
INVOKE_WAIT_S = 3.0

P = {
    "name": U.UIA_NamePropertyId,
    "type": U.UIA_ControlTypePropertyId,
    "pid": U.UIA_ProcessIdPropertyId,
    "enabled": U.UIA_IsEnabledPropertyId,
    "offscreen": U.UIA_IsOffscreenPropertyId,
    "focus": U.UIA_HasKeyboardFocusPropertyId,
    "password": U.UIA_IsPasswordPropertyId,
    "invoke": U.UIA_IsInvokePatternAvailablePropertyId,
    "toggle": U.UIA_IsTogglePatternAvailablePropertyId,
    "has_value": U.UIA_IsValuePatternAvailablePropertyId,
    "expand": U.UIA_IsExpandCollapsePatternAvailablePropertyId,
    "select": U.UIA_IsSelectionItemPatternAvailablePropertyId,
    "range": U.UIA_IsRangeValuePatternAvailablePropertyId,
    "value": U.UIA_ValueValuePropertyId,
    "readonly": U.UIA_ValueIsReadOnlyPropertyId,
    "toggle_state": U.UIA_ToggleToggleStatePropertyId,
    "selected": U.UIA_SelectionItemIsSelectedPropertyId,
    "expand_state": U.UIA_ExpandCollapseExpandCollapseStatePropertyId,
    "range_value": U.UIA_RangeValueValuePropertyId,
    "legacy": U.UIA_IsLegacyIAccessiblePatternAvailablePropertyId,
    "default_action": U.UIA_LegacyIAccessibleDefaultActionPropertyId,
    "class": U.UIA_ClassNamePropertyId,
}
CACHE = AUTO.CreateCacheRequest()
for _pid in P.values():
    CACHE.AddProperty(_pid)

_nodes: list[Any] = []
_procs: dict[int, str] = {}


def _get(el: Any, key: str) -> Any:
    try:
        return el.GetCachedPropertyValue(P[key])
    except Exception:  # noqa: BLE001 - einzelne Eigenschaften fremder Programme dürfen fehlen
        return None


def _proc_name(pid: int) -> str:
    if pid not in _procs:
        _procs[pid] = os.path.splitext(os.path.basename(exe_path(pid)))[0].lower() if pid else ""
    return _procs[pid]


def _role(el: Any) -> str:
    role = ROLES.get(_get(el, "type") or 0, "unknown")
    if role == "entry" and _get(el, "password"):
        return "password text"
    if role == "push button" and _get(el, "toggle"):
        return "toggle button"
    if role == "window" and _get(el, "class") == "#32770":
        return "dialog"
    return role


def _children(el: Any) -> list[Any]:
    out = []
    try:
        c = WALKER.GetFirstChildElementBuildCache(el, CACHE)
        while c and len(out) < 400:
            out.append(c)
            c = WALKER.GetNextSiblingElementBuildCache(c, CACHE)
    except Exception:  # noqa: BLE001, S110 - Programm antwortet nicht oder Element verschwand
        pass
    return out


def _windows() -> list[Any]:
    return [w for w in _children(AUTO.GetRootElementBuildCache(CACHE)) if _get(w, "name")]


def _states(el: Any) -> list[str]:
    s = []
    if _get(el, "focus"):
        s.append("focused")
    if _get(el, "toggle") and _get(el, "toggle_state") == 1:
        s.append("checked")
    if _get(el, "select") and _get(el, "selected"):
        s.append("selected")
    if _get(el, "expand") and _get(el, "expand_state") in (1, 2):
        s.append("expanded")
    if _get(el, "has_value") and not _get(el, "readonly"):
        s.append("editable")
    if not _get(el, "enabled"):
        s.append("disabled")
    return s


def _actions(el: Any) -> list[str]:
    acts = []
    if _get(el, "invoke"):
        acts.append("click")
    if _get(el, "toggle"):
        acts.append("toggle")
    if _get(el, "select"):
        acts.append("select")
    if _get(el, "expand"):
        acts.append("expand or contract")
    if not acts and _get(el, "legacy") and _get(el, "default_action"):
        acts.append(str(_get(el, "default_action")).lower())
    return acts


def apps(_p: dict) -> dict:
    groups: dict[str, list[str]] = {}
    for w in _windows():
        groups.setdefault(_proc_name(_get(w, "pid") or 0), []).append(_get(w, "name"))
    return {"apps": [{"app": a, "windows": t[:10]} for a, t in groups.items() if a]}


def snapshot(p: dict) -> dict:
    global _nodes
    want_app = str(p.get("app", "")).lower()
    want_win = str(p.get("window", "")).lower()
    limit = min(int(p.get("max", 300)), 1000)
    _nodes = []
    items: list[dict] = []
    visited = 0

    wins = []
    for w in _windows():
        title = (_get(w, "name") or "").lower()
        app = _proc_name(_get(w, "pid") or 0)
        if want_app and want_app not in app and want_app not in title:
            continue
        if want_win and want_win not in title:
            continue
        wins.append((w, app))
    if want_app and not wins:
        return {"error": f"Kein Programm „{p.get('app')}“ über die Barrierefreiheit sichtbar.", **apps({})}

    def walk(el: Any, depth: int, path: str) -> None:
        nonlocal visited
        if depth > MAX_DEPTH or visited > MAX_NODES or len(items) >= limit:
            return
        visited += 1
        role = _role(el)
        name = str(_get(el, "name") or "").strip()
        if _get(el, "offscreen") and depth > 2:
            return
        if role in INTERACTIVE or (role in READABLE and name):
            _nodes.append(el)
            item: dict[str, Any] = {
                "index": len(_nodes) - 1,
                "role": role,
                "name": name[:120],
                "in": path[-80:],
            }
            if _get(el, "has_value") and role not in ("password text",):
                text = str(_get(el, "value") or "")
                if text and text != name:
                    item["text"] = text[:200]
            if _get(el, "range"):
                item["value"] = _get(el, "range_value")
            flags = _states(el)
            if flags:
                item["state"] = flags
            acts = _actions(el)
            if acts:
                item["actions"] = acts[:4]
            items.append(item)
        here = f"{path} › {name}" if name and role in CONTAINERS else path
        for c in _children(el):
            walk(c, depth + 1, here)

    for w, app in wins:
        walk(w, 0, f"{app}: {_get(w, 'name')}")
    return {"count": len(items), "truncated": len(items) >= limit, "elements": items}


def _node(p: dict) -> Any:
    i = int(p.get("index", -1))
    if not 0 <= i < len(_nodes):
        raise ValueError(f"Index {i} unbekannt; erst ui_snapshot aufrufen.")
    return _nodes[i]


def _pattern(el: Any, pattern_id: int, iface: Any) -> Any:
    try:
        unk = el.GetCurrentPattern(pattern_id)
    except Exception:  # noqa: BLE001
        return None
    if not unk:
        return None
    return unk.QueryInterface(iface)


def _live(el: Any) -> dict[str, Any]:
    """Aktueller Zustand eines Elements (nicht aus dem Zwischenspeicher)."""
    fresh = el.BuildUpdatedCache(CACHE)
    return {
        "role": _role(fresh),
        "name": _get(fresh, "name"),
        "text": "" if _get(fresh, "password") else str(_get(fresh, "value") or ""),
        "value": _get(fresh, "range_value") if _get(fresh, "range") else None,
        "state": _states(fresh),
    }


def read(p: dict) -> dict:
    return _live(_node(p))


def _run_bounded(fn: Any) -> bool:
    """Invoke kann blockieren, bis ein geöffneter modaler Dialog wieder zu ist; dann gilt die Aktion als ausgelöst."""
    done = threading.Event()
    err: list[BaseException] = []

    def target() -> None:
        comtypes.CoInitializeEx(0)
        try:
            fn()
        except BaseException as e:  # noqa: BLE001
            err.append(e)
        finally:
            done.set()

    threading.Thread(target=target, daemon=True).start()
    if done.wait(INVOKE_WAIT_S) and err:
        raise err[0]
    return done.is_set()


def act(p: dict) -> dict:
    el = _node(p)
    want = str(p.get("action") or "click").lower()
    order = {
        "toggle": ["toggle", "invoke"],
        "select": ["select", "invoke"],
        "expand": ["expand"],
        "expand or contract": ["expand"],
    }.get(want, ["invoke", "toggle", "select", "expand", "legacy"])
    for kind in order:
        if kind == "invoke" and (pat := _pattern(el, U.UIA_InvokePatternId, U.IUIAutomationInvokePattern)):
            returned = _run_bounded(pat.Invoke)
            out = {"done": True, "action": "click", "element": _get(el, "name")}
            if not returned:
                out["note"] = "Das Programm wartet noch (z. B. ein Dialog ist offen)."
            else:
                out["state"] = _live(el)["state"]
            return out
        if kind == "toggle" and (pat := _pattern(el, U.UIA_TogglePatternId, U.IUIAutomationTogglePattern)):
            pat.Toggle()
            return {
                "done": True,
                "action": "toggle",
                "element": _get(el, "name"),
                "state": _live(el)["state"],
            }
        if kind == "select" and (
            pat := _pattern(el, U.UIA_SelectionItemPatternId, U.IUIAutomationSelectionItemPattern)
        ):
            pat.Select()
            return {
                "done": True,
                "action": "select",
                "element": _get(el, "name"),
                "state": _live(el)["state"],
            }
        if kind == "expand" and (
            pat := _pattern(el, U.UIA_ExpandCollapsePatternId, U.IUIAutomationExpandCollapsePattern)
        ):
            if pat.CurrentExpandCollapseState in (1, 2):
                pat.Collapse()
            else:
                pat.Expand()
            return {
                "done": True,
                "action": "expand or contract",
                "element": _get(el, "name"),
                "state": _live(el)["state"],
            }
        if (
            kind == "legacy"
            and (
                pat := _pattern(el, U.UIA_LegacyIAccessiblePatternId, U.IUIAutomationLegacyIAccessiblePattern)
            )
            and pat.CurrentDefaultAction
        ):
            _run_bounded(pat.DoDefaultAction)
            return {"done": True, "action": str(pat.CurrentDefaultAction), "element": _get(el, "name")}
    try:
        el.SetFocus()
        return {
            "done": False,
            "focused": True,
            "note": f"Keine passende Aktion ({_actions(el)}); Element wurde fokussiert.",
        }
    except Exception:  # noqa: BLE001
        return {
            "done": False,
            "error": f"Element kann „{want}“ nicht. Mögliche Aktionen: {_actions(el) or 'keine'}",
        }


def set_text(p: dict) -> dict:
    el = _node(p)
    if _get(el, "password"):
        return {"error": "Passwortfelder füllt Aura nicht aus."}
    pat = _pattern(el, U.UIA_ValuePatternId, U.IUIAutomationValuePattern)
    if pat is None or pat.CurrentIsReadOnly:
        return {"error": "Element ist kein beschreibbares Textfeld."}
    pat.SetValue(str(p.get("text", "")))
    return {"done": True, "text": pat.CurrentValue}


METHODS = {
    "apps": apps,
    "snapshot": snapshot,
    "act": act,
    "set_text": set_text,
    "read": read,
    "ping": lambda p: {"ok": True},
}


def main() -> None:
    stdin = sys.stdin.buffer
    out = sys.stdout.buffer
    for raw in stdin:
        if not raw.strip():
            continue
        msg: Any = None
        try:
            msg = json.loads(raw)
            result = METHODS[msg["method"]](msg.get("params") or {})
            reply = {"id": msg.get("id"), "result": result}
        except Exception as e:  # noqa: BLE001
            reply = {
                "id": msg.get("id") if isinstance(msg, dict) else None,
                "error": f"{type(e).__name__}: {e}",
            }
        out.write((json.dumps(reply, ensure_ascii=False, default=str) + "\n").encode("utf-8"))
        out.flush()


if __name__ == "__main__":
    main()
