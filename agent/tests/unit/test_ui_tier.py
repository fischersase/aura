"""Tier of ui_act from the last snapshot (tools/ui.py _consequential)."""

import pytest

from aura_agent.harness.tiers import Tier
from aura_agent.tools import ui


@pytest.fixture(autouse=True)
def snapshot(monkeypatch):
    monkeypatch.setattr(ui, "_last", {0: {"name": "Konto löschen"}, 1: {"name": "Weiter"}})


def test_first_element_is_classified_by_its_snapshot_name():
    # Index 0 used to raise TypeError (`_last.get(0 or {})`).
    assert ui._consequential({"index": 0, "element": "Knopf"})[0] == Tier.T2


def test_harmless_and_unknown_elements():
    assert ui._consequential({"index": 1, "element": "Knopf"})[0] == Tier.T1
    assert ui._consequential({"index": 7, "element": "Knopf"})[0] == Tier.T1
    assert ui._consequential({"index": "x", "element": "Senden"})[0] == Tier.T2
    assert ui._consequential({})[0] == Tier.T1
