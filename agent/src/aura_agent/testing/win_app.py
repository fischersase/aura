"""Win32-Testprogramm für Windows-Tests (Gegenstück zu gtk_app.py), nur mit ctypes.

Fenster „Aura Testprogramm“ mit Feld „Notiz“, Knopf „Speichern“ (setzt den Status auf „Gespeichert: <Text>“)
und Knopf „Konto löschen“ (setzt den Status auf „GELÖSCHT“; darf in Tests nie ohne Freigabe gedrückt werden).
Optionaler Titel als erstes Argument. Echte Win32-Steuerelemente, daher vollständig über UI Automation sichtbar.
"""

from __future__ import annotations

import ctypes
import os
import sys
from ctypes import wintypes

WS_OVERLAPPEDWINDOW = 0x00CF0000
WS_VISIBLE = 0x10000000
WS_CHILD = 0x40000000
WS_TABSTOP = 0x00010000
WS_BORDER = 0x00800000
BS_PUSHBUTTON = 0
WM_DESTROY = 0x0002
WM_COMMAND = 0x0111
CW_USEDEFAULT = 0x80000000
ID_SAVE, ID_DELETE = 1, 2

LRESULT = ctypes.c_ssize_t
WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)


class WNDCLASSW(ctypes.Structure):
    _fields_ = [
        ("style", wintypes.UINT),
        ("lpfnWndProc", WNDPROC),
        ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int),
        ("hInstance", wintypes.HINSTANCE),
        ("hIcon", wintypes.HICON),
        ("hCursor", wintypes.HANDLE),
        ("hbrBackground", wintypes.HBRUSH),
        ("lpszMenuName", wintypes.LPCWSTR),
        ("lpszClassName", wintypes.LPCWSTR),
    ]


def main() -> None:
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32")
    user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user32.DefWindowProcW.restype = LRESULT
    user32.CreateWindowExW.argtypes = [
        wintypes.DWORD,
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        wintypes.DWORD,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        wintypes.HWND,
        wintypes.HMENU,
        wintypes.HINSTANCE,
        wintypes.LPVOID,
    ]
    user32.CreateWindowExW.restype = wintypes.HWND
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.SetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPCWSTR]
    user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
    user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
    user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
    kernel32.GetModuleHandleW.restype = wintypes.HMODULE

    title = sys.argv[1] if len(sys.argv) > 1 else "Aura Testprogramm"
    state_file = os.environ.get("AURA_TEST_STATE")
    hinst = kernel32.GetModuleHandleW(None)
    controls: dict[str, int] = {}

    def set_status(text: str) -> None:
        user32.SetWindowTextW(controls["status"], text)
        if state_file:
            with open(state_file, "w", encoding="utf-8") as f:
                f.write(text)

    @WNDPROC
    def wndproc(hwnd: int, msg: int, wparam: int, lparam: int) -> int:
        if msg == WM_COMMAND:
            cid = wparam & 0xFFFF
            if cid == ID_SAVE:
                buf = ctypes.create_unicode_buffer(512)
                user32.GetWindowTextW(controls["edit"], buf, 512)
                set_status(f"Gespeichert: {buf.value}")
                return 0
            if cid == ID_DELETE:
                set_status("GELÖSCHT")
                return 0
        if msg == WM_DESTROY:
            user32.PostQuitMessage(0)
            return 0
        return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

    cls = WNDCLASSW(
        lpfnWndProc=wndproc, hInstance=hinst, lpszClassName="AuraTestApp", hbrBackground=6
    )  # 6: COLOR_WINDOW + 1
    user32.RegisterClassW(ctypes.byref(cls))
    main_win = user32.CreateWindowExW(
        0, "AuraTestApp", title, WS_OVERLAPPEDWINDOW | WS_VISIBLE, 100, 100, 420, 260, None, None, hinst, None
    )

    def child(cls_name: str, text: str, style: int, x: int, y: int, w: int, h: int, cid: int = 0) -> int:
        return user32.CreateWindowExW(
            0, cls_name, text, WS_CHILD | WS_VISIBLE | style, x, y, w, h, main_win, cid, hinst, None
        )

    child(
        "STATIC", "Notiz", 0, 10, 10, 60, 22
    )  # Beschriftung direkt vor dem Feld: UI Automation nennt das Feld „Notiz“
    controls["edit"] = child("EDIT", "", WS_BORDER | WS_TABSTOP, 80, 10, 300, 22)
    child("BUTTON", "Speichern", BS_PUSHBUTTON | WS_TABSTOP, 10, 50, 120, 30, ID_SAVE)
    child("BUTTON", "Konto löschen", BS_PUSHBUTTON | WS_TABSTOP, 140, 50, 120, 30, ID_DELETE)
    controls["status"] = child("STATIC", "Bereit", 0, 10, 100, 380, 22)

    msg = wintypes.MSG()
    while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
        user32.TranslateMessage(ctypes.byref(msg))
        user32.DispatchMessageW(ctypes.byref(msg))


if __name__ == "__main__":
    main()
