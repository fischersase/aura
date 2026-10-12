"""Dateien lesen und finden (T0). Schreiben, Ändern und Papierkorb kommen in Phase 2."""

from __future__ import annotations

import asyncio
import difflib
import fnmatch
import shutil
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from ..harness.tiers import Tier, TierFn, aura_tool
from ..platform.base import IS_WINDOWS
from ..platform.proc import spawn_kwargs
from ..policy.paths import path_tier
from ..runtime.context import current
from .paths import expand, show


def guarded(base: Tier | TierFn, *keys: str) -> TierFn:
  """Stufe mit Pfadsperre: berührt ein Pfad-Argument Zugangsdaten o. Ä., ist der Aufruf T3."""

  def tier(a: dict[str, Any]) -> Tier | tuple[Tier, str]:
    blocked = path_tier(*(expand(a.get(k) or "~", _home()) for k in keys))
    if blocked:
      return blocked
    return base(a) if callable(base) else base

  return tier


SKIP_DIRS = {"node_modules", "__pycache__", "site-packages", ".git", ".cache", "snap", ".venv", "venv", ".local", ".npm", ".cargo",
             # Windows: Programmdaten (riesig, ähnlich ~/.local) und alte Verknüpfungsordner
             "AppData", "$Recycle.Bin", "System Volume Information"}
TEXT_LIMIT = 20000


def _home() -> str:
  task = current()
  return task.home if task else str(Path.home())


@aura_tool(guarded(Tier.T0, "path"), label=lambda a: a.get("path") or "~")
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


@aura_tool(guarded(Tier.T0, "path"), label=lambda a: a.get("path", ""))
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
      return {"error": "PDF lesen braucht pdftotext " + ("(Poppler für Windows: winget install oschwartz10612.Poppler)."
                                                          if IS_WINDOWS else "(Paket poppler-utils).")}
    import subprocess

    text = subprocess.run(["pdftotext", "-layout", str(f), "-"], capture_output=True, timeout=60, check=False,
                          **spawn_kwargs(new_group=False)).stdout.decode(errors="replace")
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
        # Abzweigungen (Windows-Junctions wie „Eigene Dateien“) wie Symlinks behandeln: nicht hineinlaufen.
        is_dir = p.is_dir() and not p.is_symlink() and not p.is_junction()
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


@aura_tool(guarded(Tier.T0, "folder"), label=lambda a: " ".join(filter(None, [a.get("name"), a.get("contains") and f"„{a['contains']}“", a.get("folder") and f"in {a['folder']}"])) or "Dateien")
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
  found = [p for p in found if not path_tier(p)]
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


# ---------- Schreiben, ändern, verschieben, Papierkorb ----------

DIFF_LINES = 80


def _diff(old: str, new: str, name: str) -> str:
  lines = list(difflib.unified_diff(old.splitlines(), new.splitlines(), f"{name} (vorher)", f"{name} (nachher)", lineterm="", n=2))
  if len(lines) > DIFF_LINES:
    lines = lines[:DIFF_LINES] + [f"… ({len(lines) - DIFF_LINES} weitere Zeilen)"]
  return "\n".join(lines) or "(keine Änderung)"


def _write_tier(a: dict[str, Any]) -> tuple[Tier, str]:
  p = expand(a.get("path"), _home())
  if p.exists():
    return Tier.T2, "überschreibt eine vorhandene Datei"
  return Tier.T1, ""


def _write_effect(a: dict[str, Any]) -> str:
  p = expand(a.get("path"), _home())
  new = str(a.get("content", ""))
  if p.is_file():
    try:
      old = p.read_text(errors="replace")
    except OSError:
      old = ""
    if a.get("append"):
      new = old + new
    return _diff(old, new, show(p, _home()))
  return f"Neue Datei {show(p, _home())}:\n" + guard_clip(new, 1500)


def guard_clip(text: str, limit: int) -> str:
  return text if len(text) <= limit else text[:limit] + f"\n… ({len(text) - limit} Zeichen mehr)"


@aura_tool(guarded(_write_tier, "path"), label=lambda a: ("+ " if a.get("append") else "") + str(a.get("path", "")), effect=_write_effect)
def write_file(path: str, content: str, append: bool = False) -> dict[str, Any]:
  """Schreibt Text in eine Datei. Legt sie an; eine vorhandene Datei wird nur nach Freigabe ersetzt.

  Für kleine Änderungen an vorhandenen Dateien edit_file nutzen.

  Args:
    path: Zieldatei, z. B. "~/Dokumente/notiz.txt".
    content: Der Text.
    append: true = am Ende anhängen statt ersetzen.
  """
  p = expand(path, _home())
  if p.is_dir():
    return {"error": f"Das ist ein Ordner: {show(p, _home())}"}
  p.parent.mkdir(parents=True, exist_ok=True)
  if append:
    with p.open("a", encoding="utf-8") as f:
      f.write(content)
  else:
    p.write_text(content, encoding="utf-8")
  text = p.read_text(encoding="utf-8", errors="replace")
  ok = text.endswith(content) if append else text == content
  return {"path": show(p, _home()), "bytes": p.stat().st_size, "verified": ok}


def _edit_effect(a: dict[str, Any]) -> str:
  p = expand(a.get("path"), _home())
  try:
    old = p.read_text(errors="replace")
  except OSError:
    return f"Datei nicht lesbar: {show(p, _home())}"
  return _diff(old, old.replace(str(a.get("old_text", "")), str(a.get("new_text", "")), 1), show(p, _home()))


@aura_tool(guarded(Tier.T2, "path"), label=lambda a: str(a.get("path", "")), effect=_edit_effect)
def edit_file(path: str, old_text: str, new_text: str) -> dict[str, Any]:
  """Ersetzt in einer Textdatei genau eine Stelle. old_text muss genau einmal vorkommen (mit etwas Umgebung eindeutig machen).

  Args:
    path: Die Datei.
    old_text: Der Text, der ersetzt wird, genau wie in der Datei.
    new_text: Der neue Text.
  """
  p = expand(path, _home())
  if not p.is_file():
    return {"error": f"Datei nicht gefunden: {show(p, _home())}"}
  text = p.read_text(encoding="utf-8", errors="replace")
  n = text.count(old_text) if old_text else 0
  if n != 1:
    return {"error": f"old_text kommt {n}× vor, muss genau einmal vorkommen." + (" Lies die Datei vorher mit read_file." if n == 0 else " Nimm mehr Umgebung dazu.")}
  new = text.replace(old_text, new_text, 1)
  p.write_text(new, encoding="utf-8")
  return {"path": show(p, _home()), "verified": p.read_text(encoding="utf-8", errors="replace") == new}


@aura_tool(guarded(Tier.T2, "path"), label=lambda a: str(a.get("path", "")), effect=lambda a: f"In den Papierkorb (wiederherstellbar): {a.get('path', '')}")
async def trash(path: str) -> dict[str, Any]:
  """Verschiebt eine Datei oder einen Ordner in den Papierkorb (wiederherstellbar). Endgültiges Löschen gibt es bewusst nicht.

  Args:
    path: Datei oder Ordner.
  """
  p = expand(path, _home())
  if not p.exists() and not p.is_symlink():
    return {"error": f"Gibt es nicht: {show(p, _home())}"}
  if p == Path(_home()) or p == Path("/") or len(p.parts) <= 2:
    return {"error": "Diesen Ordner wirft Aura nicht in den Papierkorb."}
  if IS_WINDOWS:
    from ..platform.win_shell import recycle

    err = await asyncio.to_thread(recycle, str(p))
    if err:
      return {"error": err}
    return {"trashed": show(p, _home()), "verified": not p.exists(), "restore": "Im Papierkorb von Windows wiederherstellbar."}
  proc = await asyncio.create_subprocess_exec("gio", "trash", str(p), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
  out, _ = await proc.communicate()
  if proc.returncode:
    return {"error": out.decode(errors="replace").strip() or "gio trash fehlgeschlagen"}
  return {"trashed": show(p, _home()), "verified": not p.exists(), "restore": "Im Papierkorb von Dateien (Nautilus) wiederherstellbar."}


def _target(src: Path, dst: Path, raw: str) -> Path:
  """Ziel einer Verschiebung. Ein noch nicht vorhandenes Ziel ohne Endung (oder mit / am Ende) ist ein Ordner,
  wenn die Quelle eine Datei mit Endung ist: „a.pdf nach ~/Downloads/PDFs“ meint den Ordner PDFs."""
  if dst.is_dir():
    return dst / src.name
  if not dst.exists() and (raw.endswith("/") or (not dst.suffix and src.suffix)):
    return dst / src.name
  return dst


def _move_tier(a: dict[str, Any]) -> tuple[Tier, str]:
  dst = expand(a.get("destination"), _home())
  src = expand(a.get("source"), _home())
  target = _target(src, dst, str(a.get("destination", "")))
  if target.exists():
    return Tier.T2, "überschreibt ein vorhandenes Ziel"
  return Tier.T1, ""


@aura_tool(guarded(_move_tier, "source", "destination"), label=lambda a: f"{'kopieren' if a.get('copy') else 'verschieben'}: {a.get('source', '')} → {a.get('destination', '')}")
def move_path(source: str, destination: str, copy: bool = False) -> dict[str, Any]:
  """Verschiebt oder kopiert eine Datei oder einen Ordner. Ist das Ziel ein Ordner, landet die Quelle darin.

  Args:
    source: Quelle.
    destination: Ziel (Datei- oder Ordnerpfad).
    copy: true = kopieren statt verschieben.
  """
  src = expand(source, _home())
  dst = expand(destination, _home())
  if not src.exists():
    return {"error": f"Quelle gibt es nicht: {show(src, _home())}"}
  target = _target(src, dst, destination)
  target.parent.mkdir(parents=True, exist_ok=True)
  if copy:
    if src.is_dir():
      shutil.copytree(src, target, dirs_exist_ok=True)
    else:
      shutil.copy2(src, target)
  else:
    shutil.move(str(src), str(target))
  ok = target.exists() and (copy or not src.exists())
  return {"result": show(target, _home()), "verified": ok}
