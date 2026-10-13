"""Einstellungen mit eigenem gsettings-Speicher (keyfile im temporären Benutzerordner)."""

import pytest

from aura_agent.harness.tiers import Tier
from aura_agent.tools import system


@pytest.fixture
def own_gsettings(fake_home, monkeypatch, private_dbus):
    monkeypatch.setenv("GSETTINGS_BACKEND", "keyfile")
    monkeypatch.setenv("XDG_CONFIG_HOME", str(fake_home / ".config"))


async def test_dark_mode_on_and_off_is_verified(own_gsettings):
    on = await system.dark_mode(True)
    assert on["verified"] is True and on["dark"] is True
    off = await system.dark_mode(False)
    assert off["verified"] is True and off["dark"] is False


async def test_settings_read_and_write(own_gsettings):
    r = await system.settings("org.gnome.desktop.interface", "clock-show-seconds", "true")
    assert r["verified"] is True and r["after"] == "true"
    assert (await system.settings("org.gnome.desktop.interface", "clock-show-seconds"))["value"] == "true"
    assert "error" in await system.settings("org.gnome.desktop.interface", "gibt-es-nicht")


def test_settings_tiers():
    t = system.settings.__aura__.classify
    assert (
        t({"schema": "org.gnome.desktop.interface", "key": "clock-show-seconds", "value": "true"})[0]
        == Tier.T1
    )
    assert t({"schema": "org.gnome.desktop.interface", "key": "clock-show-seconds"})[0] == Tier.T0
    assert t({"schema": "org.gnome.desktop.input-sources", "key": "sources", "value": "[]"})[0] == Tier.T2
    assert (
        t({"schema": "org.gnome.desktop.lockdown", "key": "disable-lock-screen", "value": "true"})[0]
        == Tier.T3
    )
