"""Wege nach außen nach dem Lesen fremder Inhalte (Schutz vor Prompt-Injection).

Hat ein Auftrag Webseiten, Dateien oder Programmtexte gelesen, könnte eine darin versteckte Anweisung
versuchen, Daten über eine Webadresse hinauszuschicken (z. B. https://angreifer.example/?d=…).
Solche Adressen mit Parametern fragen dann immer.
"""

from __future__ import annotations

from urllib.parse import urlparse

from ..harness.tiers import Tier
from ..runtime.context import current


def url_tier(url: str) -> tuple[Tier, str] | None:
  task = current()
  if task is None or not task.tainted:
    return None
  u = urlparse(str(url or ""))
  if u.scheme in ("http", "https") and (u.query or len(u.path) > 60):
    return Tier.T2, f"Webadresse mit Daten nach dem Lesen fremder Inhalte ({', '.join(task.tainted_by[:3])})"
  return None
