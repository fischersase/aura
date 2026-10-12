import json
import sys
from pathlib import Path

import pytest

from aura_agent.harness.audit import AuditLog, redact
from aura_agent.tools.paths import expand, show

HOME = "/home/anna"
posix_only = pytest.mark.skipif(sys.platform == "win32", reason="Linux-Pfade")


@posix_only
def test_expand_variants():
  assert expand("~/x.txt", HOME) == Path("/home/anna/x.txt")
  assert expand("Downloads", HOME) == Path("/home/anna/Downloads")
  assert expand("$HOME/a", HOME) == Path("/home/anna/a")
  assert expand("", HOME) == Path(HOME)
  assert expand("/etc/hosts", HOME) == Path("/etc/hosts")
  assert expand('"~/mit leerzeichen.txt"', HOME) == Path("/home/anna/mit leerzeichen.txt")


@posix_only
def test_expand_fixes_invented_home():
  # gemma4 schrieb in P0 /home/user/notizen.txt für ~/notizen.txt
  assert expand("/home/user/notizen.txt", HOME) == Path("/home/anna/notizen.txt")


@posix_only
def test_show_uses_tilde():
  assert show(Path("/home/anna/a/b"), HOME) == "~/a/b"
  assert show(Path("/etc"), HOME) == "/etc"


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-Pfade")
def test_expand_windows_variants():
  home = "C:\\Users\\anna"
  assert expand("~\\Downloads\\x.txt", home) == Path(home, "Downloads", "x.txt")
  assert expand("~/Downloads", home) == Path(home, "Downloads")
  assert expand("Dokumente", home) == Path(home, "Dokumente")
  assert expand("$env:USERPROFILE\\a", home) == Path(home, "a")
  assert expand("C:\\Users\\user\\notizen.txt", home) == Path(home, "notizen.txt")
  assert show(Path(home, "a", "b"), home) == "~\\a\\b"


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


WINDOWS_SECRETS = [
    r"C:\Users\anna\AppData\Local\Google\Chrome\User Data\Default\Login Data",
    r"C:\Users\anna\AppData\Local\Google\Chrome\User Data\Local State",
    r"C:\Users\anna\AppData\Local\Microsoft\Edge\User Data\Profile 1\Network\Cookies",
    r"C:\Users\anna\AppData\Roaming\Mozilla\Firefox\Profiles\ab12.default\logins.json",
    r"C:\Users\anna\AppData\Roaming\Microsoft\Credentials\DFBE70A7E5CC19A398EBF1B96859CE5D",
    r"C:\Users\anna\AppData\Roaming\Microsoft\Protect\S-1-5-21",
    r"C:\Windows\System32\config\SAM",
    r"C:\Users\anna\AppData\Roaming\Aura\secrets.json",
    r"C:\Users\anna\.ssh\id_ed25519",
]


@pytest.mark.parametrize("path", WINDOWS_SECRETS)
def test_windows_credential_paths_are_forbidden(path):
  from aura_agent.policy.paths import forbidden

  assert forbidden(path), path


def test_windows_normal_paths_are_allowed():
  from aura_agent.policy.paths import forbidden

  assert forbidden(r"C:\Users\anna\Documents\Rechnung.pdf") is None
  assert forbidden(r"C:\Users\anna\AppData\Local\Google\Chrome\User Data\Default\Bookmarks") is None
