"""Wege nach außen nach dem Lesen fremder Inhalte (Schutz vor Prompt-Injection).

Hat ein Auftrag Webseiten, Dateien oder Programmtexte gelesen, könnte eine darin versteckte Anweisung
versuchen, Daten über eine Webadresse hinauszuschicken (z. B. https://angreifer.example/?d=…).
Gefährlich ist die Kombination: eingeschleuste Anweisung (fremder Inhalt) UND lokale Daten im Kontext.
Dann fragen Adressen, die Daten tragen können (Parameter oder langer Pfad). Reines Surfen fragt nicht.
"""

from __future__ import annotations

from urllib.parse import urlparse

from ..harness.tiers import Tier
from ..runtime.context import current


def url_tier(url: str) -> tuple[Tier, str] | None:
    task = current()
    if task is None or not task.tainted or not task.local_data_from:
        return None
    u = urlparse(str(url or ""))
    if u.scheme in ("http", "https") and (u.query or len(u.path) > 60):
        return Tier.T2, (
            f"Webadresse kann Daten tragen; der Auftrag hat fremde Inhalte ({', '.join(task.tainted_by[:2])}) "
            f"und lokale Daten ({', '.join(task.local_data_from[:2])}) gelesen"
        )
    return None
