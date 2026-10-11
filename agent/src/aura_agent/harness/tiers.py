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

  def classify(self, args: dict[str, Any]) -> tuple[Tier, str]:
    t = self.tier(args) if callable(self.tier) else self.tier
    return t if isinstance(t, tuple) else (t, "")

  def describe(self, name: str, args: dict[str, Any]) -> str:
    if self.label:
      # Eine kaputte Beschreibung darf den Aufruf nicht verhindern.
      with contextlib.suppress(Exception):
        return str(self.label(args))
    return name


def aura_tool(tier: Tier | TierFn = Tier.T0, label: Callable[[dict[str, Any]], str] | None = None,
              effect: Callable[[dict[str, Any]], str] | None = None) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
  """Hängt Stufe und Beschriftung an eine Werkzeugfunktion."""

  def deco(fn: Callable[..., Any]) -> Callable[..., Any]:
    fn.__aura__ = ToolMeta(tier=tier, label=label, effect=effect)  # type: ignore[attr-defined]
    return fn

  return deco


UNKNOWN = ToolMeta(tier=Tier.T2)


def meta_of(tool: Any) -> ToolMeta:
  """Metadaten eines ADK-Werkzeugs. Werkzeuge ohne Angabe gelten als T2 (fragen)."""
  fn = getattr(tool, "func", None)
  meta = getattr(fn, "__aura__", None) or getattr(tool, "__aura__", None)
  return meta if isinstance(meta, ToolMeta) else UNKNOWN
