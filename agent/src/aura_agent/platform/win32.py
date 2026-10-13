"""Fenster unter Windows über user32 (ctypes), ohne Zusatzpakete.

Gegenstück zu x11.py: dieselben WindowInfo-Daten, IDs sind Fenster-Handles als "0x…".
Gelistet werden Fenster, die auch in der Taskleiste stehen: sichtbar, ohne Besitzer, kein Werkzeugfenster,
nicht „verhüllt“ (DWM cloaked: Apps auf anderen virtuellen Desktops oder unsichtbare UWP-Rahmen).
Alle Aufrufe sind blockierend; Werkzeuge rufen sie mit asyncio.to_thread auf.
"""

from __future__ import annotations

import ctypes
import os
import time
from ctypes import wintypes

from .base import IS_WINDOWS, WindowInfo

GW_OWNER = 4
GWL_EXSTYLE = -20
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_APPWINDOW = 0x00040000
DWMWA_CLOAKED = 14
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE = 3, 6, 9
WM_CLOSE = 0x0010
VK_MENU = 0x12
KEYEVENTF_KEYUP = 0x0002

if IS_WINDOWS:
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    dwmapi = ctypes.WinDLL("dwmapi")
    ENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [ENUMPROC, wintypes.LPARAM]
    user32.EnumChildWindows.argtypes = [wintypes.HWND, ENUMPROC, wintypes.LPARAM]
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindow.argtypes = [wintypes.HWND]
    user32.IsIconic.argtypes = [wintypes.HWND]
    user32.IsZoomed.argtypes = [wintypes.HWND]
    user32.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
    user32.GetWindow.restype = wintypes.HWND
    user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.GetWindowLongW.restype = wintypes.LONG
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    user32.BringWindowToTop.argtypes = [wintypes.HWND]
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    user32.keybd_event.argtypes = [wintypes.BYTE, wintypes.BYTE, wintypes.DWORD, ctypes.c_size_t]
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.QueryFullProcessImageNameW.argtypes = [
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.LPWSTR,
        ctypes.POINTER(wintypes.DWORD),
    ]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.GetCurrentThreadId.restype = wintypes.DWORD
    dwmapi.DwmGetWindowAttribute.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]


def available() -> bool:
    return IS_WINDOWS


def _hwnd(window_id: str) -> int:
    return int(window_id, 16)


def title(hwnd: int) -> str:
    n = user32.GetWindowTextLengthW(hwnd)
    if n <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def pid_of(hwnd: int) -> int:
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def exe_path(pid: int) -> str:
    """Vollständiger Pfad der Programmdatei eines Prozesses ("" ohne Zugriff)."""
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return ""
    try:
        size = wintypes.DWORD(1024)
        buf = ctypes.create_unicode_buffer(size.value)
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value
        return ""
    finally:
        kernel32.CloseHandle(h)


def _cloaked(hwnd: int) -> bool:
    val = wintypes.DWORD()
    if dwmapi.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, ctypes.byref(val), ctypes.sizeof(val)) != 0:
        return False
    return bool(val.value)


def _is_app_window(hwnd: int) -> bool:
    if not user32.IsWindowVisible(hwnd) or _cloaked(hwnd):
        return False
    ex = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
    if ex & WS_EX_TOOLWINDOW:
        return False
    if user32.GetWindow(hwnd, GW_OWNER) and not ex & WS_EX_APPWINDOW:
        return False
    return bool(title(hwnd))


def _uwp_exe(hwnd: int, host_pid: int) -> str:
    """UWP-Apps (z. B. Rechner) laufen in einem Rahmen von ApplicationFrameHost; das eigentliche Programm ist ein Kindfenster."""
    found: list[str] = []

    @ENUMPROC
    def child(h: int, _lp: int) -> bool:
        p = pid_of(h)
        if p and p != host_pid:
            found.append(exe_path(p))
            return False
        return True

    user32.EnumChildWindows(hwnd, child, 0)
    return found[0] if found else ""


def _info(hwnd: int, fg: int) -> WindowInfo:
    pid = pid_of(hwnd)
    exe = exe_path(pid)
    if os.path.basename(exe).lower() == "applicationframehost.exe":
        exe = _uwp_exe(hwnd, pid) or exe
    base = os.path.basename(exe)
    return WindowInfo(
        id=f"0x{hwnd:x}",
        title=title(hwnd),
        app=os.path.splitext(base)[0].lower(),
        instance=base.lower(),
        pid=pid or None,
        desktop=None,
        active=hwnd == fg,
        minimized=bool(user32.IsIconic(hwnd)),
    )


def windows() -> list[WindowInfo]:
    """Offene Programmfenster, oberstes zuerst."""
    handles: list[int] = []

    @ENUMPROC
    def collect(h: int, _lp: int) -> bool:
        if _is_app_window(h):
            handles.append(h)
        return True

    user32.EnumWindows(collect, 0)
    fg = user32.GetForegroundWindow() or 0
    return [_info(h, fg) for h in handles]


def exists(window_id: str) -> bool:
    return bool(user32.IsWindow(_hwnd(window_id)))


def focus(window_id: str) -> None:
    """Fenster nach vorne holen. Windows erlaubt das nur eingeschränkt (Vordergrund-Sperre); daher zuerst die
    Eingabe an den Thread des aktiven Fensters koppeln und notfalls einen Alt-Tastendruck vortäuschen."""
    h = _hwnd(window_id)
    if user32.IsIconic(h):
        user32.ShowWindow(h, SW_RESTORE)
    fg = user32.GetForegroundWindow()
    me = kernel32.GetCurrentThreadId()
    other = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    attached = bool(other and other != me and user32.AttachThreadInput(me, other, True))
    try:
        user32.BringWindowToTop(h)
        user32.SetForegroundWindow(h)
    finally:
        if attached:
            user32.AttachThreadInput(me, other, False)
    if user32.GetForegroundWindow() != h:
        user32.keybd_event(VK_MENU, 0, 0, 0)
        user32.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
        time.sleep(0.05)
        user32.SetForegroundWindow(h)


def minimize(window_id: str) -> None:
    user32.ShowWindow(_hwnd(window_id), SW_MINIMIZE)


def maximize(window_id: str) -> None:
    user32.ShowWindow(_hwnd(window_id), SW_MAXIMIZE)


def close_window(window_id: str) -> None:
    """Bittet das Programm, das Fenster zu schließen (wie das X oben rechts); es darf nach dem Speichern fragen."""
    user32.PostMessageW(_hwnd(window_id), WM_CLOSE, 0, 0)
