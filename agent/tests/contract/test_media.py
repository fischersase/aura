"""MPRIS-Werkzeuge gegen einen Test-Player auf einem eigenen D-Bus."""

from aura_agent.testing.fake_mpris import start_player
from aura_agent.tools.system import media_control, media_status


async def test_status_shows_player(private_dbus):
    bus, _ = await start_player()
    try:
        r = await media_status()
        assert r["players"][0]["title"] == "Me Porto Bonito" and r["players"][0]["status"] == "Playing"
    finally:
        bus.disconnect()


async def test_pause_is_verified(private_dbus):
    bus, player = await start_player()
    try:
        r = await media_control("pause")
        assert r["verified"] is True and r["after"]["status"] == "Paused" and player.calls == ["Pause"]
    finally:
        bus.disconnect()


async def test_pause_when_already_paused_sends_nothing(private_dbus):
    bus, player = await start_player(status="Paused")
    try:
        r = await media_control("pause")
        assert r["verified"] is True and player.calls == []
    finally:
        bus.disconnect()


async def test_next_is_verified_by_title_change(private_dbus):
    bus, player = await start_player()
    try:
        r = await media_control("next")
        assert (
            r["verified"] is True and r["after"]["title"] == "Tití Me Preguntó" and player.calls == ["Next"]
        )
    finally:
        bus.disconnect()


async def test_no_player_is_an_error(private_dbus):
    r = await media_control("pause")
    assert "Kein passender" in r["error"]


async def test_unknown_action_is_rejected(private_dbus):
    assert "Unbekannte Aktion" in (await media_control("lauter"))["error"]
