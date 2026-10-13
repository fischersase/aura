"""Everyday context: where the user is and what the weather does (AURA-116).

Location sources, chosen by the user in the Zentrale (profile → Standort):
  profile: the place the user typed into the profile (default; no network call for the location itself)
  ip:      approximate, city level, from the IP address via ipapi.co (opt-in, sends the IP to that service)
  device:  the OS location service (follow-up subtask; until then like "profile")

Weather comes from Open-Meteo (no key, open data): geocoding-api.open-meteo.com and api.open-meteo.com. Both are
listed in docs/security/privacy.md. Results are cached for 15 minutes.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import httpx

from ..harness.tiers import Tier, aura_tool

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
IP_URL = "https://ipapi.co/json/"
CACHE_S = 15 * 60
TIMEOUT_S = 10

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


class ContextService:
    """Location and weather with a small cache. `client` is injectable for tests (httpx.MockTransport)."""

    def __init__(
        self, mode: str = "profile", profile_place: str = "", client: httpx.AsyncClient | None = None
    ) -> None:
        self.mode = mode if mode in ("profile", "ip", "device") else "profile"
        self.profile_place = profile_place.strip()
        self._client = client
        self._cache: dict[str, tuple[float, Any]] = {}

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

    async def current(self) -> Place | None:
        """The user's location from the chosen source, or None."""
        if self.mode == "ip":
            data = await self._get(IP_URL)
            if data.get("latitude") is not None:
                label = ", ".join(
                    str(x) for x in (data.get("city"), data.get("region"), data.get("country_name")) if x
                )
                return Place(
                    label or "unbekannt",
                    float(data["latitude"]),
                    float(data["longitude"]),
                    "ip",
                    "ungefähr (Stadt)",
                    data.get("timezone") or "auto",
                )
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
