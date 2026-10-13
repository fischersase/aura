"""Stufen-Modell und Metadaten der Werkzeuge.

T0 lesen: läuft automatisch.
T1 lokal und umkehrbar (Musik pausieren, App öffnen): läuft automatisch.
T2 folgenreich (löschen, senden, installieren, überschreiben): fragt immer.
T3 verboten (Zugangsdaten, Sicherheitseinstellungen): wird nie ausgeführt.
"""

from __future__ import annotations

import contextlib
from collections.abc import Callable
from dataclasses import dataclass
from enum import IntEnum
from typing import Any


class Tier(IntEnum):
    T0 = 0
    T1 = 1
    T2 = 2
    T3 = 3


TierFn = Callable[[dict[str, Any]], "Tier | tuple[Tier, str]"]


@dataclass(frozen=True)
class ToolMeta:
    """Wie die Hülle ein Werkzeug behandelt.

    tier: feste Stufe oder Funktion der Argumente. Gibt die Funktion (Stufe, Grund)
    zurück, erscheint der Grund in der Freigabe und im Audit.
    label: kurze Beschreibung des Aufrufs für die UI.
    effect: genaue Wirkung für die Freigabekarte (Befehl, Pfad, Diff …).
    """

    tier: Tier | TierFn = Tier.T0
    label: Callable[[dict[str, Any]], str] | None = None
    effect: Callable[[dict[str, Any]], str] | None = None
    # Argumente, ohne die die Hülle den Aufruf nicht einstufen kann (z. B. was angeklickt wird).
    required: tuple[str, ...] = ()

    def classify(self, args: dict[str, Any]) -> tuple[Tier, str]:
        t = self.tier(args) if callable(self.tier) else self.tier
        return t if isinstance(t, tuple) else (t, "")

    def describe(self, name: str, args: dict[str, Any]) -> str:
        if self.label:
            # Eine kaputte Beschreibung darf den Aufruf nicht verhindern.
            with contextlib.suppress(Exception):
                return str(self.label(args))
        return name


def aura_tool(
    tier: Tier | TierFn = Tier.T0,
    label: Callable[[dict[str, Any]], str] | None = None,
    effect: Callable[[dict[str, Any]], str] | None = None,
    required: tuple[str, ...] = (),
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Hängt Stufe und Beschriftung an eine Werkzeugfunktion."""

    def deco(fn: Callable[..., Any]) -> Callable[..., Any]:
        fn.__aura__ = ToolMeta(tier=tier, label=label, effect=effect, required=required)  # type: ignore[attr-defined]
        return fn

    return deco


UNKNOWN = ToolMeta(tier=Tier.T2)

# Metadaten für Werkzeuge, die nicht aus Aura-Funktionen stammen (MCP-Server wie der Browser), nach Name.
EXTERNAL: dict[str, ToolMeta] = {}
# Weitere Quellen (z. B. MCP-Server des Nutzers): Funktion Werkzeug → ToolMeta oder None.
RESOLVERS: list[Callable[[Any], ToolMeta | None]] = []


def meta_of(tool: Any) -> ToolMeta:
    """Metadaten eines ADK-Werkzeugs. Werkzeuge ohne Angabe gelten als T2 (fragen)."""
    fn = getattr(tool, "func", None)
    meta = (
        getattr(fn, "__aura__", None)
        or getattr(tool, "__aura__", None)
        or EXTERNAL.get(getattr(tool, "name", ""))
    )
    if meta is None:
        for resolve in RESOLVERS:
            meta = resolve(tool)
            if meta is not None:
                break
    return meta if isinstance(meta, ToolMeta) else UNKNOWN
