"""Web-Recherche, Seitenabruf und Datei-Download (Antigravity / Gemini 4 Stil).

Schnelle, leichtgewichtige Recherche ohne sichtbares Browser-Fenster:
- web_search: Suchmaschine abfragen (Titel, URL, Textauszug).
- web_fetch: Webseite oder Dokumentation als bereinigten Text lesen.
- download_file: Datei oder Installationspaket herunterladen (mit SHA-256-Prüfsumme).
"""

from __future__ import annotations

import hashlib
import html
import ipaddress
import re
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import httpx

from ..harness.tiers import Tier, aura_tool
from ..policy.exfil import url_tier
from ..runtime.context import current
from .files import guarded_change
from .paths import expand, show

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024  # 500 MB
INSTALLER_SUFFIXES = {
    ".deb",
    ".rpm",
    ".appimage",
    ".flatpakref",
    ".dmg",
    ".pkg",
    ".exe",
    ".msi",
    ".msix",
    ".sh",
    ".ps1",
    ".bat",
    ".cmd",
}


def _home() -> str:
    task = current()
    return task.home if task else str(Path.home())


def _is_Blocked_host(hostname: str) -> bool:
    """Blocks loopback, link-local, and private network hosts (SSRF protection)."""
    host = hostname.strip().lower().rstrip(".")
    if not host or host in ("localhost", "ip6-localhost", "ip6-loopback", "metadata.google.internal"):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return (
        ip.is_loopback
        or ip.is_private
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def _validate_public_url(url: str) -> str | None:
    parsed = urlparse(str(url or "").strip())
    if parsed.scheme not in ("http", "https"):
        return "Nur http:// und https:// Adressen sind erlaubt."
    if not parsed.hostname or _is_Blocked_host(parsed.hostname):
        return "Zugriff auf lokale oder private Netzwerkadressen ist über web_fetch/download_file gesperrt."
    return None


class _DdgHtmlParser(HTMLParser):
    """Extracts search results from DuckDuckGo HTML endpoint."""

    def __init__(self) -> None:
        super().__init__()
        self.results: list[dict[str, str]] = []
        self._in_title = False
        self._in_snippet = False
        self._cur_title: list[str] = []
        self._cur_url = ""
        self._cur_snippet: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = dict(attrs)
        cls = attr_map.get("class") or ""
        if tag == "a" and "result__a" in cls:
            self._in_title = True
            self._cur_title = []
            raw_href = attr_map.get("href") or ""
            if "uddg=" in raw_href:
                qs = parse_qs(urlparse(raw_href).query)
                self._cur_url = unquote(qs.get("uddg", [raw_href])[0])
            else:
                self._cur_url = raw_href
        elif tag in ("a", "div", "span") and "result__snippet" in cls:
            self._in_snippet = True
            self._cur_snippet = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._in_title:
            self._in_title = False
        elif tag in ("a", "div", "span") and self._in_snippet:
            self._in_snippet = False
            title = " ".join("".join(self._cur_title).split())
            snippet = " ".join("".join(self._cur_snippet).split())
            if title and self._cur_url.startswith(("http://", "https://")):
                self.results.append({"title": title, "url": self._cur_url, "snippet": snippet})
            self._cur_title = []
            self._cur_url = ""
            self._cur_snippet = []

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self._cur_title.append(data)
        elif self._in_snippet:
            self._cur_snippet.append(data)


class _ReadableHtmlParser(HTMLParser):
    """Converts HTML into compact readable text while stripping scripts/styles."""

    _SKIP_TAGS = frozenset({"script", "style", "noscript", "svg", "template", "head"})
    _BLOCK_TAGS = frozenset(
        {
            "p",
            "div",
            "section",
            "article",
            "main",
            "header",
            "footer",
            "li",
            "tr",
            "br",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "pre",
            "blockquote",
        }
    )

    def __init__(self) -> None:
        super().__init__()
        self._skip_depth = 0
        self._in_title = False
        self.title_parts: list[str] = []
        self.chunks: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        t = tag.lower()
        if t == "title":
            self._in_title = True
        if t in self._SKIP_TAGS:
            self._skip_depth += 1
            return
        if self._skip_depth == 0:
            if t in ("h1", "h2", "h3"):
                self.chunks.append("\n## ")
            elif t == "li":
                self.chunks.append("\n- ")
            elif t in self._BLOCK_TAGS:
                self.chunks.append("\n")

    def handle_endtag(self, tag: str) -> None:
        t = tag.lower()
        if t == "title":
            self._in_title = False
        if t in self._SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1
            return
        if self._skip_depth == 0 and t in self._BLOCK_TAGS:
            self.chunks.append("\n")

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title_parts.append(data)
        if self._skip_depth == 0:
            self.chunks.append(data)


def html_to_text(raw_html: str) -> tuple[str, str]:
    parser = _ReadableHtmlParser()
    parser.feed(raw_html)
    title = " ".join("".join(parser.title_parts).split())
    text = html.unescape("".join(parser.chunks))
    lines = [" ".join(line.split()) for line in text.splitlines()]
    compact = re.sub(r"\n{3,}", "\n\n", "\n".join(line for line in lines if line)).strip()
    return title, compact


def _search_tier(a: dict[str, Any]) -> tuple[Tier, str]:
    q = str(a.get("query", ""))
    task = current()
    if task and task.tainted and task.local_data_from and len(q) > 80:
        return (
            Tier.T2,
            f"Lange Suchanfrage nach Lesen fremder Inhalte ({', '.join(task.tainted_by[:2])}) "
            f"und lokaler Daten ({', '.join(task.local_data_from[:2])})",
        )
    return Tier.T0, ""


@aura_tool(_search_tier, label=lambda a: f"Websuche: {str(a.get('query', ''))[:80]}")
async def web_search(query: str, max_results: int = 8) -> dict[str, Any]:
    """Sucht im Web nach aktuellen Informationen, Programmen, Dokumentationen oder Lösungen.

    Args:
      query: Suchbegriffe, z. B. "free VPN Spain Linux CLI GUI" oder "GIMP AppImage download".
      max_results: Maximale Anzahl an Treffern (1–15, Standard 8).
    """
    q = query.strip()
    if not q:
        return {"error": "Bitte gib einen Suchbegriff (query) an."}
    limit = max(1, min(15, int(max_results)))
    headers = {"User-Agent": USER_AGENT, "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7"}
    try:
        async with httpx.AsyncClient(timeout=12.0, follow_redirects=True, headers=headers) as client:
            resp = await client.post("https://html.duckduckgo.com/html/", data={"q": q})
            parser = _DdgHtmlParser()
            parser.feed(resp.text)
            results = parser.results[:limit]
            if not results:
                api_resp = await client.get(
                    "https://api.duckduckgo.com/",
                    params={"q": q, "format": "json", "no_html": "1", "skip_disambig": "1"},
                )
                data = api_resp.json()
                if data.get("AbstractText") and data.get("AbstractURL"):
                    results.append(
                        {
                            "title": str(data.get("Heading") or q),
                            "url": str(data["AbstractURL"]),
                            "snippet": str(data["AbstractText"]),
                        }
                    )
                for topic in data.get("RelatedTopics", [])[:limit]:
                    if isinstance(topic, dict) and topic.get("FirstURL") and topic.get("Text"):
                        results.append(
                            {
                                "title": str(topic["Text"])[:80],
                                "url": str(topic["FirstURL"]),
                                "snippet": str(topic["Text"]),
                            }
                        )
            return {"query": q, "count": len(results), "results": results[:limit]}
    except httpx.HTTPError as e:
        return {"error": f"Websuche fehlgeschlagen: {e}"}


def _fetch_tier(a: dict[str, Any]) -> tuple[Tier, str]:
    url = str(a.get("url", ""))
    if blocked := url_tier(url):
        return blocked
    return Tier.T0, ""


@aura_tool(_fetch_tier, label=lambda a: str(a.get("url", ""))[:100])
async def web_fetch(url: str, max_chars: int = 15000) -> dict[str, Any]:
    """Liest den Textinhalt einer Webseite oder Dokumentation schnell per HTTP (ohne Browser-Fenster).

    Args:
      url: Vollständige http:// oder https:// Adresse.
      max_chars: Maximale Textlänge (Standard 15000 Zeichen).
    """
    err = _validate_public_url(url)
    if err:
        return {"error": err}
    limit = max(500, min(50000, int(max_chars)))
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/json,text/plain;q=0.9",
    }
    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True, headers=headers) as client:
            resp = await client.get(url.strip())
            if _validate_public_url(str(resp.url)):
                return {"error": "Weiterleitung auf lokale oder private Netzwerkadresse wurde blockiert."}
            ct = resp.headers.get("content-type", "").lower()
            raw = resp.text
            if "html" in ct or "<html" in raw[:500].lower():
                title, content = html_to_text(raw)
            else:
                title = ""
                content = raw.strip()
            truncated = len(content) > limit
            return {
                "url": str(resp.url),
                "status": resp.status_code,
                "title": title,
                "content": content[:limit],
                "truncated": truncated,
            }
    except httpx.HTTPError as e:
        return {"error": f"Abruf von {url} fehlgeschlagen: {e}"}


def _download_tier(a: dict[str, Any]) -> tuple[Tier, str]:
    url = str(a.get("url", ""))
    if exfil := url_tier(url):
        return exfil
    dest = str(a.get("destination", "~/Downloads"))
    parsed_path = urlparse(url).path.lower()
    for ext in INSTALLER_SUFFIXES:
        if parsed_path.endswith(ext) or dest.lower().endswith(ext):
            return Tier.T2, f"Herunterladen eines Installationspakets oder Skripts ({ext})"
    target = expand(dest, _home())
    if target.exists() and target.is_file():
        return Tier.T2, "Vorhandene Datei beim Herunterladen überschreiben"
    return Tier.T1, "Datei aus dem Internet herunterladen"


@aura_tool(
    guarded_change(_download_tier, "destination"),
    label=lambda a: f"Download {a.get('url', '')} → {a.get('destination', '~/Downloads')}",
)
async def download_file(url: str, destination: str = "~/Downloads") -> dict[str, Any]:
    """Lädt eine Datei von einer URL herunter und berechnet ihre SHA-256-Prüfsumme.

    Args:
      url: Vollständige http:// oder https:// Adresse der Datei.
      destination: Zielordner (z. B. "~/Downloads") oder vollständiger Dateipfad.
    """
    err = _validate_public_url(url)
    if err:
        return {"error": err}
    home = _home()
    dest_path = expand(destination, home)
    parsed = urlparse(url.strip())
    filename = Path(unquote(parsed.path)).name or "download.bin"
    if (dest_path.exists() and dest_path.is_dir()) or destination.endswith(("/", "\\")):
        dest_path.mkdir(parents=True, exist_ok=True)
        target = dest_path / filename
    else:
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        target = dest_path

    hasher = hashlib.sha256()
    total = 0
    headers = {"User-Agent": USER_AGENT}
    try:
        async with (
            httpx.AsyncClient(timeout=60.0, follow_redirects=True, headers=headers) as client,
            client.stream("GET", url.strip()) as resp,
        ):
            if _validate_public_url(str(resp.url)):
                return {"error": "Weiterleitung auf lokale oder private Netzwerkadresse wurde blockiert."}
            if resp.status_code >= 400:
                return {"error": f"Download fehlgeschlagen (HTTP {resp.status_code})."}
            ct = resp.headers.get("content-type", "")
            with target.open("wb") as f:
                async for chunk in resp.aiter_bytes(chunk_size=65536):
                    total += len(chunk)
                    if total > MAX_DOWNLOAD_BYTES:
                        f.close()
                        target.unlink(missing_ok=True)
                        return {"error": "Download abgebrochen: Datei ist größer als 500 MB."}
                    hasher.update(chunk)
                    f.write(chunk)
    except (httpx.HTTPError, OSError) as e:
        return {"error": f"Download fehlgeschlagen: {e}"}

    return {
        "ok": True,
        "path": show(target, home),
        "bytes": total,
        "sha256": hasher.hexdigest(),
        "content_type": ct,
        "verified": f"{show(target, home)} ({total} Bytes, SHA-256 {hasher.hexdigest()[:12]}…)",
    }
