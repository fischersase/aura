"""Gesperrte Pfade (T3) für alle Datei-Werkzeuge: Zugangsdaten, Schlüssel, Aura selbst.

Gilt für Lesen, Auflisten, Suchen, Schreiben, Verschieben und Papierkorb, egal
wie der Pfad geschrieben ist (~, relativ, absolut, über Symlinks; unter Windows auch mit \\ und in
beliebiger Groß-/Kleinschreibung). Die Shell hat eigene Muster in shell_classifier.FORBIDDEN und
powershell_classifier.FORBIDDEN.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from ..harness.tiers import Tier
from ..platform.base import IS_WINDOWS

_FLAGS = re.IGNORECASE if IS_WINDOWS else 0

# (Muster auf den aufgelösten Pfad mit / als Trenner, Grund)
FORBIDDEN_PATHS = [
    (re.compile(r"/\.(ssh|gnupg|password-store)(/|$)"), "SSH-/GPG-Schlüssel oder Passwortspeicher"),
    (re.compile(r"/\.local/share/keyrings(/|$)"), "Schlüsselbund"),
    (re.compile(r"/(google-chrome|chromium|BraveSoftware/[^/]+|microsoft-edge)/[^/]+/(Login Data|Cookies|Web Data)"), "Browser-Passwörter oder Cookies"),
    (re.compile(r"/\.mozilla/firefox/[^/]+/(logins\.json|key4\.db|cookies\.sqlite)$"), "Browser-Passwörter oder Cookies"),
    (re.compile(r"/Aura/(secrets\.json|Local State)$|/\.aura/secrets"), "Aura-Schlüssel"),
    (re.compile(r"/Aura/agent/(audit|sessions\.db)"), "Protokoll und Gedächtnis von Aura"),
    (re.compile(r"^/etc/(shadow|gshadow|sudoers)"), "Systempasswörter"),
    (re.compile(r"/\.(netrc|pgpass|git-credentials|docker/config\.json|kube/config)$|/\.aws/credentials$"), "Zugangsdaten"),
    # Windows
    (re.compile(r"/AppData/Local/(Google/Chrome|Microsoft/Edge|BraveSoftware/Brave-Browser|Chromium|Vivaldi)/User Data/"
                r"([^/]+/(Login Data|Cookies|Network/Cookies|Web Data)|Local State$)", re.IGNORECASE), "Browser-Passwörter oder Cookies"),
    (re.compile(r"/AppData/Roaming/Mozilla/Firefox/Profiles/[^/]+/(logins\.json|key4\.db|cookies\.sqlite)$", re.IGNORECASE),
     "Browser-Passwörter oder Cookies"),
    (re.compile(r"/AppData/(Roaming|Local)/Microsoft/(Credentials|Protect|Vault)(/|$)", re.IGNORECASE), "Windows-Anmeldedaten"),
    (re.compile(r"^[A-Za-z]:/Windows/System32/config/(SAM|SECURITY|SYSTEM)(\.|$)", re.IGNORECASE), "Systempasswörter"),
]
if _FLAGS:
  FORBIDDEN_PATHS = [(re.compile(p.pattern, p.flags | _FLAGS), why) for p, why in FORBIDDEN_PATHS]


def forbidden(path: str | Path) -> str | None:
  """Grund, falls der Pfad gesperrt ist, sonst None. Prüft den Pfad und sein Symlink-Ziel."""
  p = Path(path)
  candidates = {str(p)}
  try:
    candidates.add(os.path.realpath(p))
  except OSError:
    pass
  for c in {c.replace("\\", "/") for c in candidates}:
    for pattern, reason in FORBIDDEN_PATHS:
      if pattern.search(c):
        return reason
  return None


def path_tier(*paths: str | Path) -> tuple[Tier, str] | None:
  for p in paths:
    reason = forbidden(p)
    if reason:
      return Tier.T3, reason
  return None
