"""Skills im Agent-Skills-Format (agentskills.io), wie src/agent/skills.js.

Ordner mit SKILL.md (oben name + description) in ~/.aura/skills und ~/.agents/skills.
Das Modell sieht nur Name und Beschreibung und lädt den Rest bei Bedarf mit activate_skill.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..harness.tiers import Tier, aura_tool
from ..runtime.context import current

_FRONT = re.compile(r"^﻿?---\r?\n(.*?)\r?\n---\r?\n?", re.DOTALL)


@dataclass
class Skill:
  name: str
  description: str
  dir: Path
  file: Path


def frontmatter(text: str) -> tuple[dict[str, str], str]:
  m = _FRONT.match(text)
  if not m:
    return {}, text
  meta: dict[str, str] = {}
  key = None
  for line in m.group(1).splitlines():
    kv = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
    if kv:
      key = kv.group(1)
      meta[key] = re.sub(r"^[>|]-?$", "", kv.group(2).strip().strip("\"'"))
    elif key and re.match(r"^\s+\S", line):
      meta[key] = (meta[key] + " " if meta[key] else "") + line.strip()
  return meta, text[m.end():]


def skill_dirs(aura_dir: Path) -> list[Path]:
  return [aura_dir / "skills", Path.home() / ".agents" / "skills"]


def list_skills(aura_dir: Path, disabled: set[str] | None = None) -> list[Skill]:
  seen: dict[str, Skill] = {}
  for d in skill_dirs(aura_dir):
    if not d.is_dir():
      continue
    for entry in sorted(d.iterdir()):
      f = entry / "SKILL.md"
      if not f.is_file():
        continue
      try:
        meta, _ = frontmatter(f.read_text(encoding="utf-8"))
      except OSError:
        continue
      name = (meta.get("name") or entry.name).strip()
      if name not in seen and name not in (disabled or set()):
        seen[name] = Skill(name, (meta.get("description") or "").strip()[:500], entry, f)
  return list(seen.values())


def prompt_addon(skills: list[Skill]) -> str:
  if not skills:
    return ""
  return ("## Skills\nWenn ein Skill zur Aufgabe passt, lade ihn zuerst mit activate_skill und folge seinen Anweisungen.\n"
          + "\n".join(f"- {s.name}: {s.description}" for s in skills))


def make_activate_skill(skills: list[Skill]):
  by_name = {s.name: s for s in skills}

  @aura_tool(Tier.T0, label=lambda a: str(a.get("name", "")))
  def activate_skill(name: str) -> dict[str, Any]:
    """Lädt die Anweisungen eines Skills (siehe Liste der Skills in deiner Anweisung).

    Args:
      name: Name des Skills.
    """
    s = by_name.get(name)
    if not s:
      return {"error": f"Skill „{name}“ gibt es nicht. Verfügbar: {', '.join(by_name) or 'keine'}"}
    _, body = frontmatter(s.file.read_text(encoding="utf-8"))
    files = [str(p.relative_to(s.dir)) for p in sorted(s.dir.rglob("*")) if p.is_file() and p.name != "SKILL.md"][:50]
    task = current()
    if task:
      task.audit.write("skill_activated", task=task.task_id, skill=name)
    return {"skill": s.name, "folder": str(s.dir), "instructions": body[:30000], "files": files,
            "note": "Pfade in den Anweisungen beziehen sich auf den Skill-Ordner. Weitere Dateien mit read_file lesen; "
                    "Skripte nur über run_command."}

  return activate_skill
