"""Systemlautstärke unter Windows (Standard-Wiedergabegerät) über die Core-Audio-API (pycaw/comtypes).

COM wird im Multithread-Modus betrieben (sys.coinit_flags = 0), passend zu pywinrt; jeder Aufruf läuft in
einem Hilfsthread (asyncio.to_thread) und meldet diesen Thread selbst bei COM an.
"""
# pyright: reportAttributeAccessIssue=false, reportMissingImports=false
# (Windows-only module: pyright runs on Linux, where ctypes.WinDLL, winreg and comtypes do not exist.)

from __future__ import annotations

import sys
from typing import Any


def _endpoint() -> Any:
    sys.coinit_flags = 0  # type: ignore[attr-defined]  # vor dem ersten Import von comtypes: MTA
    import comtypes
    from pycaw.pycaw import AudioUtilities

    comtypes.CoInitializeEx(0)
    dev = AudioUtilities.GetSpeakers()
    ev = getattr(dev, "EndpointVolume", None)
    if ev is None:  # ältere pycaw-Versionen liefern das IMMDevice selbst
        from ctypes import POINTER, cast

        from comtypes import CLSCTX_ALL
        from pycaw.pycaw import IAudioEndpointVolume

        ev = cast(dev.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None), POINTER(IAudioEndpointVolume))
    return ev


def get() -> dict[str, Any]:
    try:
        ev = _endpoint()
        return {"percent": round(ev.GetMasterVolumeLevelScalar() * 100), "muted": bool(ev.GetMute())}
    except Exception as e:  # noqa: BLE001 - ohne Audiogerät wirft COM
        return {"error": f"Kein Audiogerät erreichbar ({type(e).__name__})."}


def set_volume(level: int | None, mute: bool | None) -> dict[str, Any]:
    try:
        ev = _endpoint()
        if level is not None:
            ev.SetMasterVolumeLevelScalar(max(0, min(int(level), 100)) / 100, None)
        if mute is not None:
            ev.SetMute(1 if mute else 0, None)
    except Exception as e:  # noqa: BLE001
        return {"error": f"Lautstärke ließ sich nicht setzen ({type(e).__name__}: {e})."}
    return get()
