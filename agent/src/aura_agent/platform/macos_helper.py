"""macOS Accessibility Helper (JXA / System Events): spricht dasselbe Zeilenprotokoll wie atspi_helper.py und uia_helper.py."""

from __future__ import annotations

import json
import sys
from typing import Any

from .macos import run_osascript

ROLE_MAP = {
    "AXButton": "push button",
    "AXCheckBox": "check box",
    "AXRadioButton": "radio button",
    "AXTextField": "text",
    "AXTextArea": "text",
    "AXSearchField": "text",
    "AXSecureTextField": "password text",
    "AXMenuItem": "menu item",
    "AXMenuButton": "menu",
    "AXMenuBarItem": "menu",
    "AXPopUpButton": "combo box",
    "AXComboBox": "combo box",
    "AXSlider": "slider",
    "AXTabGroup": "page tab list",
    "AXStaticText": "label",
    "AXLink": "link",
}

_TARGETS: dict[int, dict[str, Any]] = {}


def _list_apps() -> dict[str, Any]:
    jxa = """
    const se = Application('System Events');
    const procs = se.applicationProcesses.whose({ backgroundOnly: false })();
    JSON.stringify(procs.map(p => { try { return p.name(); } catch (e) { return ''; } }).filter(Boolean));
    """
    code, raw = run_osascript(jxa, language="JavaScript", timeout=6.0)
    if code != 0:
        return {"error": raw or "macOS System Events nicht erreichbar."}
    try:
        apps = json.loads(raw)
    except ValueError:
        apps = []
    return {"apps": apps}


def _snapshot(app_query: str, window_query: str = "", limit: int = 250) -> dict[str, Any]:
    jxa = f"""
    const se = Application('System Events');
    const q = {json.dumps(app_query.lower())};
    const wq = {json.dumps(window_query.lower())};
    const maxItems = {int(limit)};
    const procs = se.applicationProcesses.whose({{ backgroundOnly: false }})();
    const matched = procs.filter(p => {{
      try {{ return p.name().toLowerCase().includes(q); }} catch (e) {{ return false; }}
    }});
    if (!matched.length) {{
      const names = procs.map(p => {{ try {{ return p.name(); }} catch (e) {{ return ''; }} }}).filter(Boolean);
      JSON.stringify({{ error: 'Kein Programm gefunden für ' + q, available_apps: names }});
    }} else {{
      const p = matched[0];
      const pName = p.name();
      const wins = p.windows();
      const elements = [];
      for (let wi = 0; wi < wins.length && elements.length < maxItems; wi++) {{
        const w = wins[wi];
        let wTitle = '';
        try {{ wTitle = w.name() || ''; }} catch (e) {{}}
        if (wq && !wTitle.toLowerCase().includes(wq)) continue;
        let all = [];
        try {{ all = w.entireContents(); }} catch (e) {{ all = []; }}
        for (let ei = 0; ei < all.length && elements.length < maxItems; ei++) {{
          const el = all[ei];
          try {{
            const role = el.role() || '';
            const name = el.name() || el.title() || el.description() || '';
            const val = el.value();
            if (!name && (val === null || val === undefined || val === '')) continue;
            elements.push({{
              proc: pName,
              winIdx: wi,
              elIdx: ei,
              role: String(role),
              name: String(name).slice(0, 120),
              text: val !== null && val !== undefined ? String(val).slice(0, 120) : ''
            }});
          }} catch (e) {{}}
        }}
      }}
      JSON.stringify({{ apps: [pName], elements }});
    }}
    """
    code, raw = run_osascript(jxa, language="JavaScript", timeout=12.0)
    if code != 0 or not raw:
        return {"error": raw or "Konnte Bedienelemente unter macOS nicht lesen."}
    try:
        data = json.loads(raw)
    except ValueError:
        return {"error": "Ungültige Antwort von System Events."}
    if data.get("error"):
        return data
    _TARGETS.clear()
    out_elements: list[dict[str, Any]] = []
    for idx, item in enumerate(data.get("elements") or [], start=1):
        role = ROLE_MAP.get(item.get("role", ""), item.get("role", "element"))
        _TARGETS[idx] = item
        entry: dict[str, Any] = {
            "index": idx,
            "role": role,
            "name": item.get("name", ""),
        }
        if item.get("text"):
            entry["text"] = item["text"]
        out_elements.append(entry)
    return {"apps": data.get("apps", []), "elements": out_elements}


def _act(index: int) -> dict[str, Any]:
    target = _TARGETS.get(index)
    if not target:
        return {"error": f"Index {index} nicht gefunden."}
    jxa = f"""
    const se = Application('System Events');
    const p = se.applicationProcesses.byName({json.dumps(target["proc"])});
    const w = p.windows()[{int(target["winIdx"])}];
    const el = w.entireContents()[{int(target["elIdx"])}];
    el.actions.byName('AXPress').perform();
    JSON.stringify({{ done: true }});
    """
    code, raw = run_osascript(jxa, language="JavaScript", timeout=6.0)
    if code != 0:
        return {"error": raw or "Aktion fehlgeschlagen."}
    return {"done": True}


def _set_text(index: int, text: str) -> dict[str, Any]:
    target = _TARGETS.get(index)
    if not target:
        return {"error": f"Index {index} nicht gefunden."}
    jxa = f"""
    const se = Application('System Events');
    const p = se.applicationProcesses.byName({json.dumps(target["proc"])});
    const w = p.windows()[{int(target["winIdx"])}];
    const el = w.entireContents()[{int(target["elIdx"])}];
    el.value = {json.dumps(text)};
    JSON.stringify({{ text: String(el.value()) }});
    """
    code, raw = run_osascript(jxa, language="JavaScript", timeout=6.0)
    if code != 0:
        return {"error": raw or "Text setzen fehlgeschlagen."}
    try:
        return json.loads(raw)
    except ValueError:
        return {"text": text}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg: dict[str, Any] | None = None
        try:
            msg = json.loads(line)
            if not isinstance(msg, dict):
                raise TypeError("JSON-Objekt erwartet")
            op = msg.get("op")
            if op == "apps":
                res = _list_apps()
            elif op == "snapshot":
                res = _snapshot(str(msg.get("app", "")), str(msg.get("window", "")), int(msg.get("max", 250)))
            elif op == "act":
                res = _act(int(msg["index"]))
            elif op == "set_text":
                res = _set_text(int(msg["index"]), str(msg.get("text", "")))
            else:
                res = {"error": f"Unbekannte Operation: {op}"}
        except Exception as e:  # noqa: BLE001
            res = {"error": f"{type(e).__name__}: {e}"}
        req_id = msg.get("id") if isinstance(msg, dict) else None
        sys.stdout.write(json.dumps({"id": req_id, **res}, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
