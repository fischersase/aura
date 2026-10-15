from aura_agent.harness.tiers import Tier
from aura_agent.policy.engine import PolicyEngine


def test_defaults_follow_tiers():
    p = PolicyEngine()
    assert p.evaluate("read_file", "~/a", Tier.T0).decision == "auto"
    assert p.evaluate("launch_app", "Firefox", Tier.T1).decision == "auto"
    assert p.evaluate("run_command", "rm x", Tier.T2).decision == "ask"
    assert p.evaluate("run_command", "cat ~/.ssh/id", Tier.T3).decision == "deny"


def test_rules_from_file_with_precedence(tmp_path):
    f = tmp_path / "policy.toml"
    f.write_text("""
[[rule]]
tool = "run_command"
match = '^git (pull|fetch)\\b'
decision = "allow"

[[rule]]
tool = "run_command"
match = 'push'
decision = "deny"

[[rule]]
tool = "launch_app"
match = 'Steam'
decision = "ask"

[[rule]]
tool = "run_command"
decision = "allow"
match = 'git'
""")
    p = PolicyEngine(f)
    assert p.evaluate("run_command", "git pull", Tier.T2).decision == "auto"
    assert p.evaluate("run_command", "git push", Tier.T2).decision == "deny"  # deny schlägt allow
    assert p.evaluate("launch_app", "Steam", Tier.T1).decision == "ask"
    assert p.evaluate("launch_app", "Firefox", Tier.T1).decision == "auto"


def test_no_rule_unlocks_t3(tmp_path):
    f = tmp_path / "policy.toml"
    f.write_text('[[rule]]\ntool = "*"\ndecision = "allow"\n')
    assert PolicyEngine(f).evaluate("read_file", "~/.ssh/id_rsa", Tier.T3).decision == "deny"


def test_allow_always_persists_exact_action(tmp_path):
    f = tmp_path / "policy.toml"
    p = PolicyEngine(f)
    p.allow_always("run_command", "pkill -f 'chrome --type=renderer'")
    p.allow_always("write_file", "line1\r\nline2\t'''end'")
    again = PolicyEngine(f)
    assert again.evaluate("run_command", "pkill -f 'chrome --type=renderer'", Tier.T2).decision == "auto"
    assert again.evaluate("write_file", "line1\r\nline2\t'''end'", Tier.T2).decision == "auto"
    assert again.evaluate("run_command", "pkill -f chrome", Tier.T2).decision == "ask"


def test_v1_tool_policy_is_migrated():
    p = PolicyEngine(tool_policy={"run_command": "auto", "open": "off", "write_file": "ask"})
    assert p.evaluate("run_command", "apt install x", Tier.T2).decision == "auto"
    assert p.evaluate("launch_app", "Firefox", Tier.T1).decision == "deny"
    assert p.evaluate("open_target", "https://x", Tier.T1).decision == "deny"
    assert p.evaluate("edit_file", "~/a", Tier.T2).decision == "ask"


def test_broken_file_is_ignored(tmp_path):
    f = tmp_path / "policy.toml"
    f.write_text("das ist kein toml [[[")
    assert PolicyEngine(f).evaluate("run_command", "rm x", Tier.T2).decision == "ask"
