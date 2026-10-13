"""Fact store (memory/store.py, AURA-107): records with provenance, MEMORY.md as a view, relevance for the prompt."""

import os
import sqlite3
import time
from contextlib import closing

from aura_agent.memory.store import MAX_FACTS, PINNED_BUDGET, FactStore


def rows(m: FactStore) -> list[dict]:
    return m.list()


def test_remember_groups_by_topic_and_skips_duplicates(tmp_path):
    m = FactStore(tmp_path)
    assert m.remember("Hört Musik meist über YouTube Music", "Vorlieben")["ok"]
    assert m.remember("Drucker im Büro: Brother HL-L2350DW", "Geräte", chat_id="c1", task_id="t1")["ok"]
    assert (
        m.remember("hört musik meist über youtube music", "Vorlieben")["note"] == "Stand schon im Gedächtnis."
    )
    text = m.index.read_text()
    assert (
        text.index("## Vorlieben")
        < text.index("YouTube Music")
        < text.index("## Geräte")
        < text.index("Brother")
    )
    printer = next(r for r in rows(m) if "Brother" in r["text"])
    assert (printer["source"], printer["chat_id"], printer["task_id"]) == ("explicit", "c1", "t1")


def test_secrets_are_never_stored(tmp_path):
    m = FactStore(tmp_path)
    for fact in [
        "WLAN-Passwort ist Sonne123",
        "Meine PIN ist 1234",
        "API key: sk-abc",
        "IBAN DE89 3704 0044",
    ]:
        assert "error" in m.remember(fact)
    assert rows(m) == []


def test_migration_from_markdown_keeps_every_fact_with_date_and_topic(tmp_path):
    mem = tmp_path / "memory"
    mem.mkdir()
    (mem / "MEMORY.md").write_text(
        "# Aura-Gedächtnis\n\nDinge, die Aura sich über dich und deinen Rechner gemerkt hat.\n\n"
        "## Vorlieben\n- Hört Musik über YouTube Music (03.10.2026)\n- Mag dunkle Themes (04.10.2026)\n\n"
        "## Geräte\n- Drucker: Brother HL-L2350DW (05.10.2026)\n- Monitor ohne Datum\n"
    )
    (mem / "archiv.md").write_text("- Alte Notiz zum Router (01.01.2026)\n")
    m = FactStore(tmp_path)
    facts = {r["text"]: r for r in rows(m)}
    assert set(facts) == {
        "Hört Musik über YouTube Music",
        "Mag dunkle Themes",
        "Drucker: Brother HL-L2350DW",
        "Monitor ohne Datum",
        "Alte Notiz zum Router",
    }
    assert facts["Drucker: Brother HL-L2350DW"]["topic"] == "Geräte"
    assert all(r["source"] == "imported" for r in facts.values())
    assert time.strftime("%d.%m.%Y", time.localtime(facts["Mag dunkle Themes"]["created"])) == "04.10.2026"
    assert not (mem / "archiv.md").exists()
    assert "Generated" in m.index.read_text() or "erzeugt" in m.index.read_text()
    # A second store on the same directory does not import again.
    assert len(rows(FactStore(tmp_path))) == 5


def test_manual_edits_to_the_view_are_taken_over(tmp_path):
    m = FactStore(tmp_path)
    m.remember("Lieblingsfarbe Blau", "Vorlieben")
    m.remember("Wohnt in Hamburg", "Allgemein")
    text = (
        m.index.read_text().replace("- Lieblingsfarbe Blau", "- Lieblingsfarbe Grün") + "- Hat einen Hund\n"
    )
    time.sleep(0.01)
    m.index.write_text(text)
    os.utime(m.index, (time.time() + 2, time.time() + 2))  # newer than the last rendering
    facts = {r["text"]: r["source"] for r in rows(m)}
    assert "Lieblingsfarbe Blau" not in facts
    assert facts["Lieblingsfarbe Grün"] == "edited"
    assert facts["Hat einen Hund"] == "edited"
    assert facts["Wohnt in Hamburg"] == "explicit"


def test_forget_returns_what_was_removed(tmp_path):
    m = FactStore(tmp_path)
    m.remember("Lieblingsfarbe Blau")
    r = m.forget("lieblingsfarbe")
    assert r == {"removed": 1, "texts": ["Lieblingsfarbe Blau"]}
    assert "Blau" not in m.index.read_text()
    assert m.forget("   ") == {"removed": 0}


def test_delete_where_removes_only_learned_facts_of_that_chat(tmp_path):
    m = FactStore(tmp_path)
    m.remember("Gelernt in A", source="learned", chat_id="A")
    m.remember("Gesagt in A", source="explicit", chat_id="A")
    m.remember("Gelernt in B", source="learned", chat_id="B")
    assert m.delete_where("A") == 1
    assert {r["text"] for r in rows(m)} == {"Gesagt in A", "Gelernt in B"}


def test_prompt_holds_only_relevant_facts_within_the_budget(tmp_path):
    m = FactStore(tmp_path)
    m.remember("Wohnt in Hamburg", "Allgemein")
    for i in range(500):
        m.remember(f"Notiz Nummer {i} über das Gartenhaus und die Hecke", "Garten")
    m.remember("Drucker im Büro ist ein Brother HL-L2350DW", "Geräte")
    text = m.select_for_prompt("Druck mir das bitte auf dem Drucker aus")
    assert len(text) <= 1500
    lines = text.splitlines()
    assert lines[0] == "- Wohnt in Hamburg"  # pinned topic first
    assert "Brother" in lines[1]  # the relevant fact right after
    assert "Gartenhaus" not in text  # unrelated facts stay out
    garden = m.select_for_prompt("Was muss ich im Garten an der Hecke machen?")
    assert "Hecke" in garden and len(garden) <= 1500


def test_pinned_topic_has_its_own_budget(tmp_path):
    m = FactStore(tmp_path)
    for i in range(50):
        m.remember(f"Allgemeiner Fakt Nummer {i} mit etwas Text", "Allgemein")
    assert len(m.select_for_prompt("nichts passendes")) <= PINNED_BUDGET


def test_search_ranks_by_overlap_and_marks_use(tmp_path):
    m = FactStore(tmp_path)
    m.remember("Drucker im Büro: Brother")
    m.remember("Drucker zu Hause: Canon Pixma")
    m.remember("Lieblingsessen Lasagne")
    hits = m.search("Drucker zu Hause")
    assert hits[0] == "Drucker zu Hause: Canon Pixma"
    assert "Lieblingsessen Lasagne" not in hits
    with closing(sqlite3.connect(m.db)) as db:
        used = db.execute("SELECT last_used FROM facts WHERE text LIKE 'Drucker zu Hause%'").fetchone()[0]
    assert used is not None


def test_store_is_bounded(tmp_path, monkeypatch):
    import aura_agent.memory.store as store

    monkeypatch.setattr(store, "MAX_FACTS", 5)
    m = FactStore(tmp_path)
    for i in range(8):
        m.remember(f"Fakt {i}")
    texts = {r["text"] for r in rows(m)}
    assert len(texts) == 5
    assert "Fakt 0" not in texts and "Fakt 7" in texts
    assert MAX_FACTS == 2000
