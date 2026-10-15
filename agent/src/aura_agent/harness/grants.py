"""Scoped approvals (AURA-119, FR-PAR-040): what a "yes" in the approval card covers, and for how long.

A grant is bound to a tool plus a subject, never to "everything":
  browser_*  the website (origin) the action is on, e.g. browser_click on https://shop.example
  mcp_*      the connector tool itself (the tool name already contains the server), e.g. mcp_Atlassian_createJiraIssue
  others     the exact action label, e.g. the exact shell command or file path
Scopes: once (nothing kept), task (this task), session (until the agent restarts), hours:N (stored with expiry in
data_dir/grants.json), always (a rule in policy.toml, handled by the PolicyEngine).

Approvals only come from Aura's own UI (host.approve); text in the chat or on a web page cannot create a grant.
"""

from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

Key = tuple[str, str]

MAX_HOURS = 24
PAGE_URL = re.compile(r"(?:^|[\"'\\n]|\r?\n)### Page\s*(?:\r?\n|\\n)-\s*Page URL:\s*([^\s\"'\\]+)")


def origin_of(url: str) -> str:
    try:
        u = urlsplit(url.strip())
    except ValueError:
        return ""
    return f"{u.scheme}://{u.netloc}" if u.scheme in ("http", "https") and u.netloc else ""


def subject(tool: str, args: dict[str, Any], label: str, current_origin: str) -> str:
    """What a grant for this call is bound to (see module doc)."""
    if tool.startswith("browser_"):
        target = origin_of(str(args.get("url", ""))) if tool == "browser_navigate" else ""
        return "origin:" + (target or current_origin or "?")
    if tool.startswith("mcp_"):
        return "tool:" + tool
    return "label:" + label


def page_origin(result: Any) -> str:
    """Origin of the page a Playwright MCP result reports ("### Page\\n- Page URL: …"), or ""."""
    raw = json.dumps(result, ensure_ascii=False) if not isinstance(result, str) else result
    header = raw.split("### Snapshot", 1)[0]
    m = PAGE_URL.search(header)
    return origin_of(m.group(1)) if m else ""


def parse_hours(decision: str) -> int:
    """ "hours:8" → 8 (1…24), else 0."""
    m = re.fullmatch(r"hours:(\d{1,2})", decision)
    return min(int(m.group(1)), MAX_HOURS) if m and int(m.group(1)) > 0 else 0


class GrantStore:
    """Session grants in memory; timed grants also in a small JSON file (survive a restart until they expire)."""

    def __init__(self, file: Path | None = None, now: Any = time.time) -> None:
        self.file = file
        self._now = now
        self._lock = threading.Lock()
        self._session: set[Key] = set()
        self._timed: dict[Key, float] = {}
        if file and file.exists():
            try:
                for item in json.loads(file.read_text(encoding="utf-8")):
                    self._timed[(str(item["tool"]), str(item["subject"]))] = float(item["until"])
            except (OSError, ValueError, KeyError, TypeError):
                self._timed = {}

    def allows(self, key: Key) -> bool:
        if key in self._session:
            return True
        until = self._timed.get(key)
        return until is not None and until > self._now()

    def add_session(self, key: Key) -> None:
        self._session.add(key)

    def add_timed(self, key: Key, hours: int) -> float:
        until = self._now() + hours * 3600
        with self._lock:
            self._timed[key] = until
            self._save()
        return until

    def _save(self) -> None:
        if not self.file:
            return
        now = self._now()
        live = [{"tool": k[0], "subject": k[1], "until": u} for k, u in self._timed.items() if u > now]
        self.file.parent.mkdir(parents=True, exist_ok=True)
        self.file.write_text(json.dumps(live, ensure_ascii=False), encoding="utf-8")
