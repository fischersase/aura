"""Gesperrte Pfade (T3) für alle Datei-Werkzeuge: Zugangsdaten, Schlüssel, Aura selbst.

Gilt für Lesen, Auflisten, Suchen, Schreiben, Verschieben und Papierkorb, egal
wie der Pfad geschrieben ist (~, relativ, absolut, über Symlinks; unter Windows auch mit \\ und in
beliebiger Groß-/Kleinschreibung). Die Shell hat eigene Muster in shell_classifier.FORBIDDEN und
powershell_classifier.FORBIDDEN.
"""

from __future__ import annotations

import contextlib
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
    (
        re.compile(
            r"/(google-chrome|chromium|BraveSoftware/[^/]+|microsoft-edge)/[^/]+/(Login Data|Cookies|Web Data)"
        ),
        "Browser-Passwörter oder Cookies",
    ),
    (
        re.compile(r"/\.mozilla/firefox/[^/]+/(logins\.json|key4\.db|cookies\.sqlite)$"),
        "Browser-Passwörter oder Cookies",
    ),
    (re.compile(r"/Aura/(secrets\.json|Local State)$|/\.aura/secrets"), "Aura-Schlüssel"),
    (re.compile(r"/Aura/agent/(audit|sessions\.db)"), "Protokoll und Gedächtnis von Aura"),
    (re.compile(r"^/etc/(shadow|gshadow|sudoers)"), "Systempasswörter"),
    (
        re.compile(r"/\.(netrc|pgpass|git-credentials|docker/config\.json|kube/config)$|/\.aws/credentials$"),
        "Zugangsdaten",
    ),
    # AURA-16: Cloud-CLIs, Paket- und Entwicklerwerkzeuge, .env-Dateien
    (
        re.compile(
            r"/\.config/gcloud(/|$)|/AppData/Roaming/gcloud(/|$)|/\.azure(/|$)|/\.aws/(config|sso/cache)"
        ),
        "Cloud-Zugangsdaten",
    ),
    (re.compile(r"/(\.config/gh|AppData/Roaming/GitHub CLI)/hosts\.yml$"), "GitHub-Zugangsdaten"),
    (
        re.compile(
            r"/\.(npmrc|pypirc|vault-token)$|/AppData/Roaming/npm/etc/npmrc$|/\.cargo/credentials(\.toml)?$|"
            r"/\.gem/credentials$|/\.composer/auth\.json$|/\.terraform\.d/credentials\.tfrc\.json$|"
            r"/\.config/rclone/rclone\.conf$|/\.config/(op|Bitwarden CLI)(/|$)"
        ),
        "Zugangsdaten von Entwicklerwerkzeugen",
    ),
    (re.compile(r"/\.env(rc|\.[^/]+)?$"), "Umgebungsdatei mit Zugangsdaten (.env)"),
    # Windows
    (
        re.compile(
            r"/AppData/Local/(Google/Chrome|Microsoft/Edge|BraveSoftware/Brave-Browser|Chromium|Vivaldi)/User Data/"
            r"([^/]+/(Login Data|Cookies|Network/Cookies|Web Data)|Local State$)",
            re.IGNORECASE,
        ),
        "Browser-Passwörter oder Cookies",
    ),
    (
        re.compile(
            r"/AppData/Roaming/Mozilla/Firefox/Profiles/[^/]+/(logins\.json|key4\.db|cookies\.sqlite)$",
            re.IGNORECASE,
        ),
        "Browser-Passwörter oder Cookies",
    ),
    (
        re.compile(r"/AppData/(Roaming|Local)/Microsoft/(Credentials|Protect|Vault)(/|$)", re.IGNORECASE),
        "Windows-Anmeldedaten",
    ),
    (
        re.compile(r"^[A-Za-z]:/Windows/System32/config/(SAM|SECURITY|SYSTEM)(\.|$)", re.IGNORECASE),
        "Systempasswörter",
    ),
]
if _FLAGS:
    FORBIDDEN_PATHS = [(re.compile(p.pattern, p.flags | _FLAGS), why) for p, why in FORBIDDEN_PATHS]


def forbidden(path: str | Path) -> str | None:
    """Grund, falls der Pfad gesperrt ist, sonst None. Prüft den Pfad und sein Symlink-Ziel."""
    p = Path(path)
    candidates = {str(p)}
    with contextlib.suppress(OSError):
        candidates.add(os.path.realpath(p))
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


# AURA-60: Dateien, mit denen ein Angreifer nach einer Prompt-Injection dauerhaft Kontrolle gewänne.
# Lesen bleibt erlaubt; für Schreiben, Verschieben und Löschen gilt:
# - Durchsetzung des Agenten (Hooks, Regeln, MCP-Server): T3 – nur der Nutzer ändert sie (Zentrale, Editor).
# - Autostart, Shell-Start und Anweisungen an den Agenten: mindestens T2, auch beim Neuanlegen.
_AURA_ENFORCEMENT = re.compile(r"/\.aura/(hooks\.json|policy\.toml|mcp\.json)$", re.IGNORECASE)
_PERSISTENCE = [
    (re.compile(r"/\.config/(autostart|systemd/user|environment\.d)(/|$)"), "Autostart beim Anmelden"),
    (
        re.compile(
            r"/\.(bashrc|bash_profile|bash_login|profile|zshrc|zprofile|zshenv|xprofile|xsessionrc|pam_environment)$"
        ),
        "Startdatei der Shell (läuft bei jedem Terminal)",
    ),
    (re.compile(r"/\.config/fish/config\.fish$"), "Startdatei der Shell (läuft bei jedem Terminal)"),
    (re.compile(r"/\.local/share/applications/[^/]+\.desktop$"), "Programmeintrag im Menü"),
    (
        re.compile(r"/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup(/|$)", re.IGNORECASE),
        "Autostart beim Anmelden",
    ),
    (
        re.compile(r"/Documents/(Windows)?PowerShell/[^/]*profile\.ps1$", re.IGNORECASE),
        "PowerShell-Profil (läuft bei jedem Start)",
    ),
    (re.compile(r"/\.aura/(AGENTS\.md|skills)(/|$)", re.IGNORECASE), "Anweisungen und Skills von Aura"),
]
ENFORCEMENT_IN_COMMAND = re.compile(r"\.aura[\\/](hooks\.json|policy\.toml|mcp\.json)", re.IGNORECASE)


def control_tier(*paths: str | Path) -> tuple[Tier, str] | None:
    """Stufe für das *Verändern* dieser Pfade (Schreiben, Verschieben, Löschen), falls strenger als üblich."""
    worst: tuple[Tier, str] | None = None
    for p in paths:
        candidates = {str(p)}
        with contextlib.suppress(OSError):
            candidates.add(os.path.realpath(p))
        for c in {c.replace("\\", "/") for c in candidates}:
            if _AURA_ENFORCEMENT.search(c):
                return (
                    Tier.T3,
                    "Hooks, Regeln und MCP-Server von Aura ändert nur der Nutzer selbst (Zentrale)",
                )
            for pattern, reason in _PERSISTENCE:
                if pattern.search(c) and worst is None:
                    worst = (Tier.T2, f"verändert {reason}")
    return worst
