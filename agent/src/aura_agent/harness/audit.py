"""Audit-Protokoll: nur anhängend, jede Zeile mit dem Hash der vorigen verkettet.

Eine Datei pro Monat unter <data_dir>/audit/YYYY-MM.jsonl. Wird eine Zeile
nachträglich verändert oder gelöscht, bricht die Kette und verify() meldet es.
Lange Werte werden gekürzt, Felder mit Zugangsdaten geschwärzt.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

GENESIS = "0" * 64
MAX_VALUE = 500
_SECRET_KEY = re.compile(r"pass(word)?|secret|token|api[_-]?key|credential|cookie", re.IGNORECASE)


def redact(value: Any, key: str = "") -> Any:
  if key and _SECRET_KEY.search(key):
    return "***"
  if isinstance(value, dict):
    return {k: redact(v, k) for k, v in value.items()}
  if isinstance(value, list):
    return [redact(v) for v in value[:50]]
  if isinstance(value, str) and len(value) > MAX_VALUE:
    return value[:MAX_VALUE] + f"… ({len(value)} Zeichen)"
  return value


def _digest(prev: str, body: str) -> str:
  return hashlib.sha256((prev + body).encode()).hexdigest()


class AuditLog:
  def __init__(self, directory: Path) -> None:
    self.dir = directory
    self.dir.mkdir(parents=True, exist_ok=True)
    self._lock = threading.Lock()

  def _file(self, now: datetime) -> Path:
    return self.dir / f"{now:%Y-%m}.jsonl"

  @staticmethod
  def _last_hash(path: Path) -> str:
    if not path.exists() or path.stat().st_size == 0:
      return GENESIS
    with path.open("rb") as f:
      f.seek(max(0, path.stat().st_size - 65536))
      lines = [ln for ln in f.read().splitlines() if ln.strip()]
    try:
      return json.loads(lines[-1])["hash"]
    except (IndexError, KeyError, json.JSONDecodeError):
      return GENESIS

  def write(self, kind: str, **fields: Any) -> dict[str, Any]:
    now = datetime.now(UTC)
    with self._lock:
      path = self._file(now)
      prev = self._last_hash(path)
      entry = {"ts": now.isoformat(timespec="milliseconds"), "kind": kind, **redact(fields), "prev": prev}
      body = json.dumps(entry, ensure_ascii=False, sort_keys=True, default=str)
      entry["hash"] = _digest(prev, body)
      with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
    return entry

  @staticmethod
  def verify(path: Path) -> tuple[bool, int]:
    """Prüft die Kette. Gibt (ok, Anzahl geprüfter Zeilen) zurück."""
    prev = GENESIS
    n = 0
    for line in path.read_text(encoding="utf-8").splitlines():
      if not line.strip():
        continue
      entry = json.loads(line)
      want = entry.pop("hash", None)
      if entry.get("prev") != prev:
        return False, n
      body = json.dumps(entry, ensure_ascii=False, sort_keys=True, default=str)
      if _digest(prev, body) != want:
        return False, n
      prev = want
      n += 1
    return True, n
