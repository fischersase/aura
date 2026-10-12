"""Windows-Shell-Funktionen über ctypes: Papierkorb.

SHFileOperationW mit FOF_ALLOWUNDO verschiebt in den Papierkorb. Auf Laufwerken ohne Papierkorb (Netzlaufwerke,
manche USB-Sticks) würde es endgültig löschen; deshalb nur auf festen lokalen Laufwerken.
"""

from __future__ import annotations

import ctypes
import os
from ctypes import wintypes

from .base import IS_WINDOWS

FO_DELETE = 3
FOF_SILENT = 0x0004
FOF_NOCONFIRMATION = 0x0010
FOF_ALLOWUNDO = 0x0040
FOF_NOERRORUI = 0x0400
DRIVE_FIXED = 3


class SHFILEOPSTRUCTW(ctypes.Structure):
  _fields_ = [
      ("hwnd", wintypes.HWND), ("wFunc", wintypes.UINT), ("pFrom", wintypes.LPCWSTR), ("pTo", wintypes.LPCWSTR),
      ("fFlags", ctypes.c_uint16), ("fAnyOperationsAborted", wintypes.BOOL), ("hNameMappings", ctypes.c_void_p),
      ("lpszProgressTitle", wintypes.LPCWSTR),
  ]


if IS_WINDOWS:
  shell32 = ctypes.WinDLL("shell32")
  shell32.SHFileOperationW.argtypes = [ctypes.POINTER(SHFILEOPSTRUCTW)]
  kernel32 = ctypes.WinDLL("kernel32")
  kernel32.GetDriveTypeW.argtypes = [wintypes.LPCWSTR]
  kernel32.GetDriveTypeW.restype = wintypes.UINT


def has_recycle_bin(path: str) -> bool:
  drive = os.path.splitdrive(os.path.abspath(path))[0]
  return bool(drive) and kernel32.GetDriveTypeW(drive + "\\") == DRIVE_FIXED


def recycle(path: str) -> str:
  """In den Papierkorb verschieben. Rückgabe: Fehlermeldung oder ""."""
  full = os.path.abspath(path)
  if not has_recycle_bin(full):
    return "Dieses Laufwerk hat keinen Papierkorb (Netzlaufwerk oder Wechseldatenträger); Aura löscht hier nichts endgültig."
  op = SHFILEOPSTRUCTW(wFunc=FO_DELETE, pFrom=full + "\0", fFlags=FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI)
  code = shell32.SHFileOperationW(ctypes.byref(op))
  if code:
    return f"Papierkorb fehlgeschlagen (Fehler 0x{code:x}); vielleicht ist die Datei gerade geöffnet."
  if op.fAnyOperationsAborted:
    return "Papierkorb wurde abgebrochen."
  return ""
