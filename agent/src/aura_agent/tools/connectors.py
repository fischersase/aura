"""Finding and proposing connectors (AURA-96, FR-DISC-001/002/006).

The app sends the curated catalog (src/catalog/connectors.json) with initialize. find_connector searches it first and
only then the official MCP registry, through the app (host.searchRegistry); the agent itself needs no network access
for this. propose_connector shows a connect card in the panel. No tool here installs anything: the user connects in
the Zentrale.
"""

from __future__ import annotations

import re
from typing import Any

from ..harness.tiers import Tier, aura_tool
from ..runtime.context import current

MAX_RESULTS = 3
RISK_REVIEWED = "Von Aura geprüft: Lesen ohne Rückfrage; Senden, Ändern und Löschen fragen immer."
RISK_REGISTRY = "Nicht von Aura geprüft: jede Aktion dieses Servers fragt vorher nach."

# Words that say nothing about the service ("zeig mir meine offenen …").
_STOPWORDS = {
    "the", "and", "for", "with", "show", "list", "open", "get", "find", "read", "send", "write", "all", "new", "can",
    "und", "oder", "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "mir", "mich", "mein", "meine",
    "meinen", "meiner", "zeig", "zeige", "alle", "offene", "offenen", "neue", "neuen", "bitte", "von", "aus", "auf",
    "mit", "für", "was", "wie", "ich", "du", "hast", "habe", "gibt", "neu", "lies", "lese", "schick", "schreib",
}  # fmt: skip


def _words(text: str) -> list[str]:
    return [w for w in re.findall(r"[\wäöüß-]+", text.lower()) if len(w) >= 2 and w not in _STOPWORDS]


def _score(entry: dict[str, Any], words: list[str]) -> int:
    keywords = [str(k).lower() for k in entry.get("keywords") or []]
    title = str(entry.get("title", "")).lower()
    description = str(entry.get("description", "")).lower()
    score = 0
    for w in words:
        if w in keywords or w == entry.get("id"):
            score += 3
        elif any(k.startswith(w) or w.startswith(k) for k in keywords if len(k) >= 3) or w in title:
            score += 2
        elif len(w) >= 4 and w in description:
            score += 1
    return score


def _needs(entry: dict[str, Any]) -> list[str]:
    creds = [
        str(c.get("label") or c.get("name"))
        for c in (entry.get("credentials") or [])
        if c.get("required", True) is not False
    ]
    if (entry.get("config") or {}).get("auth") == "oauth":
        creds.insert(0, f"Anmeldung bei {entry.get('publisher', 'dem Anbieter')} im Browser")
    return creds


def _summary(entry: dict[str, Any], connected: set[str]) -> dict[str, Any]:
    status = entry.get("status", "available")
    is_connected = entry["id"] in connected
    out: dict[str, Any] = {
        "id": entry["id"],
        "title": entry["title"],
        "publisher": entry.get("publisher", ""),
        "verified": "aura",
        "needs": [] if is_connected else _needs(entry),
        "connected": is_connected,
    }
    if is_connected:
        out["note"] = (
            "Bereits verbunden! Nutze direkt den Spezialisten dieser Verbindung. "
            "Falls dort ein Anmelde- oder Konfigurationsfehler auftrat, teile die genaue Fehlermeldung dem Nutzer mit."
        )
    elif status == "coming":
        out["note"] = "Kommt bald; noch nicht verfügbar."
    elif status == "advanced":
        out["note"] = "Für Fortgeschrittene (eigenes Cloud-Projekt nötig)."
    return out


def make_connector_tools(catalog: list[dict[str, Any]], connected: set[str], declined: set[str]) -> list[Any]:
    """catalog: entries from the app; connected: catalog IDs already in mcp.json; declined: "never suggest" IDs."""
    entries = {str(e["id"]): e for e in catalog if isinstance(e, dict) and e.get("id") and e.get("title")}
    # Registry hits of this agent run, so propose_connector can show them without a second search.
    registry_hits: dict[str, dict[str, Any]] = {}

    @aura_tool(Tier.T0, label=lambda a: str(a.get("need", ""))[:120])
    async def find_connector(need: str) -> dict[str, Any]:
        """Sucht eine Verbindung (MCP-Server) zu einem Dienst, auf den Aura noch keinen Zugriff hat (Jira, GitHub, Mail …).

        Nutze das, wenn der Nutzer etwas aus einem Online-Dienst möchte und du dafür kein Werkzeug hast,
        statt im Browser oder per Bildschirm zu improvisieren.

        Args:
          need: Wofür, in wenigen Worten, z. B. "jira tickets" oder "mails lesen".
        """
        words = _words(need)
        ranked = sorted(
            ((s, e) for e in entries.values() if e["id"] not in declined and (s := _score(e, words)) > 0),
            key=lambda x: -x[0],
        )
        found = [_summary(e, connected) for _, e in ranked[:MAX_RESULTS]]
        if found:
            return {"candidates": found, "source": "aura"}
        task = current()
        if task is None:
            return {"candidates": [], "note": "Kein passender Eintrag im Aura-Katalog."}
        try:
            res = await task.host.search_registry(need)
        except Exception as e:  # noqa: BLE001 - the registry is optional; say so
            return {
                "candidates": [],
                "note": f"Kein Eintrag im Aura-Katalog; das MCP-Verzeichnis ist nicht erreichbar ({e}).",
            }
        out = []
        for r in res.get("results") or []:
            rid = str(r.get("id") or r.get("name") or "")
            if not rid or rid in declined:
                continue
            hit = {
                "id": rid,
                "title": str(r.get("title") or rid),
                "publisher": str(r.get("publisher") or rid.split("/")[0]),
                "verified": "registry",
                "needs": [str(n) for n in r.get("needs") or []],
                "connected": False,
            }
            registry_hits[rid] = {**hit, "description": str(r.get("description") or "")}
            out.append(hit)
            if len(out) >= MAX_RESULTS:
                break
        if not out:
            return {
                "candidates": [],
                "note": "Weder im Aura-Katalog noch im MCP-Verzeichnis gibt es dafür eine Verbindung.",
            }
        return {
            "candidates": out,
            "source": "registry",
            "note": "Nicht von Aura geprüft; sag das dem Nutzer, wenn du einen davon vorschlägst.",
        }

    @aura_tool(
        Tier.T1,
        label=lambda a: str(a.get("id", ""))[:80],
        effect=lambda a: f"Verbindung vorschlagen: {a.get('id', '')}",
    )
    async def propose_connector(id: str, reason: str) -> dict[str, Any]:
        """Schlägt dem Nutzer eine Verbindung aus find_connector vor (Karte mit „Verbinden“). Installiert nichts selbst.

        Args:
          id: Die id aus find_connector.
          reason: Ein kurzer Satz, wofür die Verbindung gebraucht wird, z. B. "Damit ich deine Jira-Tickets lesen kann."
        """
        if id in declined:
            return {
                "error": "Der Nutzer möchte diese Verbindung nicht mehr vorgeschlagen bekommen. Frag nicht erneut."
            }
        if id in connected:
            return {"error": "Diese Verbindung ist schon eingerichtet; nutze integrations."}
        entry = entries.get(id)
        if entry is not None:
            if entry.get("status") == "coming":
                return {
                    "error": f"„{entry['title']}“ ist noch nicht verfügbar. Sag dem Nutzer, dass das bald kommt."
                }
            card = {
                **_summary(entry, connected),
                "description": entry.get("description", ""),
                "risk": RISK_REVIEWED,
            }
        elif id in registry_hits:
            card = {**registry_hits[id], "risk": RISK_REGISTRY}
        else:
            return {"error": "Unbekannte id. Erst mit find_connector suchen."}
        task = current()
        if task is None:
            return {"error": "Vorschläge gehen nur während eines Auftrags."}
        card.pop("connected", None)
        card.pop("note", None)
        res = await task.host.propose_connector({"taskId": task.task_id, "reason": reason[:300], **card})
        decision = (res or {}).get("decision")
        task.audit.write("connector_proposed", task=task.task_id, connector=id, decision=str(decision))
        if decision == "connect":
            return {
                "decision": "connect",
                "note": "Die Aura Zentrale ist offen; der Nutzer richtet die Verbindung dort ein. "
                "Sag ihm, dass er den Auftrag danach einfach noch einmal stellen kann.",
            }
        if decision == "never":
            declined.add(id)
            return {
                "decision": "never",
                "note": "Nicht mehr vorschlagen. Sag ehrlich, dass Aura ohne Verbindung keinen Zugriff hat.",
            }
        return {
            "decision": "later",
            "note": "Nicht jetzt. Sag ehrlich, dass Aura ohne Verbindung keinen Zugriff hat.",
        }

    return [find_connector, propose_connector]
