"""Regelwerk: was ohne Rückfrage laufen darf, was immer fragt und was gesperrt ist.

Regeln stehen in ~/.aura/policy.toml (vom Nutzer oder über „Immer erlauben“) und
kommen aus den alten Werkzeugregeln der Zentrale (toolPolicy). Auswertung nach
der Stufe des Aufrufs, Rangfolge: deny vor ask vor allow.

- deny: sperrt, auch T0.
- ask: fragt, auch bei T0/T1.
- allow: erspart die Rückfrage bei T2.
- T3 (Zugangsdaten, Zerstörerisches) kann keine Regel freigeben.

Format:
  [[rule]]
  tool = "run_command"          # Werkzeugname, * und ? erlaubt
  match = "^git (pull|fetch)\\b"  # optional: regulärer Ausdruck auf die Beschreibung (bei Befehlen: der Befehl)
  decision = "allow"            # allow | ask | deny
  note = "von mir"              # optional
"""

from __future__ import annotations

import fnmatch
import logging
import re
import threading
import tomllib
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from ..harness.tiers import Tier

log = logging.getLogger(__name__)

DECISIONS = ("allow", "ask", "deny")
RANK = {"deny": 3, "ask": 2, "allow": 1}

# Werkzeugnamen des alten Agenten → neue Namen (für die Übernahme von toolPolicy).
V1_NAMES = {
    "run_command": ["run_command"], "write_file": ["write_file", "edit_file"], "read_file": ["read_file"],
    "find_files": ["find_files"], "list_folder": ["list_dir"], "open": ["open_target", "launch_app"],
}
V1_DECISION = {"auto": "allow", "ask": "ask", "off": "deny"}


@dataclass(frozen=True)
class Rule:
  tool: str
  decision: str
  match: str = ""
  source: str = ""
  note: str = ""

  def applies(self, tool: str, label: str) -> bool:
    if not fnmatch.fnmatchcase(tool, self.tool):
      return False
    if not self.match:
      return True
    try:
      return re.search(self.match, label) is not None
    except re.error:
      return False

  def describe(self) -> str:
    return f"{self.decision} {self.tool}" + (f" /{self.match}/" if self.match else "") + (f" ({self.source})" if self.source else "")


@dataclass(frozen=True)
class Verdict:
  decision: str  # "auto" | "ask" | "deny"
  rule: Rule | None = None


class PolicyEngine:
  def __init__(self, file: Path | None = None, tool_policy: dict[str, str] | None = None) -> None:
    self.file = file
    self._lock = threading.Lock()
    self.rules: list[Rule] = []
    for v1_tool, decision in (tool_policy or {}).items():
      mapped = V1_DECISION.get(decision)
      for name in V1_NAMES.get(v1_tool, [v1_tool]):
        if mapped:
          self.rules.append(Rule(tool=name, decision=mapped, source="Zentrale"))
    self.rules.extend(self._load())

  def _load(self) -> list[Rule]:
    if not self.file or not self.file.exists():
      return []
    try:
      data = tomllib.loads(self.file.read_text(encoding="utf-8"))
    except (tomllib.TOMLDecodeError, OSError) as e:
      log.warning("policy.toml unlesbar, Regeln ignoriert: %s", e)
      return []
    out = []
    for r in data.get("rule", []):
      if isinstance(r, dict) and r.get("decision") in DECISIONS and r.get("tool"):
        out.append(Rule(tool=str(r["tool"]), decision=r["decision"], match=str(r.get("match", "")), source="policy.toml",
                        note=str(r.get("note", ""))))
    return out

  def evaluate(self, tool: str, label: str, tier: Tier) -> Verdict:
    if tier >= Tier.T3:
      return Verdict("deny")
    hits = [r for r in self.rules if r.applies(tool, label)]
    top = max(hits, key=lambda r: RANK[r.decision], default=None)
    if top and top.decision == "deny":
      return Verdict("deny", top)
    if top and top.decision == "ask":
      return Verdict("ask", top)
    if tier >= Tier.T2:
      return Verdict("auto", top) if top and top.decision == "allow" else Verdict("ask")
    return Verdict("auto")

  def allow_always(self, tool: str, label: str) -> Rule:
    """Aus „Immer erlauben“: genau diesen Aufruf künftig ohne Rückfrage, dauerhaft in policy.toml."""
    rule = Rule(tool=tool, decision="allow", match="^" + re.escape(label) + "$", source="policy.toml",
                note=f"Immer erlauben, {datetime.now():%d.%m.%Y %H:%M}")
    with self._lock:
      self.rules.append(rule)
      if self.file:
        self.file.parent.mkdir(parents=True, exist_ok=True)
        with self.file.open("a", encoding="utf-8") as f:
          f.write(f"\n[[rule]]\ntool = {_toml_str(rule.tool)}\nmatch = {_toml_str(rule.match)}\n"
                  f"decision = \"allow\"\nnote = {_toml_str(rule.note)}\n")
    return rule

  def listing(self) -> list[dict[str, Any]]:
    return [{"tool": r.tool, "match": r.match, "decision": r.decision, "source": r.source, "note": r.note} for r in self.rules]


def _toml_str(s: str) -> str:
  return "'''" + s + "'''" if "'''" not in s and "\n" not in s else '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'
