"""Reparatur von Werkzeugaufrufen lokaler Modelle.

Lokale Modelle (gemma4, qwen) liefern Werkzeugaufrufe nicht immer sauber:
falsch geschriebene Namen, Argumente als kaputtes JSON oder Aufrufe als Text
statt im tool_calls-Feld. Dieses Modul macht daraus gültige Aufrufe oder
meldet, dass es nicht geht. Jede Reparatur wird gezählt, damit der Benchmark
die Zuverlässigkeit je Modell messen kann.
"""

from __future__ import annotations

import difflib
import json
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

import json_repair

STATS: Counter[str] = Counter()

NAME_CUTOFF = 0.85

_TAGGED = re.compile(r"<tool_call>\s*(.*?)\s*</tool_call>", re.DOTALL)
_FENCED = re.compile(r"```(?:json|tool_code|tool_call)?\s*(\{.*?\})\s*```", re.DOTALL)


@dataclass
class ParsedCall:
    name: str
    args: dict[str, Any] = field(default_factory=dict)


def resolve_name(name: str | None, known: list[str]) -> str | None:
    """Findet den gemeinten Werkzeugnamen oder None."""
    if not name:
        return None
    if name in known:
        return name
    lowered = {k.lower(): k for k in known}
    key = name.strip().lower().replace("-", "_").replace(" ", "_")
    for prefix in ("functions.", "function.", "tools.", "default_api."):
        key = key.removeprefix(prefix)
    if key in lowered:
        STATS["name_normalized"] += 1
        return lowered[key]
    close = difflib.get_close_matches(key, list(lowered), n=1, cutoff=NAME_CUTOFF)
    if close:
        STATS["name_fuzzy"] += 1
        return lowered[close[0]]
    return None


def parse_args(raw: Any) -> dict[str, Any] | None:
    """Argumente als dict; repariert kaputtes JSON. None, wenn nichts zu retten ist."""
    if raw is None or raw == "":
        return {}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            val = json.loads(raw)
        except json.JSONDecodeError:
            val = json_repair.loads(raw)
            STATS["args_repaired"] += 1
        if isinstance(val, dict):
            return val
    return None


def _call_from_obj(obj: Any, known: list[str]) -> ParsedCall | None:
    if not isinstance(obj, dict):
        return None
    inner = obj.get("function")
    fn: dict[str, Any] = inner if isinstance(inner, dict) else obj
    name = resolve_name(fn.get("name"), known)
    if not name:
        return None
    args = parse_args(fn.get("arguments", fn.get("parameters", fn.get("args"))))
    if args is None:
        return None
    return ParsedCall(name, args)


def extract_text_calls(text: str, known: list[str]) -> tuple[list[ParsedCall], str]:
    """Zieht Werkzeugaufrufe aus dem Antworttext. Gibt (Aufrufe, Resttext) zurück."""
    if not text or not known:
        return [], text
    calls: list[ParsedCall] = []
    rest = text
    for pattern in (_TAGGED, _FENCED):
        for m in list(pattern.finditer(rest)):
            obj = json_repair.loads(m.group(1))
            call = _call_from_obj(obj, known)
            if call:
                calls.append(call)
                rest = rest.replace(m.group(0), "")
    stripped = rest.strip()
    if not calls and stripped.startswith("{") and stripped.endswith("}"):
        call = _call_from_obj(json_repair.loads(stripped), known)
        if call:
            calls.append(call)
            rest = ""
    if calls:
        STATS["text_calls_extracted"] += len(calls)
    return calls, rest.strip()


def coerce_types(args: dict[str, Any], schema: dict[str, Any] | None) -> dict[str, Any]:
    """Passt einfache Typen ans Schema an ("5" -> 5, "true" -> True)."""
    props = (schema or {}).get("properties") or {}
    out = dict(args)
    for key, val in args.items():
        want = (props.get(key) or {}).get("type")
        if not isinstance(val, str) or want in (None, "string"):
            continue
        try:
            if want == "integer":
                out[key] = int(val)
            elif want == "number":
                out[key] = float(val)
            elif want == "boolean" and val.lower() in ("true", "false"):
                out[key] = val.lower() == "true"
            elif want in ("object", "array"):
                out[key] = json_repair.loads(val)
            else:
                continue
            STATS["types_coerced"] += 1
        except (ValueError, TypeError):
            pass
    return out
