#!/usr/bin/env python3
"""AT-SPI-Helfer für Aura (läuft mit dem System-Python, braucht python3-gi und gir1.2-atspi-2.0).

Spricht JSON-Zeilen über stdin/stdout:
  {"id": 1, "method": "apps"}                                  → laufende Programme mit Fenstern
  {"id": 2, "method": "snapshot", "params": {"app": "…", "window": "…", "max": 300}}
                                                               → Bedienelemente mit Index (gilt bis zum nächsten snapshot)
  {"id": 3, "method": "act", "params": {"index": 12, "action": "click"}}
  {"id": 4, "method": "set_text", "params": {"index": 7, "text": "…"}}
  {"id": 5, "method": "read", "params": {"index": 7}}          → Name, Wert, Text, Zustände eines Elements

Ein eigener Prozess, weil AT-SPI-Aufrufe bei hängenden Programmen blockieren können: Aura beendet
und startet den Helfer dann einfach neu.
"""
# pyright: reportMissingImports=false
# (Uses the system PyGObject (gi), which is not installed in the agent's virtual environment.)

from __future__ import annotations

import json
import sys
import warnings

import gi

warnings.filterwarnings("ignore", category=DeprecationWarning)

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi

INTERACTIVE = {
    "push button",
    "toggle button",
    "check box",
    "radio button",
    "menu item",
    "check menu item",
    "radio menu item",
    "entry",
    "password text",
    "text",
    "combo box",
    "list item",
    "page tab",
    "slider",
    "spin button",
    "link",
    "tree item",
    "table cell",
    "menu",
    "toggle",
    "switch",
    "button",
}
READABLE = {
    "label",
    "heading",
    "paragraph",
    "status bar",
    "alert",
    "dialog",
    "notification",
    "static",
    "document text",
}
# Aktionen, die dem Modell gezeigt werden (GTK listet daneben viele interne wie clipboard.copy).
STANDARD_ACTIONS = {"click", "press", "activate", "toggle", "jump", "expand or contract", "open", "select"}
MAX_NODES = 4000
MAX_DEPTH = 40

_nodes: list[Atspi.Accessible] = []


def _states(acc: Atspi.Accessible) -> list[str]:
    try:
        ss = acc.get_state_set()
        return [
            s
            for s in (
                "focused",
                "checked",
                "selected",
                "pressed",
                "expanded",
                "editable",
                "sensitive",
                "showing",
                "active",
            )
            if ss.contains(getattr(Atspi.StateType, s.upper()))
        ]
    except Exception:  # noqa: BLE001
        return []


# Schnittstellen über die Klassenfunktionen aufrufen (Atspi.Text.get_text(acc, …)). Die Objekte aus
# get_*_iface() sind in neueren PyGObject-Versionen das Element selbst, dessen gleichnamige Methoden
# veraltet sind und anderes tun.


def _actions(acc: Atspi.Accessible) -> list[str]:
    try:
        if not acc.get_action_iface():
            return []
        return [Atspi.Action.get_action_name(acc, i) for i in range(Atspi.Action.get_n_actions(acc))]
    except Exception:  # noqa: BLE001
        return []


def _text(acc: Atspi.Accessible) -> str:
    try:
        if acc.get_text_iface():
            n = Atspi.Text.get_character_count(acc)
            return Atspi.Text.get_text(acc, 0, min(n, 300)) if n else ""
    except Exception:  # noqa: BLE001
        pass
    return ""


def _value(acc: Atspi.Accessible) -> float | None:
    try:
        return Atspi.Value.get_current_value(acc) if acc.get_value_iface() else None
    except Exception:  # noqa: BLE001
        return None


def _apps() -> list[Atspi.Accessible]:
    desk = Atspi.get_desktop(0)
    return [a for i in range(desk.get_child_count()) if (a := desk.get_child_at_index(i)) is not None]


def apps(_p: dict) -> dict:
    out = []
    for a in _apps():
        try:
            wins = [a.get_child_at_index(i) for i in range(a.get_child_count())]
            titles = [w.get_name() for w in wins if w is not None and w.get_name()]
            if titles:
                out.append({"app": a.get_name(), "windows": titles[:10]})
        except Exception:  # noqa: BLE001
            continue
    return {"apps": out}


def snapshot(p: dict) -> dict:
    global _nodes
    want_app = str(p.get("app", "")).lower()
    want_win = str(p.get("window", "")).lower()
    limit = min(int(p.get("max", 300)), 1000)
    _nodes = []
    items: list[dict] = []
    visited = 0

    def window_titles(a: Atspi.Accessible) -> str:
        try:
            return " ".join(
                (a.get_child_at_index(i).get_name() or "") for i in range(a.get_child_count())
            ).lower()
        except Exception:
            return ""

    # Programm über seinen Namen oder einen Fenstertitel finden (Modelle nennen oft den Titel).
    matched_apps = (
        [a for a in _apps() if want_app in (a.get_name() or "").lower() or want_app in window_titles(a)]
        if want_app
        else []
    )
    if want_app and not matched_apps:
        return {"error": f"Kein Programm „{p.get('app')}“ über die Barrierefreiheit sichtbar.", **apps({})}

    def walk(acc: Atspi.Accessible, depth: int, path: str) -> None:
        nonlocal visited
        if acc is None or depth > MAX_DEPTH or visited > MAX_NODES or len(items) >= limit:
            return
        visited += 1
        try:
            role = acc.get_role_name()
            name = (acc.get_name() or "").strip()
        except Exception:  # noqa: BLE001
            return
        states = _states(acc)
        if "showing" not in states and depth > 2:
            return
        if role in INTERACTIVE or (role in READABLE and (name or _text(acc))):
            _nodes.append(acc)
            item = {"index": len(_nodes) - 1, "role": role, "name": name[:120], "in": path[-80:]}
            text = (
                _text(acc)
                if role
                in ("entry", "text", "password text", "document text", "label", "paragraph", "heading")
                else ""
            )
            if text and text != name and role != "password text":
                item["text"] = text[:200]
            val = _value(acc)
            if val is not None:
                item["value"] = val
            flags = [s for s in states if s not in ("showing", "sensitive")]
            if "sensitive" not in states:
                flags.append("disabled")
            if flags:
                item["state"] = flags
            acts = [a for a in _actions(acc) if a.lower() in STANDARD_ACTIONS]
            if acts:
                item["actions"] = acts[:4]
            items.append(item)
        try:
            n = acc.get_child_count()
        except Exception:  # noqa: BLE001
            return
        here = (
            f"{path} › {name}"
            if name and role in ("frame", "dialog", "window", "panel", "page tab", "menu", "tool bar")
            else path
        )
        for i in range(min(n, 400)):
            try:
                walk(acc.get_child_at_index(i), depth + 1, here)
            except Exception:  # noqa: BLE001
                continue

    walked: list[str] = []  # apps whose windows were read (lets the caller recognise browsers, AURA-92)
    for a in matched_apps or _apps():
        for i in range(a.get_child_count()):
            w = a.get_child_at_index(i)
            if w is None:
                continue
            title = w.get_name() or ""
            if want_win and want_win not in title.lower():
                continue
            if want_app and want_app not in (a.get_name() or "").lower() and want_app not in title.lower():
                continue
            walk(w, 0, f"{a.get_name()}: {title}")
            walked.append(a.get_name() or "")
    return {
        "count": len(items),
        "truncated": len(items) >= limit,
        "elements": items,
        "apps": sorted(set(walked)),
    }


def _node(p: dict) -> Atspi.Accessible:
    i = int(p.get("index", -1))
    if not 0 <= i < len(_nodes):
        raise ValueError(f"Index {i} unbekannt; erst ui_snapshot aufrufen.")
    return _nodes[i]


def read(p: dict) -> dict:
    acc = _node(p)
    return {
        "role": acc.get_role_name(),
        "name": acc.get_name(),
        "text": _text(acc),
        "value": _value(acc),
        "state": _states(acc),
    }


def act(p: dict) -> dict:
    acc = _node(p)
    names = _actions(acc)
    want = str(p.get("action") or "click").lower()
    aliases = {
        "click": ["click", "press", "activate", "toggle", "jump"],
        "press": ["press", "click", "activate"],
        "toggle": ["toggle", "click", "press"],
        "activate": ["activate", "click", "press"],
    }
    for candidate in aliases.get(want, [want]):
        if candidate in [n.lower() for n in names]:
            idx = [n.lower() for n in names].index(candidate)
            ok = Atspi.Action.do_action(acc, idx)
            return {"done": bool(ok), "action": names[idx], "element": acc.get_name(), "state": _states(acc)}
    try:
        if acc.get_component_iface() and Atspi.Component.grab_focus(acc):
            return {
                "done": False,
                "focused": True,
                "note": f"Keine passende Aktion ({names}); Element wurde fokussiert.",
            }
    except Exception:  # noqa: BLE001
        pass
    return {"done": False, "error": f"Element kann „{want}“ nicht. Mögliche Aktionen: {names or 'keine'}"}


def set_text(p: dict) -> dict:
    acc = _node(p)
    if not acc.get_editable_text_iface():
        return {"error": "Element ist kein Textfeld."}
    text = str(p.get("text", ""))
    ok = Atspi.EditableText.set_text_contents(acc, text)
    return {"done": bool(ok), "text": _text(acc)}


METHODS = {
    "apps": apps,
    "snapshot": snapshot,
    "act": act,
    "set_text": set_text,
    "read": read,
    "ping": lambda p: {"ok": True},
}


def main() -> None:
    for line in sys.stdin:
        if not line.strip():
            continue
        msg = None
        try:
            msg = json.loads(line)
            result = METHODS[msg["method"]](msg.get("params") or {})
            out = {"id": msg.get("id"), "result": result}
        except Exception as e:  # noqa: BLE001
            out = {
                "id": msg.get("id") if isinstance(msg, dict) else None,
                "error": f"{type(e).__name__}: {e}",
            }
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
