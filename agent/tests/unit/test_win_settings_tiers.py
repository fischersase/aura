"""Stufen und Registry-Hilfen für Windows-Einstellungen (reine Logik, läuft überall)."""

import pytest

from aura_agent.harness.tiers import Tier
from aura_agent.platform import win_registry as reg
from aura_agent.tools import win_settings


def tier(**a):
    return win_settings.settings.__aura__.classify(a)[0]


def test_reading_is_t0_and_listed_values_are_t1():
    assert tier(key=win_settings.ADVANCED, name="HideFileExt") == Tier.T0
    assert (
        tier(
            key="HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced",
            name="hidefileext",
            value="0",
        )
        == Tier.T1
    )
    assert (
        tier(
            key="HKEY_CURRENT_USER/Software/Microsoft/Windows/CurrentVersion/PushNotifications",
            name="ToastEnabled",
            value="0",
        )
        == Tier.T1
    )


def test_other_values_ask():
    assert (
        tier(key="HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", name="Aura", value="C:\\x.exe")
        == Tier.T2
    )
    assert tier(key="HKLM\\SOFTWARE\\Something", name="x", value="1") == Tier.T2


@pytest.mark.parametrize(
    "key",
    [
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System",
        "HKCU\\Software\\Policies\\Microsoft\\Windows\\System",
        "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa",
        "HKLM\\SOFTWARE\\Microsoft\\Windows Defender\\Features",
        "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon",
        "HKLM\\SAM\\SAM",
    ],
)
def test_security_keys_are_forbidden_even_for_reading(key):
    assert tier(key=key, name="x") == Tier.T3
    assert tier(key=key, name="x", value="0") == Tier.T3


def test_normalize_and_coerce():
    assert reg.normalize("HKCU:\\Software\\\\X\\") == ("HKEY_CURRENT_USER", "Software\\X")
    assert reg.display("HKEY_LOCAL_MACHINE\\SOFTWARE\\X") == "HKLM\\SOFTWARE\\X"
    with pytest.raises(ValueError, match="HKCU"):
        reg.normalize("Software\\X")
    assert reg.coerce("0x10", reg.REG_DWORD) == 16 and reg.coerce("aus", reg.REG_DWORD) == 0
    assert reg.coerce("a\nb", reg.REG_MULTI_SZ) == ["a", "b"]
