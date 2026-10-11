"""Datei-Werkzeuge in einem temporären Benutzerordner."""

from aura_agent.harness.tiers import Tier
from aura_agent.tools import files


def test_write_new_file_is_t1_and_verified(fake_home):
  assert files._write_tier({"path": "~/neu.txt"})[0] == Tier.T1
  r = files.write_file("~/neu.txt", "Hallo")
  assert r["verified"] is True and (fake_home / "neu.txt").read_text() == "Hallo"


def test_overwrite_is_t2_with_diff(fake_home):
  (fake_home / "a.txt").write_text("alt\nzeile\n")
  assert files._write_tier({"path": "~/a.txt"})[0] == Tier.T2
  effect = files._write_effect({"path": "~/a.txt", "content": "neu\nzeile\n"})
  assert "-alt" in effect and "+neu" in effect


def test_append(fake_home):
  files.write_file("~/log.txt", "a")
  assert files.write_file("~/log.txt", "b", append=True)["verified"] is True
  assert (fake_home / "log.txt").read_text() == "ab"


def test_edit_requires_unique_match(fake_home):
  (fake_home / "c.txt").write_text("x = 1\ny = 1\n")
  assert "2×" in files.edit_file("~/c.txt", "= 1", "= 2")["error"]
  assert "0×" in files.edit_file("~/c.txt", "z = 1", "z = 2")["error"]
  r = files.edit_file("~/c.txt", "x = 1", "x = 2")
  assert r["verified"] is True and (fake_home / "c.txt").read_text() == "x = 2\ny = 1\n"
  effect = files._edit_effect({"path": "~/c.txt", "old_text": "y = 1", "new_text": "y = 3"})
  assert "-y = 1" in effect and "+y = 3" in effect


async def test_trash_moves_to_trash_not_delete(fake_home):
  d = fake_home / "Downloads" / "alt"
  d.mkdir(parents=True)
  (d / "x.txt").write_text("x")
  r = await files.trash("~/Downloads/alt")
  assert r["verified"] is True and not d.exists()
  trash = fake_home / ".local/share/Trash/files"
  assert any(p.name.startswith("alt") for p in trash.iterdir())


async def test_trash_refuses_home(fake_home):
  assert "nicht in den Papierkorb" in (await files.trash("~"))["error"]


def test_move_and_copy(fake_home):
  (fake_home / "a.txt").write_text("1")
  (fake_home / "ziel").mkdir()
  assert files._move_tier({"source": "~/a.txt", "destination": "~/ziel"})[0] == Tier.T1
  assert files.move_path("~/a.txt", "~/ziel", copy=True)["verified"] is True
  assert (fake_home / "a.txt").exists() and (fake_home / "ziel/a.txt").exists()
  assert files._move_tier({"source": "~/a.txt", "destination": "~/ziel"})[0] == Tier.T2
  (fake_home / "b.txt").write_text("2")
  assert files.move_path("~/b.txt", "~/c.txt")["verified"] is True and not (fake_home / "b.txt").exists()
