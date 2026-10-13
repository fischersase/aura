"""Barrierefreiheit für ui_snapshot/ui_act/ui_set_text: AT-SPI unter Linux, UI Automation unter Windows.

Beide Helfer sprechen dasselbe Zeilenprotokoll (atspi_helper.py, uia_helper.py) und liefern dieselben Rollen.
Unter Windows läuft der Helfer mit dem Python des Agenten (comtypes ist mitgeliefert), unter Linux mit dem
System-Python (python3-gi).
"""

from __future__ import annotations

import functools
import sys

from . import atspi
from .base import IS_WINDOWS

if IS_WINDOWS:
    CLIENT = atspi.HelperClient([sys.executable, "-I", "-m", "aura_agent.platform.uia_helper"])
    MISSING = "Barrierefreiheit (UI Automation) ist hier nicht verfügbar."
else:
    CLIENT = atspi.CLIENT
    MISSING = "Barrierefreiheit ist hier nicht verfügbar (Pakete python3-gi und gir1.2-atspi-2.0 fehlen)."


@functools.cache
def available() -> bool:
    if IS_WINDOWS:
        try:
            import comtypes  # noqa: F401  # pyright: ignore[reportMissingImports] - Windows only
        except ImportError:
            return False
        return True
    return atspi.available()
