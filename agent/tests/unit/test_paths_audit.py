import json
from pathlib import Path

from aura_agent.harness.audit import AuditLog, redact
from aura_agent.tools.paths import expand, show

HOME = "/home/anna"


def test_expand_variants():
  assert expand("~/x.txt", HOME) == Path("/home/anna/x.txt")
  assert expand("Downloads", HOME) == Path("/home/anna/Downloads")
  assert expand("$HOME/a", HOME) == Path("/home/anna/a")
  assert expand("", HOME) == Path(HOME)
  assert expand("/etc/hosts", HOME) == Path("/etc/hosts")
  assert expand('"~/mit leerzeichen.txt"', HOME) == Path("/home/anna/mit leerzeichen.txt")


def test_expand_fixes_invented_home():
  # gemma4 schrieb in P0 /home/user/notizen.txt für ~/notizen.txt
  assert expand("/home/user/notizen.txt", HOME) == Path("/home/anna/notizen.txt")


def test_show_uses_tilde():
  assert show(Path("/home/anna/a/b"), HOME) == "~/a/b"
  assert show(Path("/etc"), HOME) == "/etc"


def test_audit_chain_detects_tampering(tmp_path):
  log = AuditLog(tmp_path)
  for i in range(5):
    log.write("tool_result", task="t", n=i, password="geheim")
  f = next(tmp_path.glob("*.jsonl"))
  assert AuditLog.verify(f) == (True, 5)
  lines = f.read_text().splitlines()
  assert json.loads(lines[0])["password"] == "***"
  entry = json.loads(lines[2])
  entry["n"] = 99
  lines[2] = json.dumps(entry)
  f.write_text("\n".join(lines) + "\n")
  assert AuditLog.verify(f) == (False, 2)


def test_audit_chain_continues_across_instances(tmp_path):
  AuditLog(tmp_path).write("a")
  AuditLog(tmp_path).write("b")
  assert AuditLog.verify(next(tmp_path.glob("*.jsonl"))) == (True, 2)


def test_redact_clips_long_values_and_secrets():
  out = redact({"text": "x" * 2000, "api_key": "k", "nested": {"token": "t", "ok": 1}})
  assert out["api_key"] == "***" and out["nested"] == {"token": "***", "ok": 1}
  assert len(out["text"]) < 600
