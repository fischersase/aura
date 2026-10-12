from aura_agent.memory.store import MAX_INDEX_LINES, MemoryFiles


def test_remember_groups_by_topic_and_skips_duplicates(tmp_path):
  m = MemoryFiles(tmp_path)
  assert m.remember("Hört Musik meist über YouTube Music", "Vorlieben")["ok"]
  assert m.remember("Drucker im Büro: Brother HL-L2350DW", "Geräte")["ok"]
  assert m.remember("hört musik meist über youtube music", "Vorlieben")["note"] == "Stand schon im Gedächtnis."
  text = m.index.read_text()
  assert text.index("## Vorlieben") < text.index("YouTube Music") < text.index("## Geräte") < text.index("Brother")
  assert "YouTube Music" in m.prompt() and "Brother" in m.prompt()


def test_secrets_are_never_stored(tmp_path):
  m = MemoryFiles(tmp_path)
  for fact in ["WLAN-Passwort ist Sonne123", "Meine PIN ist 1234", "API key: sk-abc", "IBAN DE89 3704 0044"]:
    assert "error" in m.remember(fact)
  assert not m.index.exists()


def test_old_entries_rotate_to_archive_and_stay_searchable(tmp_path):
  m = MemoryFiles(tmp_path)
  for i in range(MAX_INDEX_LINES + 5):
    m.remember(f"Fakt Nummer {i}")
  assert sum(ln.startswith("- ") for ln in m.index.read_text().splitlines()) == MAX_INDEX_LINES
  assert "Fakt Nummer 0 " in m.archive.read_text()
  assert any("Nummer 0" in h for h in m.search("Fakt Nummer 0"))


def test_forget(tmp_path):
  m = MemoryFiles(tmp_path)
  m.remember("Lieblingsfarbe Blau")
  assert m.forget("lieblingsfarbe")["removed"] == 1
  assert "Blau" not in m.index.read_text()
