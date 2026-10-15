"""Location and weather (tools/context.py, AURA-116). No network: httpx.MockTransport."""

from pathlib import Path

import httpx
import pytest

from aura_agent.tools.context import (
    NO_PLACE,
    ContextService,
    _parse_etc_geolocation,
    describe,
    make_context_tools,
)

GEO = {
    "results": [
        {
            "name": "Berlin",
            "admin1": "Berlin",
            "country": "Deutschland",
            "latitude": 52.52,
            "longitude": 13.41,
            "timezone": "Europe/Berlin",
        }
    ]
}
REVERSE_GEO = {
    "address": {
        "town": "Traunstein",
        "state": "Bayern",
        "country": "Deutschland",
    }
}
FORECAST = {
    "current": {
        "temperature_2m": 12.3,
        "apparent_temperature": 10.1,
        "precipitation": 0,
        "weather_code": 3,
        "wind_speed_10m": 14,
    },
    "hourly": {
        "time": ["2026-10-13T00:00", "2026-10-13T03:00", "2026-10-13T04:00", "2026-10-14T00:00"],
        "temperature_2m": [9, 8, 8, 7],
        "precipitation_probability": [10, 20, 20, 60],
        "weather_code": [0, 2, 2, 61],
    },
    "daily": {
        "time": ["2026-10-13", "2026-10-14"],
        "weather_code": [3, 61],
        "temperature_2m_max": [14, 11],
        "temperature_2m_min": [7, 6],
        "precipitation_sum": [0, 4.2],
        "precipitation_probability_max": [20, 80],
        "wind_speed_10m_max": [20, 30],
        "sunrise": ["2026-10-13T07:24", "2026-10-14T07:26"],
        "sunset": ["2026-10-13T18:20", "2026-10-14T18:18"],
    },
}
IP = {
    "city": "Hamburg",
    "region": "Hamburg",
    "country_name": "Germany",
    "latitude": 53.55,
    "longitude": 9.99,
    "timezone": "Europe/Berlin",
}


def service(mode="profile", place="Berlin, MEZ", device_provider=None):
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req.url.host)
        if req.url.host == "geocoding-api.open-meteo.com":
            return httpx.Response(200, json=GEO if req.url.params["name"] == "Berlin" else {})
        if req.url.host == "nominatim.openstreetmap.org":
            return httpx.Response(200, json=REVERSE_GEO)
        if req.url.host == "api.open-meteo.com":
            return httpx.Response(200, json=FORECAST)
        if req.url.host == "ipapi.co":
            return httpx.Response(200, json=IP)
        return httpx.Response(404)

    svc = ContextService(
        mode,
        place,
        httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        device_provider=device_provider,
    )
    location, weather = make_context_tools(svc)
    return svc, location, weather, calls


async def test_weather_from_the_profile_place():
    _, _, weather, calls = service()
    r = await weather()
    assert r["ort"] == "Berlin, Berlin, Deutschland"
    assert r["quelle_ort"] == "profile"
    assert r["jetzt"]["wetter"] == "bedeckt"
    assert r["tage"][1]["wetter"] == "leichter Regen"
    assert r["tage"][1]["regenwahrscheinlichkeit_pct"] == 80
    assert [h["zeit"] for h in r["heute_stuendlich"]] == ["00:00", "03:00"]  # every 3 h, today only
    assert "ipapi.co" not in calls


async def test_results_are_cached():
    _, _, weather, calls = service()
    await weather()
    await weather()
    assert calls.count("api.open-meteo.com") == 1


async def test_without_opt_in_no_ip_lookup_and_no_place_asks():
    _, location, weather, calls = service(place="")
    assert (await location())["error"] == NO_PLACE
    assert (await weather())["error"] == NO_PLACE
    assert calls == []


async def test_ip_location_only_with_opt_in():
    _, location, _, calls = service(mode="ip", place="")
    r = await location()
    assert r["ort"] == "Hamburg, Hamburg, Germany"
    assert r["quelle"] == "ip"
    assert calls == ["ipapi.co"]


async def test_device_gps_location_and_weather():
    async def fake_gps():
        return (47.8682, 12.6433, 15.0)

    _, location, weather, calls = service(mode="device", place="", device_provider=fake_gps)
    loc = await location()
    assert loc["ort"] == "Traunstein, Bayern, Deutschland"
    assert loc["quelle"] == "device"
    assert loc["genauigkeit"] == "genau (GPS ±15 m)"
    assert loc["breite"] == 47.87
    assert loc["laenge"] == 12.64
    w = await weather()
    assert w["ort"] == "Traunstein, Bayern, Deutschland"
    assert w["quelle_ort"] == "device"
    assert "ipapi.co" not in calls


async def test_device_mode_falls_back_to_ip_when_no_gps_sensor():
    async def no_gps():
        return None

    _, location, weather, calls = service(mode="device", place="", device_provider=no_gps)
    loc = await location()
    assert loc["ort"] == "Hamburg, Hamburg, Germany"
    assert loc["quelle"] == "device"
    w = await weather()
    assert w["ort"] == "Hamburg, Hamburg, Germany"
    assert "ipapi.co" in calls


def test_parse_etc_geolocation(tmp_path: Path):
    geo_file = tmp_path / "geolocation"
    geo_file.write_text("# Static geolocation\n48.1372\n11.5755\n520\n25\n", encoding="utf-8")
    assert _parse_etc_geolocation(geo_file) == (48.1372, 11.5755, 25.0)


async def test_unknown_place_and_unreachable_service():
    _, _, weather, _ = service()
    assert "nicht gefunden" in (await weather(place="Atlantis"))["error"]

    def down(_req):
        raise httpx.ConnectError("offline")

    svc = ContextService("profile", "Berlin", httpx.AsyncClient(transport=httpx.MockTransport(down)))
    _, weather2 = make_context_tools(svc)
    assert "nicht erreichbar" in (await weather2())["error"]


@pytest.mark.parametrize(
    ("code", "text"), [(0, "klar"), (95, "Gewitter"), ("x", "unbekannt"), (1234, "Wettercode 1234")]
)
def test_weather_codes(code, text):
    assert describe(code) == text


async def test_one_network_hiccup_is_retried():
    calls = {"n": 0}

    def flaky(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ConnectError("reset")
        return httpx.Response(200, json=GEO if req.url.host.startswith("geocoding") else FORECAST)

    svc = ContextService("profile", "Berlin", httpx.AsyncClient(transport=httpx.MockTransport(flaky)))
    _, weather = make_context_tools(svc)
    assert (await weather())["jetzt"]["wetter"] == "bedeckt"
