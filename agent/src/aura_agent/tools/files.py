"""Dateien lesen und finden (T0). Schreiben, Ändern und Papierkorb kommen in Phase 2."""

from __future__ import annotations

import asyncio
import fnmatch
import shutil
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from ..harness.tiers import Tier, aura_tool
from ..runtime.context import current
from .paths import expand, show

SKIP_DIRS = {"node_modules", "__pycache__", "site-packages", ".git", ".cache", "snap", ".venv", "venv", ".local", ".npm", ".cargo"}
TEXT_LIMIT = 20000


def _home() -> str:
  task = current()
  return task.home if task else str(Path.home())


@aura_tool(Tier.T0, label=lambda a: a.get("path") or "~")
def list_dir(path: str = "~") -> dict[str, Any]:
  """Listet den Inhalt eines Ordners (Name, Größe, Änderungsdatum).

  Args:
    path: Ordner, z. B. "~/Downloads" oder "Dokumente". Relative Pfade gelten ab dem Benutzerordner.
  """
  d = expand(path, _home())
  if not d.is_dir():
    return {"error": f"Kein Ordner: {show(d, _home())}"}
  items = []
  entries = sorted(d.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
  for p in entries[:300]:
    try:
      st = p.stat()
    except OSError:
      continue
    items.append({"name": p.name + ("/" if p.is_dir() else ""), **({} if p.is_dir() else {"size": st.st_size}),
                  "modified": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M")})
  return {"path": show(d, _home()), "count": len(entries), "items": items}


@aura_tool(Tier.T0, label=lambda a: a.get("path", ""))
def read_file(path: str, offset: int = 0) -> dict[str, Any]:
  """Liest eine Textdatei oder ein PDF (bis 20.000 Zeichen pro Aufruf).

  Args:
    path: Datei, z. B. "~/notizen.txt".
    offset: Ab diesem Zeichen weiterlesen (für lange Dateien).
  """
  f = expand(path, _home())
  if f.is_dir():
    return list_dir(str(f))
  if not f.exists():
    return {"error": f"Datei nicht gefunden: {show(f, _home())}"}
  if f.suffix.lower() == ".pdf":
    if not shutil.which("pdftotext"):
      return {"error": "PDF lesen braucht pdftotext (Paket poppler-utils)."}
    import subprocess

    text = subprocess.run(["pdftotext", "-layout", str(f), "-"], capture_output=True, timeout=60, check=False).stdout.decode(errors="replace")
  else:
    if f.stat().st_size > 20 * 1024 * 1024:
      return {"error": f"Datei ist zu groß ({f.stat().st_size // 1048576} MB)."}
    raw = f.read_bytes()
    if b"\0" in raw[:8000]:
      return {"error": "Das ist keine Textdatei.", "size": raw.__len__()}
    text = raw.decode("utf-8", errors="replace")
  start = max(0, int(offset or 0))
  chunk = text[start:start + TEXT_LIMIT]
  out: dict[str, Any] = {"path": show(f, _home()), "total_chars": len(text), "content": chunk}
  if start + len(chunk) < len(text):
    out["more"] = f"Weiter mit offset {start + len(chunk)}"
  return out


def _matcher(name: str):
  q = (name or "").strip().lower()
  if not q:
    return lambda n: True
  if any(c in q for c in "*?["):
    return lambda n: fnmatch.fnmatch(n.lower(), q)
  words = q.split()
  return lambda n: all(w in n.lower() for w in words)


def _search(root: Path, name: str, contains: str, limit: int, deadline: float) -> tuple[list[Path], bool]:
  match = _matcher(name)
  needle = (contains or "").lower()
  found: list[Path] = []
  queue = [root]
  while queue and len(found) < limit:
    if time.monotonic() > deadline:
      return found, True
    d = queue.pop(0)
    try:
      entries = list(d.iterdir())
    except OSError:
      continue
    for p in entries:
      try:
        is_dir = p.is_dir() and not p.is_symlink()
      except OSError:
        continue
      if is_dir:
        if not p.name.startswith(".") and p.name not in SKIP_DIRS:
          queue.append(p)
        if not needle and name and match(p.name):
          found.append(p)
      elif match(p.name):
        if needle:
          try:
            if p.stat().st_size > 2 * 1024 * 1024 or needle not in p.read_text(errors="ignore").lower():
              continue
          except OSError:
            continue
        found.append(p)
      if len(found) >= limit:
        break
  return found, False


@aura_tool(Tier.T0, label=lambda a: " ".join(filter(None, [a.get("name"), a.get("contains") and f"„{a['contains']}“", a.get("folder") and f"in {a['folder']}"])) or "Dateien")
async def find_files(name: str = "", folder: str = "~", contains: str = "", max_results: int = 30) -> dict[str, Any]:
  """Sucht Dateien und Ordner nach Namen (Teilwörter oder Muster wie *.pdf), optional nur Dateien mit bestimmtem Text.

  Args:
    name: Teil des Namens oder Muster, z. B. "rechnung" oder "*.docx".
    folder: Wo gesucht wird, z. B. "~/Dokumente" (Standard: Benutzerordner).
    contains: Nur Textdateien, die diesen Text enthalten.
    max_results: Höchstzahl Treffer (Standard 30, höchstens 200).
  """
  root = expand(folder, _home())
  if not root.is_dir():
    return {"error": f"Kein Ordner: {show(root, _home())}"}
  limit = max(1, min(int(max_results or 30), 200))
  found, partial = await asyncio.to_thread(_search, root, name, contains, limit, time.monotonic() + 15)
  results = []
  for p in found:
    try:
      st = p.stat()
      results.append({"path": show(p, _home()) + ("/" if p.is_dir() else ""), "modified": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
                      **({} if p.is_dir() else {"size": st.st_size})})
    except OSError:
      results.append({"path": show(p, _home())})
  out: dict[str, Any] = {"folder": show(root, _home()), "count": len(results), "results": results}
  if partial:
    out["note"] = "Suche nach 15 s abgebrochen, Ergebnis unvollständig. Ordner genauer angeben."
  return out
