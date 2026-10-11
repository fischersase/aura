"""Gesperrte Pfade (T3) für alle Datei-Werkzeuge: Zugangsdaten, Schlüssel, Aura selbst.

Gilt für Lesen, Auflisten, Suchen, Schreiben, Verschieben und Papierkorb, egal
wie der Pfad geschrieben ist (~, relativ, absolut, über Symlinks).
Die Shell hat eigene Muster in shell_classifier.FORBIDDEN.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from ..harness.tiers import Tier

# (Muster auf den aufgelösten Pfad, Grund)
FORBIDDEN_PATHS = [
    (re.compile(r"/\.(ssh|gnupg|password-store)(/|$)"), "SSH-/GPG-Schlüssel oder Passwortspeicher"),
    (re.compile(r"/\.local/share/keyrings(/|$)"), "Schlüsselbund"),
    (re.compile(r"/(google-chrome|chromium|BraveSoftware/[^/]+|microsoft-edge)/[^/]+/(Login Data|Cookies|Web Data)"), "Browser-Passwörter oder Cookies"),
    (re.compile(r"/\.mozilla/firefox/[^/]+/(logins\.json|key4\.db|cookies\.sqlite)$"), "Browser-Passwörter oder Cookies"),
    (re.compile(r"/Aura/(secrets\.json|Local State)$|/\.aura/secrets"), "Aura-Schlüssel"),
    (re.compile(r"/Aura/agent/(audit|sessions\.db)"), "Protokoll und Gedächtnis von Aura"),
    (re.compile(r"^/etc/(shadow|gshadow|sudoers)"), "Systempasswörter"),
    (re.compile(r"/\.(netrc|pgpass|git-credentials|docker/config\.json|kube/config)$|/\.aws/credentials$"), "Zugangsdaten"),
]


def forbidden(path: str | Path) -> str | None:
  """Grund, falls der Pfad gesperrt ist, sonst None. Prüft den Pfad und sein Symlink-Ziel."""
  p = Path(path)
  candidates = {str(p)}
  try:
    candidates.add(os.path.realpath(p))
  except OSError:
    pass
  for c in candidates:
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
