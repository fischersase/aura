"""Programme über AT-SPI bedienen, gegen ein GTK-Testprogramm in Xvfb."""

from aura_agent.harness.tiers import Tier
from aura_agent.tools import ui


def by_name(snapshot, name):
    return next(e for e in snapshot["elements"] if e["name"] == name)


async def test_snapshot_set_text_and_click(gtk_app):
    apps = await ui.ui_snapshot()
    assert any(a["app"] == "gtk_app.py" for a in apps["apps"])
    snap = await ui.ui_snapshot("gtk_app")
    field = by_name(snap, "Notiz")
    r = await ui.ui_set_text(field["index"], "Notizfeld", "Hallo Welt")
    assert r["verified"] is True
    r = await ui.ui_act(by_name(snap, "Speichern")["index"], "Knopf Speichern")
    assert r["verified"] is True
    after = await ui.ui_snapshot("gtk_app")
    assert any(e["name"] == "Gespeichert: Hallo Welt" for e in after["elements"])


async def test_consequential_button_needs_honest_description(gtk_app):
    snap = await ui.ui_snapshot("gtk_app")
    delete = by_name(snap, "Konto löschen")
    r = await ui.ui_act(delete["index"], "Knopf unten")
    assert "heißt „Konto löschen“" in r["error"]
    after = await ui.ui_snapshot("gtk_app")
    assert not any(e["name"] == "GELÖSCHT" for e in after["elements"])
    # Mit ehrlicher Beschreibung ist es T2 (fragt).
    assert (
        ui.ui_act.__aura__.classify({"index": delete["index"], "element": "Knopf Konto löschen"})[0]
        == Tier.T2
    )


async def test_stale_index_is_rejected(gtk_app):
    await ui.ui_snapshot("gtk_app")
    assert "nicht aus dem letzten ui_snapshot" in (await ui.ui_act(999, "irgendwas"))["error"]


async def test_unknown_app_lists_available(gtk_app):
    r = await ui.ui_snapshot("gibtsnicht")
    assert "Kein Programm" in r["error"] and r["apps"]
