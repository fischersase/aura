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


def test_audit_log_ignores_reserved_envelope_keys(tmp_path):
    log = AuditLog(tmp_path)
    entry = log.write("tool_start", hash="fake", prev="fake", ts="spoofed", private_key="secret")
    assert entry["ts"] != "spoofed"
    assert entry["private_key"] == "***"
    assert AuditLog.verify(next(tmp_path.glob("*.jsonl"))) == (True, 1)


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


# Testwerte werden zusammengesetzt, damit kein schlüsselähnlicher Text wörtlich im Repo steht (Secret-Scanning).
_J = "".join
SECRET_EXAMPLES = [
    (
        _J(["curl -H 'Authorization: Bea", "rer abcdef1234567890xyz' https://api.example.com"]),
        "abcdef1234567890xyz",
    ),
    (_J(['curl -H "authorization: token ', "ghp", "_", "a" * 30, '" x']), "aaaaaaaaaa"),
    (_J(["export GEMINI_API_KEY=", "AI", "za", "SyA1234567890abcdefghijklmnopqrs && run"]), "SyA1234567890"),
    (_J(["GH_TOKEN=", "gh", "o_", "0123456789abcdefghijABCDEFGHIJ gh pr list"]), "0123456789abcdefghij"),
    ("mysql -u root -pS3cretPw! mydb", "S3cretPw!"),
    ("psql --password=hunter2hunter2 db", "hunter2hunter2"),
    (_J(["tool --api-key ", "sk", "-proj-", "abcdefghijklmnopqrstuv"]), "abcdefghijklmnop"),
    ("git clone https://user:p4ssw0rd@github.com/x/y.git", "p4ssw0rd"),
    (_J(["aws s3 ls # ", "AK", "IA", "ABCDEFGHIJKLMNOP"]), "ABCDEFGHIJKLMNOP"),
    (_J(["slack ", "xo", "xb-", "1234567890-abcdefghij"]), "1234567890-abcdefghij"),
    (
        _J(
            [
                "jwt ",
                "ey",
                "JhbGciOiJIUzI1NiJ9.",
                "eyJzdWIiOiIxMjM0NTY3ODkwIn0.",
                "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P",
            ]
        ),
        "dozjgNryP4J3",
    ),
    (_J(["key: ", "Zq3xL9vR2mWp8KtY", "7nB4cH6jF1sD5gA0", "eU2iO8yT"]), "Zq3xL9vR2mWp8KtY"),
]


@pytest.mark.parametrize(("text", "secret"), SECRET_EXAMPLES)
def test_secrets_inside_values_are_scrubbed(text, secret):
    from aura_agent.harness.audit import scrub

    out = scrub(text)
    assert secret not in out and "***" in out, out


@pytest.mark.parametrize(
    "text",
    [
        "git show 3313787f0c2a9d4e5b6a7c8d9e0f1a2b3c4d5e6f",
        "ls -la ~/Downloads",
        "mkdir -p ~/Projekte/neu",
        "ps -p 1234",
        "ssh -p 2222 host",
        "sha256sum aura_amd64.deb  # 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        "/home/anna/Dokumente/Rechnungen/2026/Oktober/rechnung-0042.pdf",
    ],
)
def test_harmless_values_stay_readable(text):
    from aura_agent.harness.audit import scrub

    assert scrub(text) == text


def test_audit_log_scrubs_command_values(tmp_path):
    log = AuditLog(tmp_path)
    log.write(
        "tool_start",
        task="t",
        args={"command": _J(["curl -H 'Authorization: Bea", "rer abcdefghijklmnop123' x"])},
    )
    f = next(tmp_path.glob("*.jsonl"))
    assert "abcdefghijklmnop123" not in f.read_text() and AuditLog.verify(f) == (True, 1)


@pytest.mark.parametrize(
    "path",
    [
        "/home/a/.config/gcloud/application_default_credentials.json",
        "/home/a/.azure/msal_token_cache.json",
        "/home/a/.aws/config",
        "/home/a/.config/gh/hosts.yml",
        "/home/a/.npmrc",
        "/home/a/.pypirc",
        "/home/a/.vault-token",
        "/home/a/.cargo/credentials.toml",
        "/home/a/proj/.env",
        "/home/a/proj/.env.local",
        "/home/a/.envrc",
        r"C:\Users\a\AppData\Roaming\GitHub CLI\hosts.yml",
        r"C:\Users\a\AppData\Roaming\gcloud\credentials.db",
    ],
)
def test_cloud_and_tool_credentials_are_forbidden(path):
    from aura_agent.policy.paths import forbidden

    assert forbidden(path), path


@pytest.mark.parametrize(
    "path", ["/home/a/proj/environment.py", "/usr/bin/env", "/home/a/.envoy/x", "/home/a/notes/env.txt"]
)
def test_similar_names_stay_readable(path):
    from aura_agent.policy.paths import forbidden

    assert forbidden(path) is None, path
