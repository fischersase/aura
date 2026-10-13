"""Audit-Protokoll: nur anhängend, jede Zeile mit dem Hash der vorigen verkettet.

Eine Datei pro Monat unter <data_dir>/audit/YYYY-MM.jsonl. Wird eine Zeile
nachträglich verändert oder gelöscht, bricht die Kette und verify() meldet es.
Lange Werte werden gekürzt. Geschwärzt werden Felder mit Zugangsdaten im Namen und Zugangsdaten innerhalb von
Werten (AURA-17), z. B. ein Bearer-Token in einem curl-Befehl oder ein Passwort-Schalter.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

GENESIS = "0" * 64
MAX_VALUE = 500
_SECRET_KEY = re.compile(r"pass(word)?|secret|token|api[_-]?key|credential|cookie", re.IGNORECASE)


# (Muster, Ersetzung) für Zugangsdaten innerhalb von Texten
_VALUE_PATTERNS = [
    (
        re.compile(
            r"(?i)\b((?:proxy-)?authorization\s*[:=]\s*)(?:(?:bearer|basic|token|digest)\s+)?[^\s'\"]+"
        ),
        r"\1***",
    ),
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}"), r"\1 ***"),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{20,}"), "***"),
    (re.compile(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}"), "***"),
    (re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"), "***"),
    (re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}"), "***"),
    (re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"), "***"),
    (re.compile(r"\b(?:glpat|hf)_[A-Za-z0-9_-]{20,}"), "***"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), "***"),  # JWT
    (
        re.compile(r"(?i)(--?(?:password|passwd|pass|token|api[-_]?key|secret|client-secret)(?:=|\s+))\S+"),
        r"\1***",
    ),
    (re.compile(r"(?i)\b((?:mysql|mysqldump|mariadb)\b[^|;\n]*?\s-p)(?!\s)\S+"), r"\1***"),
    (re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@"), r"\1***:***@"),  # Zugangsdaten in URLs
    (
        re.compile(r"\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*)=(?!\*\*\*)\S+"),
        r"\1=***",
    ),
]
_TOKEN = re.compile(r"[A-Za-z0-9+/=_-]{32,}")


def _entropy(s: str) -> float:
    counts = {c: s.count(c) for c in set(s)}
    return -sum(n / len(s) * math.log2(n / len(s)) for n in counts.values())


def scrub(text: str) -> str:
    """Schwärzt Zugangsdaten innerhalb eines Textes. Lange Zufallsfolgen (≥ 32 Zeichen, hohe Entropie) gelten als
    Schlüssel; Hex-Hashes wie Commit-IDs bleiben lesbar (Entropie höchstens 4 Bit/Zeichen)."""
    for pattern, repl in _VALUE_PATTERNS:
        text = pattern.sub(repl, text)
    return _TOKEN.sub(lambda m: "***" if _entropy(m.group(0)) > 4.3 else m.group(0), text)


def redact(value: Any, key: str = "") -> Any:
    if key and _SECRET_KEY.search(key):
        return "***"
    if isinstance(value, dict):
        # str(k): JSON-like data may carry non-string keys, and the key check expects text.
        return {k: redact(v, str(k)) for k, v in cast("dict[Any, Any]", value).items()}
    if isinstance(value, list):
        return [redact(v) for v in cast("list[Any]", value)[:50]]
    if isinstance(value, str):
        value = scrub(value)
        if len(value) > MAX_VALUE:
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
            entry = {
                "ts": now.isoformat(timespec="milliseconds"),
                "kind": kind,
                **redact(fields),
                "prev": prev,
            }
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
