"""Everyday context: where the user is and what the weather does (AURA-116).

Location sources, chosen by the user in the Zentrale (profile → Standort):
  device:  automatic via the OS / device GPS location service with network/IP fallback (default)
  ip:      approximate, city level, from the IP address via ipapi.co / ipwho.is
  profile: only the place the user typed into the profile (no automatic location lookup)

Weather comes from Open-Meteo (no key, open data): geocoding-api.open-meteo.com and api.open-meteo.com. Both are
listed in docs/security/privacy.md. Results are cached for 15 minutes.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import sys
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from ..harness.tiers import Tier, aura_tool

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
REVERSE_GEOCODE_URL = "https://nominatim.openstreetmap.org/reverse"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
IP_URL = "https://ipapi.co/json/"
IP_FALLBACK_URL = "https://ipwho.is/"
CACHE_S = 15 * 60
TIMEOUT_S = 10
DEVICE_TIMEOUT_S = 2.5

DeviceProvider = Callable[[], Awaitable[tuple[float, float, float | None] | None]]

# WMO weather interpretation codes (Open-Meteo docs) → German.
WEATHER_CODES = {
    0: "klar",
    1: "überwiegend klar",
    2: "teils bewölkt",
    3: "bedeckt",
    45: "Nebel",
    48: "Nebel mit Reif",
    51: "leichter Nieselregen",
    53: "Nieselregen",
    55: "starker Nieselregen",
    56: "gefrierender Nieselregen",
    57: "starker gefrierender Nieselregen",
    61: "leichter Regen",
    63: "Regen",
    65: "starker Regen",
    66: "gefrierender Regen",
    67: "starker gefrierender Regen",
    71: "leichter Schneefall",
    73: "Schneefall",
    75: "starker Schneefall",
    77: "Schneegriesel",
    80: "leichte Regenschauer",
    81: "Regenschauer",
    82: "heftige Regenschauer",
    85: "leichte Schneeschauer",
    86: "starke Schneeschauer",
    95: "Gewitter",
    96: "Gewitter mit leichtem Hagel",
    97: "Gewitter mit Hagel",
    99: "Gewitter mit starkem Hagel",
}

NO_PLACE = (
    "Kein Ort bekannt. Frag den Nutzer einmal, für welchen Ort, und erwähne, dass er seinen Ort in der Aura Zentrale "
    "unter „Profil“ eintragen kann."
)


def describe(code: Any) -> str:
    try:
        return WEATHER_CODES.get(int(code), f"Wettercode {code}")
    except (TypeError, ValueError):
        return "unbekannt"


@dataclass
class Place:
    name: str
    latitude: float
    longitude: float
    source: str
    accuracy: str
    timezone: str = "auto"


def _parse_etc_geolocation(path: Path = Path("/etc/geolocation")) -> tuple[float, float, float | None] | None:
    """Reads static coordinates from /etc/geolocation (man 5 geoclue) if present."""
    try:
        if not path.is_file():
            return None
        lines = [
            ln.strip()
            for ln in path.read_text(encoding="utf-8").splitlines()
            if ln.strip() and not ln.strip().startswith("#")
        ]
        if len(lines) < 2:
            return None
        lat = float(lines[0])
        lon = float(lines[1])
        acc = float(lines[3]) if len(lines) >= 4 else None
        if -90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0:
            return (lat, lon, acc)
    except (OSError, ValueError):
        return None
    return None


async def _run_json_probe(cmd: list[str], timeout: float = DEVICE_TIMEOUT_S) -> dict[str, Any] | None:
    """Runs a quick OS location helper subprocess and parses a JSON line."""
    proc: asyncio.subprocess.Process | None = None
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        if proc.returncode != 0 or not stdout:
            return None
        data = json.loads(stdout.decode("utf-8", errors="replace").strip().splitlines()[-1])
        return data if isinstance(data, dict) else None
    except (OSError, TimeoutError, ValueError):
        if proc is not None and proc.returncode is None:
            try:
                proc.kill()
                await proc.wait()
            except OSError:
                pass
        return None


async def _probe_os_gps() -> tuple[float, float, float | None] | None:
    """Queries the native OS location / GPS service (Linux GeoClue2/GPSD, Windows Location API, macOS CoreLocation)."""
    if sys.platform.startswith("linux"):
        static = _parse_etc_geolocation()
        if static is not None:
            return static
        # Query GeoClue2 via system python3 (which has PyGObject/gir1.2-geoclue-2.0 when installed).
        sys_py = shutil.which("/usr/bin/python3") or sys.executable
        script = (
            "import json, gi; gi.require_version('Geoclue', '2.0'); "
            "from gi.repository import Geoclue; "
            "s = Geoclue.Simple.new_sync('firefox', Geoclue.AccuracyLevel.EXACT, None); "
            "loc = s.get_location(); "
            "print(json.dumps({'lat': loc.get_property('latitude'), "
            "'lon': loc.get_property('longitude'), 'acc': loc.get_property('accuracy')}))"
        )
        data = await _run_json_probe([sys_py, "-c", script])
    elif sys.platform == "win32":
        ps = shutil.which("powershell.exe") or "powershell"
        script = (
            "Add-Type -AssemblyName System.Device; "
            "$w = New-Object System.Device.Location.GeoCoordinateWatcher([System.Device.Location.GeoPositionAccuracy]::High); "
            "$w.Start(); "
            "$n = 0; while (($w.Status -ne 'Ready') -and ($n -lt 20)) { Start-Sleep -Milliseconds 100; $n++ }; "
            "$c = $w.Position.Location; $w.Stop(); "
            "if (-not $c.IsUnknown) { "
            "@{lat=$c.Latitude; lon=$c.Longitude; acc=$c.HorizontalAccuracy} | ConvertTo-Json -Compress "
            "}"
        )
        data = await _run_json_probe([ps, "-NoProfile", "-NonInteractive", "-Command", script], timeout=3.0)
    elif sys.platform == "darwin":
        cli = shutil.which("CoreLocationCLI")
        if not cli:
            return None
        data = await _run_json_probe([cli, "-json", "-once"], timeout=3.0)
    else:
        return None

    if not data:
        return None
    try:
        lat = float(data["lat"] if "lat" in data else data["latitude"])
        lon = float(data["lon"] if "lon" in data else data["longitude"])
        acc_raw = data.get("acc", data.get("hAccuracy"))
        acc = float(acc_raw) if acc_raw is not None else None
        if -90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0:
            return (lat, lon, acc)
    except (KeyError, TypeError, ValueError):
        return None
    return None


class ContextService:
    """Location and weather with a small cache. `client` is injectable for tests (httpx.MockTransport)."""

    def __init__(
        self,
        mode: str = "device",
        profile_place: str = "",
        client: httpx.AsyncClient | None = None,
        device_provider: DeviceProvider | None = None,
    ) -> None:
        self.mode = mode if mode in ("profile", "ip", "device") else "device"
        self.profile_place = profile_place.strip()
        self._client = client
        self._device_provider = device_provider
        self._cache: dict[str, tuple[float, Any]] = {}
        self._device_place_cache: tuple[float, Place] | None = None

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=TIMEOUT_S, headers={"User-Agent": "Aura (github.com/fischersase/aura)"}
            )
        return self._client

    async def _get(self, url: str, params: dict[str, Any] | None = None) -> Any:
        key = url + "?" + "&".join(f"{k}={v}" for k, v in sorted((params or {}).items()))
        hit = self._cache.get(key)
        if hit and time.monotonic() - hit[0] < CACHE_S:
            return hit[1]
        try:
            r = await self._http().get(url, params=params)
        except httpx.TransportError:
            # One retry: a single dropped connection should not cost the answer (seen in evals, 2026-10-13).
            r = await self._http().get(url, params=params)
        r.raise_for_status()
        data = r.json()
        self._cache[key] = (time.monotonic(), data)
        return data

    async def geocode(self, name: str) -> Place | None:
        # "Hamburg, MEZ" → "Hamburg": the profile field mixes place and time zone.
        query = name.split(",")[0].strip()
        if not query:
            return None
        data = await self._get(GEOCODE_URL, {"name": query, "count": 1, "language": "de", "format": "json"})
        results = data.get("results") or []
        if not results:
            return None
        r = results[0]
        label = ", ".join(str(x) for x in (r.get("name"), r.get("admin1"), r.get("country")) if x)
        return Place(
            label,
            float(r["latitude"]),
            float(r["longitude"]),
            "geocoded",
            "city",
            r.get("timezone") or "auto",
        )

    async def _reverse_geocode(self, latitude: float, longitude: float) -> str:
        """Resolves GPS coordinates to a German place label via OpenStreetMap Nominatim."""
        try:
            data = await self._get(
                REVERSE_GEOCODE_URL,
                {
                    "format": "jsonv2",
                    "lat": round(latitude, 4),
                    "lon": round(longitude, 4),
                    "accept-language": "de",
                },
            )
            addr = data.get("address") if isinstance(data, dict) else None
            if isinstance(addr, dict):
                city = (
                    addr.get("city")
                    or addr.get("town")
                    or addr.get("village")
                    or addr.get("municipality")
                    or addr.get("county")
                )
                parts = [str(x) for x in (city, addr.get("state"), addr.get("country")) if x]
                if parts:
                    return ", ".join(parts)
            if isinstance(data, dict) and data.get("display_name"):
                return str(data["display_name"])
        except httpx.HTTPError:
            pass
        return f"{latitude:.4f}, {longitude:.4f}"

    async def _ip_location(self, source: str = "ip") -> Place | None:
        """Resolves approximate city-level coordinates from IP address (ipapi.co with ipwho.is fallback)."""
        for url in (IP_URL, IP_FALLBACK_URL):
            try:
                data = await self._get(url)
            except httpx.HTTPError:
                continue
            if not isinstance(data, dict) or data.get("latitude") is None or data.get("longitude") is None:
                continue
            country = data.get("country_name") or data.get("country")
            label = ", ".join(str(x) for x in (data.get("city"), data.get("region"), country) if x)
            tz_raw = data.get("timezone")
            tz = str(tz_raw.get("id") or "auto") if isinstance(tz_raw, dict) else str(tz_raw or "auto")
            return Place(
                label or "unbekannt",
                float(data["latitude"]),
                float(data["longitude"]),
                source,
                "ungefähr (Stadt)",
                tz,
            )
        return None

    async def _device_location(self) -> Place | None:
        """Reads hardware/OS GPS coordinates and reverse-geocodes them, with 15-minute caching."""
        if self._device_place_cache and time.monotonic() - self._device_place_cache[0] < CACHE_S:
            return self._device_place_cache[1]
        provider = self._device_provider or _probe_os_gps
        coords = await provider()
        if coords is None:
            return None
        lat, lon, acc = coords
        label = await self._reverse_geocode(lat, lon)
        acc_label = f"genau (GPS ±{round(acc)} m)" if acc and acc > 0 else "genau (GPS / Gerät)"
        place = Place(label, lat, lon, "device", acc_label, "auto")
        self._device_place_cache = (time.monotonic(), place)
        return place

    async def current(self) -> Place | None:
        """The user's location from the chosen source, or None."""
        if self.mode == "device":
            device_place = await self._device_location()
            if device_place is not None:
                return device_place
            if self.profile_place:
                place = await self.geocode(self.profile_place)
                if place:
                    place.source = "profile"
                    return place
            return await self._ip_location(source="device")
        if self.mode == "ip":
            ip_place = await self._ip_location(source="ip")
            if ip_place is not None:
                return ip_place
        if self.profile_place:
            place = await self.geocode(self.profile_place)
            if place:
                place.source = "profile"
                return place
        return None

    async def forecast(self, place: Place, days: int) -> dict[str, Any]:
        days = max(1, min(int(days or 1), 7))
        data = await self._get(
            FORECAST_URL,
            {
                "latitude": round(place.latitude, 3),
                "longitude": round(place.longitude, 3),
                "current": "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
                "hourly": "temperature_2m,precipitation_probability,weather_code",
                "daily": (
                    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,"
                    "precipitation_probability_max,wind_speed_10m_max,sunrise,sunset"
                ),
                "timezone": place.timezone or "auto",
                "forecast_days": days + 1,
            },
        )
        cur = data.get("current") or {}
        daily = data.get("daily") or {}
        hourly = data.get("hourly") or {}
        out_days = []
        for i, day in enumerate(daily.get("time") or []):
            out_days.append(
                {
                    "datum": day,
                    "wetter": describe((daily.get("weather_code") or [None])[i]),
                    "max_c": (daily.get("temperature_2m_max") or [None])[i],
                    "min_c": (daily.get("temperature_2m_min") or [None])[i],
                    "niederschlag_mm": (daily.get("precipitation_sum") or [None])[i],
                    "regenwahrscheinlichkeit_pct": (daily.get("precipitation_probability_max") or [None])[i],
                    "wind_max_kmh": (daily.get("wind_speed_10m_max") or [None])[i],
                    "sonnenaufgang": (daily.get("sunrise") or [None])[i],
                    "sonnenuntergang": (daily.get("sunset") or [None])[i],
                }
            )
        today = (daily.get("time") or [""])[0]
        hours = [
            {
                "zeit": t[11:16],
                "c": (hourly.get("temperature_2m") or [None])[i],
                "regen_pct": (hourly.get("precipitation_probability") or [None])[i],
                "wetter": describe((hourly.get("weather_code") or [None])[i]),
            }
            for i, t in enumerate(hourly.get("time") or [])
            if t.startswith(today) and int(t[11:13]) % 3 == 0
        ]
        return {
            "ort": place.name,
            "quelle_ort": place.source,
            "jetzt": {
                "c": cur.get("temperature_2m"),
                "gefuehlt_c": cur.get("apparent_temperature"),
                "wetter": describe(cur.get("weather_code")),
                "niederschlag_mm": cur.get("precipitation"),
                "wind_kmh": cur.get("wind_speed_10m"),
            },
            "heute_stuendlich": hours,
            "tage": out_days,
            "quelle": "Open-Meteo",
        }


def make_context_tools(service: ContextService) -> list[Any]:
    @aura_tool(Tier.T0, label=lambda a: "Standort")
    async def location() -> dict[str, Any]:
        """Ermittelt, wo der Nutzer ungefähr ist (Ort und Koordinaten), aus der Quelle, die er in Aura gewählt hat.

        Für Fragen wie „Wo bin ich?“ oder wenn ein Ort fehlt (Wetter, Öffnungszeiten in der Nähe, Zeitzone).
        """
        try:
            place = await service.current()
        except httpx.HTTPError as e:
            return {"error": f"Standort nicht ermittelbar ({e.__class__.__name__})."}
        if place is None:
            return {"error": NO_PLACE}
        return {
            "ort": place.name,
            "breite": round(place.latitude, 2),
            "laenge": round(place.longitude, 2),
            "quelle": place.source,
            "genauigkeit": place.accuracy,
        }

    @aura_tool(Tier.T0, label=lambda a: f"Wetter {a.get('place') or ''}".strip())
    async def weather(place: str = "", days: int = 1) -> dict[str, Any]:
        """Wettervorhersage: jetzt, heute stündlich und für die nächsten Tage (Temperatur, Regen, Wind).

        Nutze das für jede Frage nach Wetter, Regen, Schirm, Temperatur oder Sonnenauf- und -untergang,
        statt im Internet zu suchen.

        Args:
          place: Ort, z. B. "München". Leer = der Ort des Nutzers.
          days: Wie viele Tage ab heute (1 = heute und morgen, höchstens 7).
        """
        try:
            target = await service.geocode(place) if place.strip() else await service.current()
            if target is None:
                return {"error": f"Ort „{place}“ nicht gefunden." if place.strip() else NO_PLACE}
            return await service.forecast(target, days)
        except httpx.HTTPError as e:
            return {
                "error": f"Wetterdienst nicht erreichbar ({e.__class__.__name__}). Sag das dem Nutzer ehrlich."
            }

    return [location, weather]
