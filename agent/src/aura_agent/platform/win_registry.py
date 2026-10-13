"""Registry des Benutzers lesen und schreiben (winreg), plus Benachrichtigung der Programme über Änderungen."""
# pyright: reportAttributeAccessIssue=false, reportMissingImports=false
# (Windows-only module: pyright runs on Linux, where ctypes.WinDLL, winreg and comtypes do not exist.)

from __future__ import annotations

import ctypes
import re
from ctypes import wintypes
from typing import Any

from .base import IS_WINDOWS

HIVES = {
    "HKCU": "HKEY_CURRENT_USER",
    "HKEY_CURRENT_USER": "HKEY_CURRENT_USER",
    "HKLM": "HKEY_LOCAL_MACHINE",
    "HKEY_LOCAL_MACHINE": "HKEY_LOCAL_MACHINE",
    "HKCR": "HKEY_CLASSES_ROOT",
    "HKEY_CLASSES_ROOT": "HKEY_CLASSES_ROOT",
    "HKU": "HKEY_USERS",
    "HKEY_USERS": "HKEY_USERS",
}
HWND_BROADCAST = 0xFFFF
WM_SETTINGCHANGE = 0x001A
SMTO_ABORTIFHUNG = 0x0002


def normalize(key: str) -> tuple[str, str]:
    """ "HKCU:\\Software\\X", "HKEY_CURRENT_USER/Software/X" → ("HKEY_CURRENT_USER", "Software\\X")."""
    k = str(key or "").strip().replace("/", "\\").strip("\\")
    if k.lower().startswith("registry::"):
        k = k[10:]
    hive, _, sub = k.partition("\\")
    hive = HIVES.get(hive.rstrip(":").upper())
    if not hive:
        raise ValueError("Schlüssel muss mit HKCU\\ oder HKLM\\ beginnen.")
    return hive, re.sub(r"\\+", r"\\", sub)


def display(key: str) -> str:
    hive, sub = normalize(key)
    short = {v: k for k, v in HIVES.items() if len(k) <= 4}[hive]
    return f"{short}\\{sub}"


def read(key: str, name: str) -> tuple[Any, int] | None:
    import winreg

    hive, sub = normalize(key)
    try:
        with winreg.OpenKey(getattr(winreg, hive), sub) as k:
            return winreg.QueryValueEx(k, name)
    except FileNotFoundError:
        return None


# Registry-Typen (wie in winreg; als Zahlen, damit das Modul auch ohne winreg testbar ist)
REG_SZ, REG_EXPAND_SZ, REG_DWORD, REG_MULTI_SZ, REG_QWORD = 1, 2, 4, 7, 11


def coerce(value: str, kind: int) -> Any:
    """Text aus dem Werkzeugaufruf in den Python-Wert für diesen Registry-Typ."""
    if kind in (REG_DWORD, REG_QWORD):
        low = str(value).strip().lower()
        return (
            1 if low in ("true", "an", "ein", "on") else 0 if low in ("false", "aus", "off") else int(low, 0)
        )
    if kind in (REG_SZ, REG_EXPAND_SZ):
        return str(value)
    if kind == REG_MULTI_SZ:
        return str(value).split("\n")
    raise ValueError("Diesen Registry-Typ (binär) ändert Aura nicht.")


def write(key: str, name: str, value: str) -> None:
    """Schreibt einen Wert. Der Typ bleibt wie bisher; neue Werte sind Zahlen (DWORD) oder Text."""
    import winreg

    hive, sub = normalize(key)
    old = read(key, name)
    kind = old[1] if old else (REG_DWORD if re.fullmatch(r"-?\d+", value.strip()) else REG_SZ)
    v = coerce(value, kind)
    with winreg.CreateKeyEx(getattr(winreg, hive), sub, 0, winreg.KEY_SET_VALUE) as k:
        winreg.SetValueEx(k, name, 0, kind, v)


def broadcast(area: str | None = None) -> None:
    """Teilt allen Fenstern mit, dass sich Einstellungen geändert haben (z. B. "ImmersiveColorSet" für hell/dunkel)."""
    if not IS_WINDOWS:
        return
    user32 = ctypes.WinDLL("user32")
    user32.SendMessageTimeoutW.argtypes = [
        wintypes.HWND,
        wintypes.UINT,
        wintypes.WPARAM,
        wintypes.LPCWSTR,
        wintypes.UINT,
        wintypes.UINT,
        ctypes.POINTER(ctypes.c_size_t),
    ]
    result = ctypes.c_size_t()
    user32.SendMessageTimeoutW(
        HWND_BROADCAST, WM_SETTINGCHANGE, 0, area, SMTO_ABORTIFHUNG, 3000, ctypes.byref(result)
    )
