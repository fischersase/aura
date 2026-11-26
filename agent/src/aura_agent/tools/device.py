"""Geräte- und Hardware-Steuerung (Windows, Linux, macOS): Bluetooth, Bildschirmhelligkeit,
Audio-Ausgabegeräte, WLAN und Schnell-Modi (Nicht stören, Nachtlicht, Energiesparmodus, Sperren).

Jedes Werkzeug folgt Auras Prinzipien:
- Lesen ist T0, harmlose/umkehrbare Änderungen sind T1, verbindungs-/sitzungsunterbrechende
  Aktionen (WLAN aus, Ruhemodus) sind T2.
- Jede Änderung prüft ihr Ergebnis nach (verified: true/false).
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
from pathlib import Path
from typing import Any

from ..harness.tiers import Tier, aura_tool
from ..platform.base import IS_MACOS, IS_WINDOWS
from ..platform.proc import spawn_kwargs

if not IS_WINDOWS and not IS_MACOS:
    from dbus_fast import BusType, Message, MessageType, Variant
    from dbus_fast.aio import MessageBus


async def _run(*cmd: str, timeout: float = 15.0) -> tuple[int, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            **spawn_kwargs(new_group=False),
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return proc.returncode or 0, out.decode(errors="replace").strip()
    except TimeoutError:
        return 124, f"Zeitüberschreitung nach {int(timeout)} s."
    except OSError as e:
        return 127, str(e)


async def _ps(script: str, timeout: float = 20.0) -> tuple[int, str]:
    return await _run(
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
        timeout=timeout,
    )


def _ps_quote(text: str) -> str:
    return "'" + str(text).replace("'", "''") + "'"


def _match_device(items: list[dict[str, Any]], query: str, *fields: str) -> dict[str, Any] | None:
    q = query.strip().lower()
    if not q:
        return None
    for item in items:
        for f in fields:
            val = str(item.get(f) or "").lower()
            if val == q:
                return item
    for item in items:
        for f in fields:
            val = str(item.get(f) or "").lower()
            if q in val:
                return item
    tokens = [t for t in re.split(r"\s+", q) if len(t) >= 2]
    if tokens:
        best: tuple[int, dict[str, Any]] | None = None
        for item in items:
            hay = " ".join(str(item.get(f) or "") for f in fields).lower()
            score = sum(1 for t in tokens if t in hay)
            if score and (best is None or score > best[0]):
                best = (score, item)
        if best is not None:
            return best[1]
    return None


# ---------- Bluetooth ----------


def _parse_bluetoothctl_devices(output: str) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for line in output.splitlines():
        m = re.match(r"Device\s+([0-9A-Fa-f:]{17})\s+(.+)", line.strip())
        if m:
            out.append({"address": m.group(1), "name": m.group(2).strip()})
    return out


async def _bt_linux_status() -> dict[str, Any]:
    if not shutil.which("bluetoothctl"):
        return {"error": "bluetoothctl fehlt (Paket bluez)."}
    code, show_out = await _run("bluetoothctl", "show")
    powered = "Powered: yes" in show_out if code == 0 else None
    _, dev_out = await _run("bluetoothctl", "devices")
    devices: list[dict[str, Any]] = []
    for d in _parse_bluetoothctl_devices(dev_out):
        _, info = await _run("bluetoothctl", "info", d["address"], timeout=5.0)
        connected = "Connected: yes" in info
        paired = "Paired: yes" in info
        icon_m = re.search(r"Icon:\s*(\S+)", info)
        devices.append(
            {
                "name": d["name"],
                "address": d["address"],
                "connected": connected,
                "paired": paired,
                **({"kind": icon_m.group(1)} if icon_m else {}),
            }
        )
    return {"powered": powered, "count": len(devices), "devices": devices}


async def _bt_windows_status() -> dict[str, Any]:
    script = r"""
$ErrorActionPreference = 'SilentlyContinue'
$powered = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  function AwaitWinRT($op, $type) {
    $m = $asTaskGeneric.MakeGenericMethod($type)
    $t = $m.Invoke($null, @($op))
    $t.Wait(5000) | Out-Null
    return $t.Result
  }
  [Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null
  $radios = AwaitWinRT ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
  $bt = $radios | Where-Object { $_.Kind -eq 'Bluetooth' } | Select-Object -First 1
  if ($bt) { $powered = ($bt.State -eq 'On') }
} catch {}
$devs = @()
Get-PnpDevice -Class Bluetooth | Where-Object {
  $_.FriendlyName -and $_.InstanceId -like 'BTHENUM\DEV_*'
} | ForEach-Object {
  $devs += [PSCustomObject]@{
    name = $_.FriendlyName
    id = $_.InstanceId
    status = $_.Status
    connected = ($_.Status -eq 'OK')
  }
}
[PSCustomObject]@{ powered = $powered; devices = $devs } | ConvertTo-Json -Depth 4 -Compress
"""
    code, out = await _ps(script)
    if code != 0 or not out:
        return {"error": f"Bluetooth-Status konnte unter Windows nicht gelesen werden: {out or code}"}
    try:
        data = json.loads(out)
    except ValueError:
        return {"error": f"Unerwartete Bluetooth-Ausgabe: {out[:200]}"}
    raw_devs = data.get("devices") or []
    if isinstance(raw_devs, dict):
        raw_devs = [raw_devs]
    devices = [
        {
            "name": str(d.get("name") or ""),
            "address": str(d.get("id") or ""),
            "connected": bool(d.get("connected")),
            "status": str(d.get("status") or ""),
        }
        for d in raw_devs
        if isinstance(d, dict) and d.get("name")
    ]
    return {"powered": data.get("powered"), "count": len(devices), "devices": devices}


async def _bt_windows_radio(on: bool) -> dict[str, Any]:
    state = "On" if on else "Off"
    script = rf"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {{
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
}})[0]
function AwaitWinRT($op, $type) {{
  $m = $asTaskGeneric.MakeGenericMethod($type)
  $t = $m.Invoke($null, @($op))
  $t.Wait(8000) | Out-Null
  return $t.Result
}}
[Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null
[Windows.Devices.Radios.RadioState,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null
[Windows.Devices.Radios.RadioAccessStatus,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null
$radios = AwaitWinRT ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
$bt = $radios | Where-Object {{ $_.Kind -eq 'Bluetooth' }} | Select-Object -First 1
if (-not $bt) {{ throw 'Kein Bluetooth-Adapter gefunden.' }}
$null = AwaitWinRT ($bt.SetStateAsync([Windows.Devices.Radios.RadioState]::{state})) ([Windows.Devices.Radios.RadioAccessStatus])
Write-Output ($bt.State -eq 'On')
"""
    code, out = await _ps(script)
    if code != 0:
        return {"error": f"Bluetooth ließ sich nicht umschalten: {out}", "verified": False}
    status = await _bt_windows_status()
    ok = status.get("powered") is on
    return {
        **status,
        "verified": ok,
        **({} if ok else {"error": "Bluetooth-Status hat sich nicht geändert."}),
    }


async def _bt_windows_connect(device_name: str, connect: bool) -> dict[str, Any]:
    """Connects or disconnects a paired Bluetooth audio/classic device on Windows via WinRT/PnP."""
    status = await _bt_windows_status()
    if status.get("error"):
        return status
    target = _match_device(status.get("devices") or [], device_name, "name", "address")
    if target is None:
        names = [d["name"] for d in status.get("devices") or []]
        return {
            "error": f"Kein gekoppeltes Bluetooth-Gerät „{device_name}“ gefunden.",
            "available": names,
        }
    q_name = _ps_quote(target["name"])
    q_id = _ps_quote(target["address"])
    action_flag = "$true" if connect else "$false"
    script = rf"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {{
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
}})[0]
function AwaitWinRT($op, $type) {{
  $m = $asTaskGeneric.MakeGenericMethod($type)
  $t = $m.Invoke($null, @($op))
  $t.Wait(10000) | Out-Null
  return $t.Result
}}
$wantName = {q_name}
$wantConnect = {action_flag}
$done = $false
try {{
  [Windows.Devices.Enumeration.DeviceInformation,Windows.Devices.Enumeration,ContentType=WindowsRuntime] | Out-Null
  [Windows.Media.Audio.AudioPlaybackConnection,Windows.Media.Audio,ContentType=WindowsRuntime] | Out-Null
  $sel = [Windows.Media.Audio.AudioPlaybackConnection]::GetDeviceSelector()
  $infos = AwaitWinRT ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($sel)) ([Windows.Devices.Enumeration.DeviceInformationCollection])
  $hit = $infos | Where-Object {{ $_.Name -like "*$wantName*" }} | Select-Object -First 1
  if ($hit -and $wantConnect) {{
    $conn = [Windows.Media.Audio.AudioPlaybackConnection]::TryCreateFromId($hit.Id)
    if ($conn) {{
      $null = $conn.Start()
      $res = AwaitWinRT ($conn.OpenAsync()) ([Windows.Media.Audio.AudioPlaybackConnectionOpenResult])
      if ($res.Status -eq 'Success') {{ $done = $true }}
    }}
  }}
}} catch {{}}
if (-not $done) {{
  $pnp = Get-PnpDevice -InstanceId {q_id} -ErrorAction SilentlyContinue
  if ($pnp) {{
    if ($wantConnect) {{
      Enable-PnpDevice -InstanceId $pnp.InstanceId -Confirm:$false -ErrorAction SilentlyContinue
    }} else {{
      Disable-PnpDevice -InstanceId $pnp.InstanceId -Confirm:$false -ErrorAction SilentlyContinue
    }}
  }}
}}
Write-Output ($done)
"""
    _code, out = await _ps(script, timeout=25.0)
    await asyncio.sleep(1.0)
    after = await _bt_windows_status()
    matched = _match_device(after.get("devices") or [], target["name"], "name", "address")
    connected = bool(matched and matched.get("connected"))
    ok = connected if connect else not connected
    if not ok and out.strip().lower() == "true":
        ok = True
    return {
        "device": target["name"],
        "connected": connected,
        "verified": ok,
        **(
            {}
            if ok
            else {
                "error": (
                    f"„{target['name']}“ konnte nicht {'verbunden' if connect else 'getrennt'} werden "
                    f"(ist das Gerät eingeschaltet und in Reichweite? {out[:160]})".strip()
                )
            }
        ),
    }


def _bluetooth_tier(a: dict[str, Any]) -> tuple[Tier, str]:
    action = str(a.get("action") or "list").strip().lower()
    if action in ("list", "status"):
        return Tier.T0, ""
    return Tier.T1, ""


@aura_tool(
    _bluetooth_tier,
    label=lambda a: (
        f"Bluetooth {a.get('action', 'list')}" + (f": {a.get('device', '')}" if a.get("device") else "")
    ),
)
async def bluetooth(action: str = "list", device: str = "") -> dict[str, Any]:
    """Listet Bluetooth-Geräte auf, schaltet Bluetooth ein/aus oder verbindet/trennt Kopfhörer, Lautsprecher und andere gekoppelte Geräte.

    Args:
      action: "list" (Status & gekoppelte Geräte), "connect" (verbinden), "disconnect" (trennen), "on" (einschalten) oder "off" (ausschalten).
      device: Name (oder Teil des Namens / MAC-Adresse) des Geräts, z. B. "Sony", "AirPods", "Kopfhörer" (für connect/disconnect).
    """
    act = action.strip().lower()
    if act not in ("list", "status", "connect", "disconnect", "on", "off"):
        return {"error": "action muss list, connect, disconnect, on oder off sein."}

    if IS_WINDOWS:
        if act in ("list", "status"):
            return await _bt_windows_status()
        if act in ("on", "off"):
            return await _bt_windows_radio(act == "on")
        if not device.strip():
            return {"error": "Bitte gib den Namen des Bluetooth-Geräts (device) an."}
        return await _bt_windows_connect(device, connect=(act == "connect"))

    if IS_MACOS:
        if shutil.which("blueutil"):
            if act in ("list", "status"):
                _, power = await _run("blueutil", "--power")
                _, paired = await _run("blueutil", "--paired", "--format", "json")
                try:
                    devs = json.loads(paired) if paired else []
                except ValueError:
                    devs = []
                return {
                    "powered": power.strip() == "1",
                    "count": len(devs),
                    "devices": [
                        {
                            "name": d.get("name", ""),
                            "address": d.get("address", ""),
                            "connected": bool(d.get("connected")),
                        }
                        for d in devs
                    ],
                }
            if act in ("on", "off"):
                await _run("blueutil", "--power", "1" if act == "on" else "0")
                _, power = await _run("blueutil", "--power")
                ok = (power.strip() == "1") == (act == "on")
                return {"powered": power.strip() == "1", "verified": ok}
            if not device.strip():
                return {"error": "Bitte gib den Namen des Bluetooth-Geräts an."}
            st = await bluetooth("list")
            hit = _match_device(st.get("devices") or [], device, "name", "address")
            if not hit:
                return {
                    "error": f"Kein gekoppeltes Gerät „{device}“ gefunden.",
                    "available": st.get("devices"),
                }
            flag = "--connect" if act == "connect" else "--disconnect"
            code, out = await _run("blueutil", flag, hit["address"])
            after = await bluetooth("list")
            hit2 = _match_device(after.get("devices") or [], hit["address"], "address", "name")
            conn = bool(hit2 and hit2.get("connected"))
            ok = conn if act == "connect" else not conn
            return {
                "device": hit["name"],
                "connected": conn,
                "verified": ok,
                **({} if ok else {"error": out or "Verbindungsstatus hat sich nicht geändert."}),
            }
        return {
            "error": "Unter macOS wird blueutil für Bluetooth-Steuerung benötigt (brew install blueutil)."
        }

    # Linux (BlueZ / bluetoothctl)
    if act in ("list", "status"):
        return await _bt_linux_status()
    if not shutil.which("bluetoothctl"):
        return {"error": "bluetoothctl fehlt (Paket bluez)."}
    if act in ("on", "off"):
        code, out = await _run("bluetoothctl", "power", act)
        if code != 0:
            return {"error": out or f"Bluetooth konnte nicht auf {act} gestellt werden.", "verified": False}
        st = await _bt_linux_status()
        ok = st.get("powered") is (act == "on")
        return {
            **st,
            "verified": ok,
            **({} if ok else {"error": "Bluetooth-Status hat sich nicht geändert."}),
        }

    if not device.strip():
        return {"error": "Bitte gib den Namen oder die Adresse des Bluetooth-Geräts (device) an."}
    st = await _bt_linux_status()
    if st.get("error"):
        return st
    if act == "connect" and st.get("powered") is False:
        await _run("bluetoothctl", "power", "on")
        await asyncio.sleep(0.5)
        st = await _bt_linux_status()
    hit = _match_device(st.get("devices") or [], device, "name", "address")
    if hit is None:
        names = [d["name"] for d in st.get("devices") or []]
        return {
            "error": f"Kein gekoppeltes Bluetooth-Gerät „{device}“ gefunden.",
            "available": names,
        }
    code, out = await _run("bluetoothctl", act, hit["address"], timeout=20.0)
    await asyncio.sleep(0.6)
    after = await _bt_linux_status()
    hit2 = _match_device(after.get("devices") or [], hit["address"], "address", "name")
    connected = bool(hit2 and hit2.get("connected"))
    ok = connected if act == "connect" else not connected
    return {
        "device": hit["name"],
        "address": hit["address"],
        "connected": connected,
        "verified": ok,
        **(
            {}
            if ok
            else {
                "error": out
                or f"„{hit['name']}“ konnte nicht {'verbunden' if act == 'connect' else 'getrennt'} werden."
            }
        ),
    }


# ---------- Bildschirmhelligkeit ----------


async def _linux_gnome_brightness(level: int | None = None) -> int | None:
    try:
        bus = await MessageBus(bus_type=BusType.SESSION).connect()
        try:
            if level is not None:
                reply = await bus.call(
                    Message(
                        destination="org.gnome.SettingsDaemon.Power",
                        path="/org/gnome/SettingsDaemon/Power",
                        interface="org.freedesktop.DBus.Properties",
                        member="Set",
                        signature="ssv",
                        body=[
                            "org.gnome.SettingsDaemon.Power.Screen",
                            "Brightness",
                            Variant("i", max(0, min(100, int(level)))),
                        ],
                    )
                )
                if reply is None or reply.message_type == MessageType.ERROR:
                    return None
            reply = await bus.call(
                Message(
                    destination="org.gnome.SettingsDaemon.Power",
                    path="/org/gnome/SettingsDaemon/Power",
                    interface="org.freedesktop.DBus.Properties",
                    member="Get",
                    signature="ss",
                    body=["org.gnome.SettingsDaemon.Power.Screen", "Brightness"],
                )
            )
            if reply and reply.message_type != MessageType.ERROR and reply.body:
                val = reply.body[0]
                v = val.value if isinstance(val, Variant) else val
                if isinstance(v, int) and 0 <= v <= 100:
                    return v
        finally:
            bus.disconnect()
    except Exception:  # noqa: BLE001 - GNOME D-Bus optional
        return None
    return None


def _linux_sysfs_backlight() -> Path | None:
    base = Path("/sys/class/backlight")
    if not base.is_dir():
        return None
    for entry in sorted(base.iterdir()):
        if (entry / "brightness").is_file() and (entry / "max_brightness").is_file():
            return entry
    return None


async def _brightness_linux_get() -> dict[str, Any]:
    if shutil.which("brightnessctl"):
        c1, cur = await _run("brightnessctl", "get")
        c2, mx = await _run("brightnessctl", "max")
        if c1 == 0 and c2 == 0 and cur.isdigit() and mx.isdigit() and int(mx) > 0:
            return {"percent": round(int(cur) * 100 / int(mx)), "backend": "brightnessctl"}
    gnome_val = await _linux_gnome_brightness()
    if gnome_val is not None:
        return {"percent": gnome_val, "backend": "gnome"}
    bl = _linux_sysfs_backlight()
    if bl is not None:
        try:
            cur_v = int((bl / "brightness").read_text().strip())
            max_v = int((bl / "max_brightness").read_text().strip())
            if max_v > 0:
                return {"percent": round(cur_v * 100 / max_v), "backend": f"sysfs:{bl.name}"}
        except (OSError, ValueError):
            pass
    if shutil.which("ddcutil"):
        code, out = await _run("ddcutil", "getvcp", "10", timeout=8.0)
        m = re.search(r"current value\s*=\s*(\d+),\s*max value\s*=\s*(\d+)", out)
        if code == 0 and m and int(m.group(2)) > 0:
            return {"percent": round(int(m.group(1)) * 100 / int(m.group(2))), "backend": "ddcutil"}
    return {
        "error": "Bildschirmhelligkeit lässt sich hier nicht auslesen (kein Backlight-Treiber, brightnessctl oder ddcutil verfügbar)."
    }


async def _brightness_linux_set(target: int) -> dict[str, Any]:
    target = max(1, min(100, int(target)))
    if shutil.which("brightnessctl"):
        code, _ = await _run("brightnessctl", "set", f"{target}%")
        if code == 0:
            after = await _brightness_linux_get()
            ok = abs((after.get("percent") or 0) - target) <= 2
            return {**after, "verified": ok}
    gnome_after = await _linux_gnome_brightness(target)
    if gnome_after is not None:
        return {"percent": gnome_after, "backend": "gnome", "verified": abs(gnome_after - target) <= 2}
    bl = _linux_sysfs_backlight()
    if bl is not None:
        try:
            max_v = int((bl / "max_brightness").read_text().strip())
            raw = max(1, round(max_v * target / 100))
            (bl / "brightness").write_text(str(raw))
            after = await _brightness_linux_get()
            return {**after, "verified": abs((after.get("percent") or 0) - target) <= 2}
        except OSError:
            pass
    if shutil.which("ddcutil"):
        code, out = await _run("ddcutil", "setvcp", "10", str(target), timeout=10.0)
        if code == 0:
            after = await _brightness_linux_get()
            return {**after, "verified": abs((after.get("percent") or 0) - target) <= 3}
        return {"error": f"ddcutil fehlgeschlagen: {out}", "verified": False}
    return {
        "error": "Helligkeit konnte nicht geändert werden (installiere brightnessctl oder ddcutil für externe Monitore).",
        "verified": False,
    }


async def _brightness_windows_get() -> dict[str, Any]:
    script = r"""
$ErrorActionPreference = 'SilentlyContinue'
$b = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness | Select-Object -First 1
if ($b) {
  [PSCustomObject]@{ percent = [int]$b.CurrentBrightness; backend = 'wmi' } | ConvertTo-Json -Compress
  exit 0
}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class MonBri {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  public struct PHYSICAL_MONITOR { public IntPtr hPhysicalMonitor; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szPhysicalMonitorDescription; }
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("dxva2.dll", SetLastError = true)] public static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hMon, out uint count);
  [DllImport("dxva2.dll", SetLastError = true)] public static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hMon, uint size, [Out] PHYSICAL_MONITOR[] arr);
  [DllImport("dxva2.dll", SetLastError = true)] public static extern bool DestroyPhysicalMonitors(uint size, [In] PHYSICAL_MONITOR[] arr);
  [DllImport("dxva2.dll", SetLastError = true)] public static extern bool GetMonitorBrightness(IntPtr hMon, out uint min, out uint cur, out uint max);
  public static int Get() {
    IntPtr hm = MonitorFromWindow(IntPtr.Zero, 1);
    uint n = 0; if (!GetNumberOfPhysicalMonitorsFromHMONITOR(hm, out n) || n == 0) return -1;
    var arr = new PHYSICAL_MONITOR[n];
    if (!GetPhysicalMonitorsFromHMONITOR(hm, n, arr)) return -1;
    try {
      uint mn, cur, mx;
      if (GetMonitorBrightness(arr[0].hPhysicalMonitor, out mn, out cur, out mx) && mx > mn) {
        return (int)Math.Round((cur - mn) * 100.0 / (mx - mn));
      }
      return -1;
    } finally { DestroyPhysicalMonitors(n, arr); }
  }
}
"@
$v = [MonBri]::Get()
if ($v -ge 0) {
  [PSCustomObject]@{ percent = $v; backend = 'ddc' } | ConvertTo-Json -Compress
} else {
  [PSCustomObject]@{ error = 'Keine Helligkeitssteuerung verfügbar (Monitor unterstützt weder WMI noch DDC/CI).' } | ConvertTo-Json -Compress
}
"""
    code, out = await _ps(script)
    if code != 0 or not out:
        return {"error": f"Helligkeit konnte nicht gelesen werden: {out or code}"}
    try:
        return json.loads(out)
    except ValueError:
        return {"error": f"Unerwartete Helligkeits-Ausgabe: {out[:200]}"}


async def _brightness_windows_set(target: int) -> dict[str, Any]:
    target = max(1, min(100, int(target)))
    script = rf"""
$ErrorActionPreference = 'SilentlyContinue'
$m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods | Select-Object -First 1
if ($m) {{
  Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{{ Brightness = [byte]{target}; Timeout = [uint32]1 }} | Out-Null
  Write-Output 'wmi'
  exit 0
}}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class MonBriSet {{
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  public struct PHYSICAL_MONITOR {{ public IntPtr hPhysicalMonitor; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szPhysicalMonitorDescription; }}
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("dxva2.dll", SetLastError = true)] public static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hMon, out uint count);
  [DllImport("dxva2.dll", SetLastError = true)] public static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hMon, uint size, [Out] PHYSICAL_MONITOR[] arr);
  [DllImport("dxva2.dll", SetLastError = true)] public static extern bool DestroyPhysicalMonitors(uint size, [In] PHYSICAL_MONITOR[] arr);
  [DllImport("dxva2.dll", SetLastError = true)] public static extern bool GetMonitorBrightness(IntPtr hMon, out uint min, out uint cur, out uint max);
  [DllImport("dxva2.dll", SetLastError = true)] public static extern bool SetMonitorBrightness(IntPtr hMon, uint newBri);
  public static bool Set(int pct) {{
    IntPtr hm = MonitorFromWindow(IntPtr.Zero, 1);
    uint n = 0; if (!GetNumberOfPhysicalMonitorsFromHMONITOR(hm, out n) || n == 0) return false;
    var arr = new PHYSICAL_MONITOR[n];
    if (!GetPhysicalMonitorsFromHMONITOR(hm, n, arr)) return false;
    try {{
      uint mn, cur, mx;
      if (!GetMonitorBrightness(arr[0].hPhysicalMonitor, out mn, out cur, out mx) || mx <= mn) return false;
      uint val = mn + (uint)Math.Round((mx - mn) * pct / 100.0);
      return SetMonitorBrightness(arr[0].hPhysicalMonitor, val);
    }} finally {{ DestroyPhysicalMonitors(n, arr); }}
  }}
}}
"@
if ([MonBriSet]::Set({target})) {{ Write-Output 'ddc' }} else {{ Write-Output 'fail' }}
"""
    code, out = await _ps(script)
    if code != 0 or out.strip() == "fail":
        return {
            "error": "Helligkeit ließ sich nicht ändern (externer Monitor unterstützt ggf. kein DDC/CI).",
            "verified": False,
        }
    after = await _brightness_windows_get()
    pct = after.get("percent")
    ok = isinstance(pct, int) and abs(pct - target) <= 3
    return {
        **after,
        "verified": ok,
        **({} if ok else {"error": "Helligkeit wurde nicht wie gewünscht übernommen."}),
    }


def _brightness_tier(a: dict[str, Any]) -> Tier:
    return Tier.T0 if a.get("level") is None and a.get("delta") is None else Tier.T1


@aura_tool(
    _brightness_tier,
    label=lambda a: (
        f"Helligkeit {a['level']} %"
        if a.get("level") is not None
        else (f"Helligkeit {int(a['delta']):+d} %" if a.get("delta") is not None else "Helligkeit lesen")
    ),
)
async def brightness(level: int | None = None, delta: int | None = None) -> dict[str, Any]:
    """Liest oder ändert die Bildschirmhelligkeit (Laptop-Display und externe DDC/CI-Monitore).

    Ohne Argumente: aktuelle Helligkeit in Prozent.

    Args:
      level: Ziel-Helligkeit in Prozent (1–100).
      delta: Relative Änderung in Prozentpunkten, z. B. +20 für heller oder -20 für dunkler.
    """
    if IS_MACOS:
        if shutil.which("brightness"):
            if level is None and delta is None:
                code, out = await _run("brightness", "-l")
                m = re.search(r"brightness\s+([0-9.]+)", out)
                if code == 0 and m:
                    return {"percent": round(float(m.group(1)) * 100), "backend": "brightness"}
                return {"error": out or "Helligkeit nicht lesbar."}
            cur_val = 50
            if delta is not None:
                cur = await brightness()
                cur_val = int(cur.get("percent") or 50)
            target = max(1, min(100, int(level) if level is not None else cur_val + int(delta or 0)))
            code, out = await _run("brightness", f"{target / 100:.2f}")
            after = await brightness()
            ok = code == 0 and abs((after.get("percent") or 0) - target) <= 3
            return {**after, "verified": ok}
        return {"error": "Unter macOS wird das Werkzeug brightness benötigt (brew install brightness)."}

    get_fn = _brightness_windows_get if IS_WINDOWS else _brightness_linux_get
    set_fn = _brightness_windows_set if IS_WINDOWS else _brightness_linux_set

    if level is None and delta is None:
        return await get_fn()

    if level is not None:
        target = max(1, min(100, int(level)))
    else:
        cur = await get_fn()
        if cur.get("error"):
            return cur
        target = max(1, min(100, int(cur.get("percent") or 50) + int(delta or 0)))
    return await set_fn(target)


# ---------- Audio-Ausgabegerät & Mikrofon ----------


async def _audio_linux_list(kind: str) -> dict[str, Any]:
    if not shutil.which("pactl"):
        return {"error": "pactl fehlt (Paket pulseaudio-utils)."}
    is_in = kind == "input"
    _, default_out = await _run("pactl", "get-default-source" if is_in else "get-default-sink")
    default_name = default_out.strip()
    _, raw = await _run("pactl", "list", "sources" if is_in else "sinks")
    devices: list[dict[str, Any]] = []
    cur: dict[str, Any] = {}
    for line in raw.splitlines():
        s = line.strip()
        if s.startswith(("Sink #", "Source #")):
            if cur.get("id"):
                devices.append(cur)
            cur = {"index": s.split("#", 1)[1].strip()}
        elif s.startswith("Name:"):
            cur["id"] = s.split(":", 1)[1].strip()
        elif s.startswith("Description:"):
            cur["name"] = s.split(":", 1)[1].strip()
        elif s.startswith("State:"):
            cur["state"] = s.split(":", 1)[1].strip()
    if cur.get("id"):
        devices.append(cur)
    if is_in:
        devices = [d for d in devices if not str(d.get("id", "")).endswith(".monitor")]
    for d in devices:
        d["active"] = d.get("id") == default_name
    return {"kind": kind, "default": default_name, "count": len(devices), "devices": devices}


async def _audio_linux_set(device: str, kind: str) -> dict[str, Any]:
    listed = await _audio_linux_list(kind)
    if listed.get("error"):
        return listed
    hit = _match_device(listed.get("devices") or [], device, "name", "id")
    if hit is None:
        return {
            "error": f"Kein Audiogerät „{device}“ gefunden.",
            "available": [d.get("name") or d.get("id") for d in listed.get("devices") or []],
        }
    is_in = kind == "input"
    cmd = "set-default-source" if is_in else "set-default-sink"
    code, out = await _run("pactl", cmd, hit["id"])
    if code != 0:
        return {"error": out or "Umschalten fehlgeschlagen.", "verified": False}
    if not is_in:
        # Laufende Wiedergabe-Streams direkt auf das neue Ausgabegerät umziehen.
        _, streams = await _run("pactl", "list", "short", "sink-inputs")
        for line in streams.splitlines():
            parts = line.split()
            if parts and parts[0].isdigit():
                await _run("pactl", "move-sink-input", parts[0], hit["id"])
    after = await _audio_linux_list(kind)
    ok = after.get("default") == hit["id"]
    return {"device": hit.get("name") or hit["id"], "id": hit["id"], "kind": kind, "verified": ok}


_WIN_AUDIO_CS = r"""
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class AuraAudioSwitch {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumerator {}

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }

  [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    int GetCount(out uint count);
    int Item(uint index, out IMMDevice device);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr pParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    int OpenPropertyStore(int stgmAccess, out IPropertyStore props);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PROPERTYKEY { public Guid fmtid; public uint pid; }

  [StructLayout(LayoutKind.Explicit)]
  struct PROPVARIANT {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr ptr;
  }

  [Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    int GetCount(out uint c);
    int GetAt(uint i, out PROPERTYKEY key);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
  }

  [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
  class PolicyConfigClient {}

  [Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPolicyConfig {
    int GetMixFormat(string id, IntPtr fmt);
    int GetDeviceFormat(string id, int def, IntPtr fmt);
    int ResetDeviceFormat(string id);
    int SetDeviceFormat(string id, IntPtr ep, IntPtr mix);
    int GetProcessingPeriod(string id, int def, IntPtr p1, IntPtr p2);
    int SetProcessingPeriod(string id, IntPtr p);
    int GetShareMode(string id, IntPtr mode);
    int SetShareMode(string id, IntPtr mode);
    int GetPropertyValue(string id, IntPtr k, IntPtr v);
    int SetPropertyValue(string id, IntPtr k, IntPtr v);
    int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
  }

  static readonly PROPERTYKEY PKEY_FriendlyName = new PROPERTYKEY {
    fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14
  };

  public class Entry { public string id; public string name; public bool active; }

  public static Entry[] List(int flow) {
    var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
    string defId = "";
    try { IMMDevice d; if (en.GetDefaultAudioEndpoint(flow, 0, out d) == 0 && d != null) d.GetId(out defId); } catch {}
    IMMDeviceCollection col;
    en.EnumAudioEndpoints(flow, 1, out col);
    uint n = 0; col.GetCount(out n);
    var res = new List<Entry>();
    for (uint i = 0; i < n; i++) {
      IMMDevice dev; col.Item(i, out dev);
      string id; dev.GetId(out id);
      string name = id;
      try {
        IPropertyStore ps; dev.OpenPropertyStore(0, out ps);
        var k = PKEY_FriendlyName; PROPVARIANT pv;
        if (ps.GetValue(ref k, out pv) == 0 && pv.vt == 31 && pv.ptr != IntPtr.Zero) {
          name = Marshal.PtrToStringUni(pv.ptr);
        }
      } catch {}
      res.Add(new Entry { id = id, name = name, active = (id == defId) });
    }
    return res.ToArray();
  }

  public static void SetDefault(string id) {
    var pc = (IPolicyConfig)new PolicyConfigClient();
    pc.SetDefaultEndpoint(id, 0); // Console
    pc.SetDefaultEndpoint(id, 1); // Multimedia
    pc.SetDefaultEndpoint(id, 2); // Communications
  }
}
"""


async def _audio_windows_list(kind: str) -> dict[str, Any]:
    flow = 1 if kind == "input" else 0
    script = f'Add-Type @"\n{_WIN_AUDIO_CS}\n"@\n[AuraAudioSwitch]::List({flow}) | ConvertTo-Json -Compress'
    code, out = await _ps(script)
    if code != 0:
        return {"error": f"Audiogeräte konnten nicht gelesen werden: {out}"}
    try:
        raw = json.loads(out) if out else []
    except ValueError:
        return {"error": f"Unerwartete Ausgabe: {out[:200]}"}
    if isinstance(raw, dict):
        raw = [raw]
    devices = [
        {"id": str(d.get("id", "")), "name": str(d.get("name", "")), "active": bool(d.get("active"))}
        for d in raw
        if isinstance(d, dict)
    ]
    default_id = next((d["id"] for d in devices if d["active"]), "")
    return {"kind": kind, "default": default_id, "count": len(devices), "devices": devices}


async def _audio_windows_set(device: str, kind: str) -> dict[str, Any]:
    listed = await _audio_windows_list(kind)
    if listed.get("error"):
        return listed
    hit = _match_device(listed.get("devices") or [], device, "name", "id")
    if hit is None:
        return {
            "error": f"Kein Audiogerät „{device}“ gefunden.",
            "available": [d["name"] for d in listed.get("devices") or []],
        }
    script = f'Add-Type @"\n{_WIN_AUDIO_CS}\n"@\n[AuraAudioSwitch]::SetDefault({_ps_quote(hit["id"])})\nWrite-Output ok'
    code, out = await _ps(script)
    if code != 0:
        return {"error": f"Audiogerät konnte nicht umgestellt werden: {out}", "verified": False}
    after = await _audio_windows_list(kind)
    ok = after.get("default") == hit["id"]
    return {"device": hit["name"], "id": hit["id"], "kind": kind, "verified": ok}


def _audio_tier(a: dict[str, Any]) -> Tier:
    return Tier.T0 if str(a.get("action") or "list").strip().lower() == "list" else Tier.T1


@aura_tool(
    _audio_tier,
    label=lambda a: (
        f"Audiogerät ({a.get('kind', 'output')}): {a.get('device', '')}"
        if str(a.get("action") or "list").lower() == "set"
        else f"Audiogeräte ({a.get('kind', 'output')})"
    ),
)
async def audio_device(action: str = "list", device: str = "", kind: str = "output") -> dict[str, Any]:
    """Listet Audio-Ausgabegeräte (Lautsprecher, Kopfhörer) oder Mikrofone auf und schaltet das aktive Gerät um.

    Args:
      action: "list" (Geräte anzeigen) oder "set" (als Standardgerät wählen).
      device: Name oder Namensteil des Geräts (nur bei action="set"), z. B. "Sony", "Headphones", "Lautsprecher".
      kind: "output" (Lautsprecher/Kopfhörer, Standard) oder "input" (Mikrofon).
    """
    act = action.strip().lower()
    k = kind.strip().lower()
    if act not in ("list", "set"):
        return {"error": "action muss 'list' oder 'set' sein."}
    if k not in ("output", "input"):
        return {"error": "kind muss 'output' oder 'input' sein."}
    if IS_WINDOWS:
        if act == "list":
            return await _audio_windows_list(k)
        if not device.strip():
            return {"error": "Bitte gib den Namen des Audiogeräts (device) an."}
        return await _audio_windows_set(device, k)
    if IS_MACOS:
        if shutil.which("SwitchAudioSource"):
            t_flag = "input" if k == "input" else "output"
            if act == "list":
                _, cur = await _run("SwitchAudioSource", "-c", "-t", t_flag)
                _, all_out = await _run("SwitchAudioSource", "-a", "-t", t_flag)
                devs = [
                    {"name": line.strip(), "id": line.strip(), "active": line.strip() == cur.strip()}
                    for line in all_out.splitlines()
                    if line.strip()
                ]
                return {"kind": k, "default": cur.strip(), "count": len(devs), "devices": devs}
            listed = await audio_device("list", kind=k)
            hit = _match_device(listed.get("devices") or [], device, "name")
            if not hit:
                return {"error": f"Kein Audiogerät „{device}“ gefunden.", "available": listed.get("devices")}
            await _run("SwitchAudioSource", "-s", hit["name"], "-t", t_flag)
            after = await audio_device("list", kind=k)
            return {"device": hit["name"], "kind": k, "verified": after.get("default") == hit["name"]}
        return {"error": "Unter macOS wird SwitchAudioSource benötigt (brew install switchaudio-osx)."}
    if act == "list":
        return await _audio_linux_list(k)
    if not device.strip():
        return {"error": "Bitte gib den Namen des Audiogeräts (device) an."}
    return await _audio_linux_set(device, k)


# ---------- WLAN ----------


def _wifi_tier(a: dict[str, Any]) -> tuple[Tier, str]:
    act = str(a.get("action") or "status").strip().lower()
    if act in ("status", "list"):
        return Tier.T0, ""
    if act in ("off", "disconnect"):
        return Tier.T2, "trennt die WLAN-Verbindung (kann Internetzugang unterbrechen)"
    return Tier.T1, ""


@aura_tool(
    _wifi_tier,
    label=lambda a: (
        f"WLAN {a.get('action', 'status')}" + (f": {a.get('network', '')}" if a.get("network") else "")
    ),
)
async def wifi(action: str = "status", network: str = "") -> dict[str, Any]:
    """Zeigt WLAN-Status und verfügbare Netze oder verbindet/trennt bekannte WLANs.

    Args:
      action: "status" (aktuelles Netz & Status), "list" (verfügbare Netze scannen), "connect", "disconnect", "on" oder "off".
      network: Name (SSID) des WLANs für connect.
    """
    act = action.strip().lower()
    if act not in ("status", "list", "connect", "disconnect", "on", "off"):
        return {"error": "action muss status, list, connect, disconnect, on oder off sein."}

    if IS_WINDOWS:
        if act == "status":
            code, out = await _run("netsh", "wlan", "show", "interfaces")
            if code != 0:
                return {"error": out or "WLAN-Status nicht lesbar."}
            ssid_m = re.search(r"^\s*SSID\s*:\s*(.+)$", out, re.MULTILINE)
            state_m = re.search(r"^\s*(?:State|Status)\s*:\s*(.+)$", out, re.MULTILINE)
            sig_m = re.search(r"^\s*Signal\s*:\s*(\d+%)", out, re.MULTILINE)
            return {
                "ssid": ssid_m.group(1).strip() if ssid_m else "",
                "state": state_m.group(1).strip() if state_m else "",
                "signal": sig_m.group(1).strip() if sig_m else "",
            }
        if act == "list":
            code, out = await _run("netsh", "wlan", "show", "networks", "mode=bssid")
            if code != 0:
                return {"error": out or "WLAN-Suche fehlgeschlagen."}
            ssids = sorted(
                {
                    m.group(1).strip()
                    for m in re.finditer(r"^\s*SSID\s+\d+\s*:\s*(.+)$", out, re.MULTILINE)
                    if m.group(1).strip()
                }
            )
            return {"count": len(ssids), "networks": ssids}
        if act == "connect":
            if not network.strip():
                return {"error": "Bitte gib den Namen (SSID) des WLANs an."}
            code, out = await _run("netsh", "wlan", "connect", f"name={network.strip()}")
            await asyncio.sleep(1.5)
            st = await wifi("status")
            ok = code == 0 and st.get("ssid", "").lower() == network.strip().lower()
            return {**st, "verified": ok, **({} if ok else {"error": out or "Verbindung fehlgeschlagen."})}
        if act == "disconnect":
            code, out = await _run("netsh", "wlan", "disconnect")
            await asyncio.sleep(0.8)
            st = await wifi("status")
            return {**st, "verified": code == 0 and not st.get("ssid")}
        # on / off via WinRT Radio
        state = "On" if act == "on" else "Off"
        code, out = await _ps(
            rf"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {{
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
}})[0]
function AwaitWinRT($op, $type) {{
  $m = $asTaskGeneric.MakeGenericMethod($type); $t = $m.Invoke($null, @($op)); $t.Wait(8000) | Out-Null; return $t.Result
}}
[Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null
[Windows.Devices.Radios.RadioState,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null
[Windows.Devices.Radios.RadioAccessStatus,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null
$radios = AwaitWinRT ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
$w = $radios | Where-Object {{ $_.Kind -eq 'WiFi' }} | Select-Object -First 1
if (-not $w) {{ throw 'Kein WLAN-Adapter gefunden.' }}
$null = AwaitWinRT ($w.SetStateAsync([Windows.Devices.Radios.RadioState]::{state})) ([Windows.Devices.Radios.RadioAccessStatus])
Write-Output ($w.State -eq 'On')
"""
        )
        ok = code == 0 and (out.strip().lower() == ("true" if act == "on" else "false"))
        return {"enabled": act == "on", "verified": ok, **({} if ok else {"error": out})}

    if IS_MACOS:
        return {
            "error": "WLAN-Steuerung unter macOS nutzt networksetup (bitte über run_command oder Systemeinstellungen)."
        }

    # Linux (nmcli)
    if not shutil.which("nmcli"):
        return {"error": "nmcli fehlt (Paket network-manager)."}
    if act == "status":
        _, radio = await _run("nmcli", "radio", "wifi")
        _, active = await _run("nmcli", "-t", "-f", "ACTIVE,SSID,SIGNAL", "dev", "wifi")
        cur_ssid, sig = "", ""
        for line in active.splitlines():
            parts = line.split(":")
            if len(parts) >= 3 and parts[0] == "yes":
                cur_ssid, sig = parts[1], f"{parts[2]}%"
                break
        return {"enabled": radio.strip().lower() == "enabled", "ssid": cur_ssid, "signal": sig}
    if act == "list":
        code, out = await _run("nmcli", "-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "dev", "wifi", "list")
        if code != 0:
            return {"error": out or "WLAN-Scan fehlgeschlagen."}
        nets: list[dict[str, Any]] = []
        seen: set[str] = set()
        for line in out.splitlines():
            parts = line.split(":")
            if len(parts) >= 4 and parts[1] and parts[1] not in seen:
                seen.add(parts[1])
                nets.append(
                    {
                        "ssid": parts[1],
                        "signal": parts[2],
                        "security": parts[3],
                        "active": parts[0].strip() == "*",
                    }
                )
        return {"count": len(nets), "networks": nets[:25]}
    if act in ("on", "off"):
        code, out = await _run("nmcli", "radio", "wifi", act)
        st = await wifi("status")
        ok = code == 0 and st.get("enabled") is (act == "on")
        return {**st, "verified": ok, **({} if ok else {"error": out})}
    if act == "connect":
        if not network.strip():
            return {"error": "Bitte gib den Namen (SSID) des WLANs an."}
        code, out = await _run("nmcli", "con", "up", network.strip(), timeout=20.0)
        if code != 0:
            code, out = await _run("nmcli", "dev", "wifi", "connect", network.strip(), timeout=20.0)
        st = await wifi("status")
        ok = code == 0 and st.get("ssid") == network.strip()
        return {**st, "verified": ok, **({} if ok else {"error": out or "Verbindung fehlgeschlagen."})}
    # disconnect
    _, devs = await _run("nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "dev")
    wifi_dev = next(
        (line.split(":")[0] for line in devs.splitlines() if ":wifi:connected" in line),
        "",
    )
    if not wifi_dev:
        return {"verified": True, "note": "WLAN war bereits getrennt."}
    code, out = await _run("nmcli", "dev", "disconnect", wifi_dev)
    st = await wifi("status")
    return {**st, "verified": code == 0 and not st.get("ssid"), **({} if code == 0 else {"error": out})}


# ---------- System-Schnellmodi (Nicht stören, Nachtlicht, Energiesparmodus, Sperren, Standby) ----------


def _mode_tier(a: dict[str, Any]) -> tuple[Tier, str]:
    feat = str(a.get("feature") or "").strip().lower()
    if feat == "sleep":
        return Tier.T2, "versetzt den Computer in den Ruhemodus (Standby)"
    if feat == "lock_screen":
        return Tier.T1, ""
    if a.get("on") is None and not a.get("profile"):
        return Tier.T0, ""
    return Tier.T1, ""


@aura_tool(
    _mode_tier,
    label=lambda a: (
        f"Systemmodus {a.get('feature', '')}"
        + (f" = {'an' if a['on'] else 'aus'}" if a.get("on") is not None else "")
        + (f" ({a['profile']})" if a.get("profile") else "")
    ),
)
async def device_mode(feature: str, on: bool | None = None, profile: str = "") -> dict[str, Any]:
    """Steuert Schnell-Modi des PCs wie im Kontrollzentrum: Nicht stören, Nachtlicht, Energiesparmodus, Bildschirm sperren oder Ruhemodus.

    Args:
      feature: "dnd" (Nicht stören / Benachrichtigungen aus), "night_light" (Nachtlicht / Blaulichtfilter), "power_saver" (Energiesparmodus / Leistungsprofil), "lock_screen" (Bildschirm sperren) oder "sleep" (Standby/Ruhemodus).
      on: true = einschalten, false = ausschalten. Ohne on wird nur der aktuelle Zustand gelesen.
      profile: Optional für feature="power_saver": "power-saver", "balanced" oder "performance".
    """
    feat = feature.strip().lower()
    if feat not in ("dnd", "night_light", "power_saver", "lock_screen", "sleep"):
        return {"error": "feature muss dnd, night_light, power_saver, lock_screen oder sleep sein."}

    if feat == "lock_screen":
        if IS_WINDOWS:
            import ctypes

            ok = bool(await asyncio.to_thread(ctypes.WinDLL("user32").LockWorkStation))  # pyright: ignore[reportAttributeAccessIssue]
            return {"feature": feat, "verified": ok}
        if IS_MACOS:
            code, out = await _run("pmset", "displaysleepnow")
            return {"feature": feat, "verified": code == 0, **({} if code == 0 else {"error": out})}
        for cmd in (("loginctl", "lock-session"), ("gnome-screensaver-command", "-l")):
            if shutil.which(cmd[0]):
                code, out = await _run(*cmd)
                if code == 0:
                    return {"feature": feat, "verified": True}
        return {"error": "Bildschirm konnte nicht gesperrt werden (loginctl fehlt).", "verified": False}

    if feat == "sleep":
        if IS_WINDOWS:
            code, out = await _run("rundll32.exe", "powrprof.dll,SetSuspendState", "0,1,0")
            return {"feature": feat, "verified": code == 0, **({} if code == 0 else {"error": out})}
        if IS_MACOS:
            code, out = await _run("pmset", "sleepnow")
            return {"feature": feat, "verified": code == 0, **({} if code == 0 else {"error": out})}
        code, out = await _run("systemctl", "suspend")
        return {"feature": feat, "verified": code == 0, **({} if code == 0 else {"error": out})}

    if feat == "dnd":
        if IS_WINDOWS:
            from .win_settings import NOTIFICATIONS
            from .win_settings import settings as win_settings

            if on is None:
                res = await win_settings(NOTIFICATIONS, "ToastEnabled")
                if res.get("error"):
                    return res
                return {"feature": "dnd", "on": res.get("value") == 0}
            res = await win_settings(NOTIFICATIONS, "ToastEnabled", "0" if on else "1")
            return {
                "feature": "dnd",
                "on": on,
                "verified": bool(res.get("verified")),
                **({"error": res["error"]} if res.get("error") else {}),
            }
        if not IS_MACOS:
            from .system import settings as gnome_settings

            if on is None:
                res = await gnome_settings("org.gnome.desktop.notifications", "show-banners")
                if res.get("error"):
                    return res
                return {"feature": "dnd", "on": str(res.get("value")).lower() == "false"}
            res = await gnome_settings(
                "org.gnome.desktop.notifications", "show-banners", "false" if on else "true"
            )
            return {
                "feature": "dnd",
                "on": on,
                "verified": bool(res.get("verified")),
                **({"error": res["error"]} if res.get("error") else {}),
            }
        return {"error": "Nicht stören wird unter macOS über das Kontrollzentrum gesteuert."}

    if feat == "night_light":
        if IS_WINDOWS:
            # Windows 10/11 speichert Nachtlicht in CloudStore; alternativ direkte Einstellungsseite.
            code, out = await _ps(
                r"""
$p = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\CloudStore\Store\DefaultAccount\Current\default$windows.data.bluelightreduction.bluelightreductionstate\windows.data.bluelightreduction.bluelightreductionstate'
$d = (Get-ItemProperty -Path $p -Name Data -ErrorAction SilentlyContinue).Data
if (-not $d) { Write-Output 'missing'; exit 0 }
$isOn = ($d.Length -gt 18 -and $d[18] -eq 0x15)
Write-Output ($isOn)
"""
            )
            if on is None:
                if out.strip() == "missing":
                    return {"feature": "night_light", "on": False, "note": "Nachtlicht noch nie aktiviert."}
                return {"feature": "night_light", "on": out.strip().lower() == "true"}
            # Windows-Einstellungen ms-settings:nightlight öffnen falls CloudStore-Toggle nicht trivial
            want = "$true" if on else "$false"
            code2, out2 = await _ps(
                rf"""
$ErrorActionPreference = 'Stop'
$p = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\CloudStore\Store\DefaultAccount\Current\default$windows.data.bluelightreduction.bluelightreductionstate\windows.data.bluelightreduction.bluelightreductionstate'
$data = [byte[]](Get-ItemProperty -Path $p -Name Data).Data
$want = {want}
$isOn = ($data.Length -gt 18 -and $data[18] -eq 0x15)
if ($isOn -eq $want) {{ Write-Output 'already'; exit 0 }}
$newData = New-Object System.Collections.Generic.List[byte]
if ($want) {{
  for ($i=0; $i -lt 18; $i++) {{ $newData.Add($data[$i]) }}
  $newData.Add(0x15); $newData.Add($data[19]); $newData.Add($data[20]); $newData.Add($data[21])
  $newData.Add(0x10); $newData.Add(0x00)
  for ($i=22; $i -lt $data.Length; $i++) {{ $newData.Add($data[$i]) }}
}} else {{
  for ($i=0; $i -lt 18; $i++) {{ $newData.Add($data[$i]) }}
  $newData.Add(0x13); $newData.Add($data[19]); $newData.Add($data[20]); $newData.Add($data[21])
  for ($i=24; $i -lt $data.Length; $i++) {{ $newData.Add($data[$i]) }}
}}
$newData[10] = [byte](($newData[10] + 1) -band 0xFF)
Set-ItemProperty -Path $p -Name Data -Value ([byte[]]$newData.ToArray())
Write-Output 'ok'
"""
            )
            ok = code2 == 0 and out2.strip() in ("ok", "already")
            return {
                "feature": "night_light",
                "on": on,
                "verified": ok,
                **({} if ok else {"error": f"Nachtlicht konnte nicht umgeschaltet werden: {out2}"}),
            }
        if not IS_MACOS:
            from .system import settings as gnome_settings

            if on is None:
                res = await gnome_settings("org.gnome.settings-daemon.plugins.color", "night-light-enabled")
                if res.get("error"):
                    return res
                return {"feature": "night_light", "on": str(res.get("value")).lower() == "true"}
            res = await gnome_settings(
                "org.gnome.settings-daemon.plugins.color", "night-light-enabled", "true" if on else "false"
            )
            return {
                "feature": "night_light",
                "on": on,
                "verified": bool(res.get("verified")),
                **({"error": res["error"]} if res.get("error") else {}),
            }
        return {"error": "Night Shift wird unter macOS über die Systemeinstellungen gesteuert."}

    # power_saver / Leistungsprofil
    target_prof = profile.strip().lower() or (
        "power-saver" if on is True else ("balanced" if on is False else "")
    )
    if IS_WINDOWS:
        schemes = {
            "power-saver": "a1841308-3541-4fab-bc81-f71556f20b4a",
            "balanced": "381b4222-f694-41f0-9685-ff5bb260df2e",
            "performance": "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c",
        }
        if not target_prof:
            code, out = await _run("powercfg", "/getactivescheme")
            return {"feature": "power_saver", "active": out} if code == 0 else {"error": out}
        guid = schemes.get(target_prof)
        if not guid:
            return {"error": "profile muss power-saver, balanced oder performance sein."}
        code, out = await _run("powercfg", "/setactive", guid)
        _, after = await _run("powercfg", "/getactivescheme")
        ok = code == 0 and guid in after.lower()
        return {"feature": "power_saver", "profile": target_prof, "active": after, "verified": ok}

    if not IS_MACOS and shutil.which("powerprofilesctl"):
        if not target_prof:
            code, out = await _run("powerprofilesctl", "get")
            return {"feature": "power_saver", "profile": out.strip()} if code == 0 else {"error": out}
        if target_prof not in ("power-saver", "balanced", "performance"):
            return {"error": "profile muss power-saver, balanced oder performance sein."}
        code, out = await _run("powerprofilesctl", "set", target_prof)
        _, after = await _run("powerprofilesctl", "get")
        ok = code == 0 and after.strip() == target_prof
        return {
            "feature": "power_saver",
            "profile": after.strip(),
            "verified": ok,
            **({} if ok else {"error": out}),
        }
    return {"error": "Leistungsprofile werden auf diesem System nicht direkt unterstützt."}
