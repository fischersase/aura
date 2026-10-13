"""Long-term memory of the agent (AURA-107, spec docs/specs/personal-agent.md §5.2).

1. Facts: ~/.aura/memory/facts.db (SQLite), one record per fact with provenance: where it came from (explicit,
   learned, imported, edited), chat and task, dates. ~/.aura/memory/MEMORY.md is a generated, human-readable view;
   edits to it (e.g. in the Zentrale) are imported back on the next access.
2. Earlier conversations: full-text search over all chats (ADK SqliteMemoryService, see tools/memory.py).

Only facts relevant to the current request go into the prompt (select_for_prompt), within a character budget.
Secrets (passwords, PINs, keys, account numbers) are never stored.
"""

from __future__ import annotations

import re
import sqlite3
import threading
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from datetime import datetime
from pathlib import Path
from typing import Any

MAX_FACTS = 2000  # NFR-PA-004: bounded; the least recently used go first
PROMPT_BUDGET = 1500  # characters of facts in the system prompt
PINNED_TOPIC = "Allgemein"
PINNED_BUDGET = 400
SOURCES = ("explicit", "learned", "imported", "edited")
SECRET = re.compile(
    r"passw|kennwort|\bpin\b|\btan\b|api[ -_]?key|token|secret|geheim|\biban\b|kreditkart|credit card|cvv|"
    r"\bsk-[a-z0-9]|-----begin",
    re.IGNORECASE,
)
HEADER = (
    "# Aura-Gedächtnis\n\n"
    "Dinge, die Aura sich über dich und deinen Rechner gemerkt hat. Diese Datei wird von Aura erzeugt; "
    "Änderungen hier übernimmt Aura beim nächsten Zugriff (oder bearbeite einzelne Einträge in der Aura Zentrale).\n"
)
_LINE = re.compile(r"^- (?P<text>.+?)(?: \((?P<date>\d{2}\.\d{2}\.\d{4})\))?\s*$")
_SCHEMA = """
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  topic TEXT NOT NULL,
  source TEXT NOT NULL,
  chat_id TEXT NOT NULL DEFAULT '',
  task_id TEXT NOT NULL DEFAULT '',
  created REAL NOT NULL,
  last_used REAL,
  confidence REAL NOT NULL DEFAULT 1.0
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


# Words that say nothing about relevance (German and English; Aura answers in either).
_STOP_WORDS = (
    "der die das den dem des ein eine einen einem einer und oder aber ist sind war hat habe haben mit auf aus bei "
    "für von vom zum zur zu im in am an um mir mich mein meine meinen dir dich dein deine du ich er sie es wir "
    "ihr bitte mal noch schon auch nur nicht kein keine was wie wer wo wann warum welche welcher welches gibt "
    "kannst kann soll sollte mach machen über unter nach vor the and for with you your this that what how who "
    "where when why can please are was have has not"
)
_STOP = set(_STOP_WORDS.split())


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"\w+", text.lower()) if (len(w) > 2 or w.isdigit()) and w not in _STOP}


def _parse_markdown(text: str) -> list[tuple[str, str, float | None]]:
    """(text, topic, created) for every "- fact (dd.mm.yyyy)" line, topic from the "## topic" above it."""
    out: list[tuple[str, str, float | None]] = []
    topic = PINNED_TOPIC
    for line in text.splitlines():
        if line.startswith("## "):
            topic = line[3:].strip() or PINNED_TOPIC
            continue
        m = _LINE.match(line)
        if not m:
            continue
        created = None
        if m.group("date"):
            try:
                created = datetime.strptime(m.group("date"), "%d.%m.%Y").timestamp()
            except ValueError:
                created = None
        out.append((m.group("text").strip(), topic, created))
    return out


class FactStore:
    def __init__(self, aura_dir: Path) -> None:
        self.dir = aura_dir / "memory"
        self.db = self.dir / "facts.db"
        self.index = self.dir / "MEMORY.md"
        self.archive = self.dir / "archiv.md"  # only read once, for the migration from the Markdown store
        self._lock = threading.RLock()
        self._ready = False
        self._db: sqlite3.Connection | None = None

    # --- storage -----------------------------------------------------------------------------------------

    @contextmanager
    def _session(self) -> Iterator[sqlite3.Connection]:
        """A connection for one public operation; nested calls share it, and it is closed at the end.

        Short-lived on purpose: an open SQLite file cannot be deleted or replaced on Windows (temp directories in
        tests and the selftest, backups), and memory is touched only a few times per task.
        """
        with self._lock:
            if self._db is not None:  # nested inside an operation that already holds the connection
                yield self._db
                return
            self.dir.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(self.db, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA synchronous=NORMAL")
            self._db = conn
            try:
                yield conn
            finally:
                conn.close()
                self._db = None

    def _meta(self, db: sqlite3.Connection, key: str) -> str | None:
        row = db.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return str(row["value"]) if row else None

    def _set_meta(self, db: sqlite3.Connection, key: str, value: str) -> None:
        db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, value))

    def _prepare(self) -> None:
        """Schema, one-time migration from MEMORY.md/archiv.md, and import of manual edits to MEMORY.md."""
        with self._session() as db:
            if not self._ready:
                db.executescript(_SCHEMA)
                if self._meta(db, "migrated") is None:
                    self._migrate(db)
                    self._set_meta(db, "migrated", str(time.time()))
                    db.commit()
                    self._render(db)
                self._ready = True
            self._import_edits(db)

    def _migrate(self, db: sqlite3.Connection) -> None:
        for path in (self.archive, self.index):  # archive first: it holds the oldest entries
            try:
                text = path.read_text(encoding="utf-8")
            except OSError:
                continue
            for fact, topic, created in _parse_markdown(text):
                self._insert(db, fact, topic, "imported", created=created)
        with suppress(OSError):
            self.archive.unlink()

    def _import_edits(self, db: sqlite3.Connection) -> None:
        """The user edited MEMORY.md (Zentrale editor or by hand): take over added, changed and removed lines."""
        try:
            mtime = self.index.stat().st_mtime
        except OSError:
            return
        rendered = float(self._meta(db, "view_mtime") or 0)
        if mtime <= rendered + 0.001:
            return
        in_file = {
            (t.lower(), t, topic) for t, topic, _ in _parse_markdown(self.index.read_text(encoding="utf-8"))
        }
        wanted = {low for low, _, _ in in_file}
        rows = db.execute("SELECT id, text FROM facts").fetchall()
        have = {str(r["text"]).lower(): str(r["id"]) for r in rows}
        for low, fid in have.items():
            if low not in wanted:
                db.execute("DELETE FROM facts WHERE id = ?", (fid,))
        for low, text, topic in in_file:
            if low not in have and not SECRET.search(text):
                self._insert(db, text, topic, "edited")
        db.commit()
        self._render(db)

    def _insert(
        self,
        db: sqlite3.Connection,
        text: str,
        topic: str,
        source: str,
        chat_id: str = "",
        task_id: str = "",
        created: float | None = None,
    ) -> str:
        fid = uuid.uuid4().hex[:12]
        db.execute(
            "INSERT INTO facts (id, text, topic, source, chat_id, task_id, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (fid, text, topic, source, chat_id, task_id, created or time.time()),
        )
        over = db.execute("SELECT COUNT(*) FROM facts").fetchone()[0] - MAX_FACTS
        if over > 0:
            db.execute(
                "DELETE FROM facts WHERE id IN (SELECT id FROM facts ORDER BY COALESCE(last_used, created) LIMIT ?)",
                (over,),
            )
        return fid

    def _render(self, db: sqlite3.Connection) -> None:
        """Writes MEMORY.md from the records (topics in order of first appearance, oldest fact first)."""
        rows = db.execute("SELECT text, topic, created FROM facts ORDER BY created").fetchall()
        topics: dict[str, list[str]] = {}
        for r in rows:
            day = datetime.fromtimestamp(float(r["created"])).strftime("%d.%m.%Y")
            topics.setdefault(str(r["topic"]), []).append(f"- {r['text']} ({day})")
        lines = [HEADER.rstrip("\n")]
        for topic, entries in topics.items():
            lines += ["", f"## {topic}", *entries]
        self.index.write_text("\n".join(lines) + "\n", encoding="utf-8")
        self._set_meta(db, "view_mtime", str(self.index.stat().st_mtime))
        db.commit()

    # --- API used by the tools and the prompt ------------------------------------------------------------

    def remember(
        self,
        fact: str,
        topic: str = PINNED_TOPIC,
        source: str = "explicit",
        chat_id: str = "",
        task_id: str = "",
    ) -> dict[str, Any]:
        fact = " ".join(fact.split()).strip()
        topic = " ".join((topic or PINNED_TOPIC).split())[:40] or PINNED_TOPIC
        if not fact:
            return {"error": "Leerer Eintrag."}
        if SECRET.search(fact):
            return {
                "error": "Passwörter, PINs, Schlüssel oder Kontodaten speichert Aura nicht im Gedächtnis."
            }
        if source not in SOURCES:
            raise ValueError(f"unknown source {source}")
        with self._session() as db:
            self._prepare()
            if db.execute("SELECT 1 FROM facts WHERE lower(text) = ?", (fact.lower(),)).fetchone():
                return {"ok": True, "note": "Stand schon im Gedächtnis."}
            fid = self._insert(db, fact, topic, source, chat_id, task_id)
            db.commit()
            self._render(db)
        return {"ok": True, "id": fid, "saved": fact, "topic": topic, "file": str(self.index)}

    def add_many(self, facts: list[tuple[str, str]], source: str = "imported") -> int:
        """Bulk import of (text, topic): one transaction and one rendering of the view. Skips secrets and duplicates."""
        if source not in SOURCES:
            raise ValueError(f"unknown source {source}")
        added = 0
        with self._session() as db:
            self._prepare()
            have = {str(r[0]).lower() for r in db.execute("SELECT text FROM facts")}
            for text, topic in facts:
                text = " ".join(text.split()).strip()
                if not text or SECRET.search(text) or text.lower() in have:
                    continue
                self._insert(db, text, " ".join((topic or PINNED_TOPIC).split())[:40] or PINNED_TOPIC, source)
                have.add(text.lower())
                added += 1
            db.commit()
            self._render(db)
        return added

    def forget(self, text: str) -> dict[str, Any]:
        with self._session():
            self._prepare()
            needle = text.strip().lower()
            if not needle:
                return {"removed": 0}
            with self._session() as db:
                rows = db.execute("SELECT id, text FROM facts").fetchall()
                hits = [r for r in rows if needle in str(r["text"]).lower()]
                for r in hits:
                    db.execute("DELETE FROM facts WHERE id = ?", (r["id"],))
                db.commit()
                if hits:
                    self._render(db)
            return {"removed": len(hits), "texts": [str(r["text"]) for r in hits]}

    def update(self, fid: str, text: str) -> dict[str, Any]:
        """The user corrected a fact (Zentrale): new text, source becomes "edited"."""
        text = " ".join(text.split()).strip()
        if not text:
            return {"error": "Leerer Eintrag."}
        if SECRET.search(text):
            return {
                "error": "Passwörter, PINs, Schlüssel oder Kontodaten speichert Aura nicht im Gedächtnis."
            }
        with self._session() as db:
            self._prepare()
            n = db.execute("UPDATE facts SET text = ?, source = 'edited' WHERE id = ?", (text, fid)).rowcount
            db.commit()
            if not n:
                return {"error": "Eintrag nicht gefunden."}
            self._render(db)
        return {"ok": True}

    def delete(self, fid: str) -> int:
        with self._session() as db:
            self._prepare()
            n = db.execute("DELETE FROM facts WHERE id = ?", (fid,)).rowcount
            db.commit()
            if n:
                self._render(db)
        return n

    def delete_all(self) -> int:
        with self._session() as db:
            self._prepare()
            n = db.execute("DELETE FROM facts").rowcount
            db.commit()
            self._render(db)
        return n

    def delete_where(self, chat_id: str, source: str = "learned") -> int:
        """Facts of one chat and source (deleting a chat removes what was learned from it, FR-MEM-008)."""
        with self._session() as db:
            self._prepare()
            n = db.execute("DELETE FROM facts WHERE chat_id = ? AND source = ?", (chat_id, source)).rowcount
            db.commit()
            if n:
                self._render(db)
        return n

    def list(self) -> list[dict[str, Any]]:
        with self._session() as db:
            self._prepare()
            return [dict(r) for r in db.execute("SELECT * FROM facts ORDER BY topic, created")]

    def _scored(self, query: str) -> list[tuple[float, sqlite3.Row]]:
        words = _words(query)
        now = time.time()
        with self._session() as db:
            rows = db.execute("SELECT * FROM facts").fetchall()
        scored = []
        for r in rows:
            overlap = len(words & _words(str(r["text"]) + " " + str(r["topic"])))
            age_days = (now - float(r["last_used"] or r["created"])) / 86400
            recency = 0.5 / (1 + age_days / 30)  # newer or recently used facts win ties
            scored.append((overlap + (recency if overlap else 0), r))
        return sorted(scored, key=lambda x: -x[0])

    def _touch(self, ids: list[str]) -> None:
        if not ids:
            return
        with self._session() as db:
            db.executemany("UPDATE facts SET last_used = ? WHERE id = ?", [(time.time(), i) for i in ids])
            db.commit()

    def search(self, query: str, limit: int = 10) -> list[str]:
        """Facts sharing words with the query, best first."""
        with self._session():
            self._prepare()
            hits = [r for score, r in self._scored(query) if score >= 1][:limit]
            self._touch([str(r["id"]) for r in hits])
            return [str(r["text"]) for r in hits]

    def select_for_prompt(self, request: str, budget: int = PROMPT_BUDGET) -> str:
        """The facts for this request: the pinned topic first (up to PINNED_BUDGET), then by relevance."""
        with self._session():
            self._prepare()
            lines: list[str] = []
            used = 0
            chosen: list[str] = []
            with self._session() as db:
                pinned = db.execute(
                    "SELECT id, text FROM facts WHERE topic = ? ORDER BY created DESC", (PINNED_TOPIC,)
                ).fetchall()
            for r in pinned:
                line = f"- {r['text']}"
                if used + len(line) + 1 > PINNED_BUDGET:
                    break
                lines.append(line)
                used += len(line) + 1
                chosen.append(str(r["id"]))
            for score, r in self._scored(request):
                if score < 1:
                    break
                if str(r["id"]) in chosen:
                    continue
                line = f"- {r['text']} ({r['topic']})"
                if used + len(line) + 1 > budget:
                    break
                lines.append(line)
                used += len(line) + 1
                chosen.append(str(r["id"]))
            return "\n".join(lines)
