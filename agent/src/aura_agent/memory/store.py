"""Gedächtnis des Agenten.

1. ~/.aura/memory/MEMORY.md: Fakten, die Aura sich merkt (vom Agenten geschrieben, vom Nutzer lesbar
   und bearbeitbar). Steht bei jeder Anfrage in der Anweisung. Höchstens 150 Zeilen; ältere Einträge
   wandern nach ~/.aura/memory/archiv.md (über recall weiter auffindbar).
2. Frühere Gespräche: SQLite-Volltextsuche (ADK SqliteMemoryService) über alle Chats.

Geheimnisse (Passwörter, PINs, Schlüssel, Kontonummern) werden nie gespeichert.
"""

from __future__ import annotations

import re
import threading
from datetime import datetime
from pathlib import Path

MAX_INDEX_LINES = 150
SECRET = re.compile(r"passw|kennwort|\bpin\b|\btan\b|api[ -_]?key|token|secret|geheim|\biban\b|kreditkart|credit card|cvv|"
                    r"\bsk-[a-z0-9]|-----begin", re.IGNORECASE)
HEADER = "# Aura-Gedächtnis\n\nDinge, die Aura sich über dich und deinen Rechner gemerkt hat. Du kannst die Datei frei bearbeiten.\n"


class MemoryFiles:
  def __init__(self, aura_dir: Path) -> None:
    self.dir = aura_dir / "memory"
    self.index = self.dir / "MEMORY.md"
    self.archive = self.dir / "archiv.md"
    self._lock = threading.Lock()

  def read_index(self) -> str:
    try:
      return self.index.read_text(encoding="utf-8")
    except OSError:
      return ""

  def prompt(self) -> str:
    lines = [ln for ln in self.read_index().splitlines() if ln.strip().startswith(("- ", "## "))]
    return "\n".join(lines[:MAX_INDEX_LINES])

  def remember(self, fact: str, topic: str = "Allgemein") -> dict:
    fact = " ".join(fact.split()).strip()
    topic = " ".join((topic or "Allgemein").split())[:40] or "Allgemein"
    if not fact:
      return {"error": "Leerer Eintrag."}
    if SECRET.search(fact):
      return {"error": "Passwörter, PINs, Schlüssel oder Kontodaten speichert Aura nicht im Gedächtnis."}
    with self._lock:
      self.dir.mkdir(parents=True, exist_ok=True)
      text = self.read_index() or HEADER
      if fact.lower() in text.lower():
        return {"ok": True, "note": "Stand schon im Gedächtnis."}
      entry = f"- {fact} ({datetime.now():%d.%m.%Y})"
      heading = f"## {topic}"
      lines = text.rstrip("\n").splitlines()
      if heading in lines:
        i = lines.index(heading) + 1
        while i < len(lines) and lines[i].startswith("- "):
          i += 1
        lines.insert(i, entry)
      else:
        lines += ["", heading, entry]
      self._rotate(lines)
      self.index.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {"ok": True, "saved": entry[2:], "topic": topic, "file": str(self.index)}

  def _rotate(self, lines: list[str]) -> None:
    """Hält MEMORY.md kurz: die ältesten Einträge gehen ins Archiv."""
    entries = [i for i, ln in enumerate(lines) if ln.startswith("- ")]
    excess = len(entries) - MAX_INDEX_LINES
    if excess <= 0:
      return
    moved = [lines[i] for i in entries[:excess]]
    for i in reversed(entries[:excess]):
      del lines[i]
    with self.archive.open("a", encoding="utf-8") as f:
      f.write("\n".join(moved) + "\n")

  def forget(self, text: str) -> dict:
    with self._lock:
      lines = self.read_index().splitlines()
      keep = [ln for ln in lines if not (ln.startswith("- ") and text.lower() in ln.lower())]
      removed = len(lines) - len(keep)
      if removed:
        self.index.write_text("\n".join(keep) + "\n", encoding="utf-8")
    return {"removed": removed}

  def search(self, query: str, limit: int = 10) -> list[str]:
    """Einträge nach Zahl passender Wörter (Wortgrenzen; Zahlen zählen mit)."""
    words = [w for w in re.findall(r"\w+", query.lower()) if len(w) > 2 or w.isdigit()]
    if not words:
      return []
    patterns = [re.compile(rf"\b{re.escape(w)}\b") for w in words]
    scored: list[tuple[int, int, str]] = []
    n = 0
    for f in (self.index, self.archive):
      try:
        lines = f.read_text(encoding="utf-8").splitlines()
      except OSError:
        continue
      for ln in lines:
        if ln.startswith("- "):
          score = sum(bool(p.search(ln.lower())) for p in patterns)
          if score:
            scored.append((-score, n, ln[2:]))
          n += 1
    return [text for _, _, text in sorted(scored)[:limit]]
