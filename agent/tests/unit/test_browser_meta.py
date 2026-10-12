import re
from pathlib import Path

from aura_agent.harness.tiers import EXTERNAL, Tier
from aura_agent.runtime.settings import AgentSettings
from aura_agent.tools import browser


def test_consequential_clicks_ask_and_harmless_ones_do_not():
  click = EXTERNAL["browser_click"]
  assert click.classify({"element": "Button \"Jetzt kaufen\""})[0] == Tier.T2
  assert click.classify({"element": "Absenden"})[0] == Tier.T2
  assert click.classify({"element": "Konto löschen"})[0] == Tier.T2
  assert click.classify({"element": "button \"Play Chambea - Bad Bunny\""})[0] == Tier.T1
  assert click.classify({"element": "Reject all"})[0] == Tier.T1
  assert click.required == ("element",)
  assert EXTERNAL["browser_snapshot"].classify({})[0] == Tier.T0
  assert EXTERNAL["browser_navigate"].classify({"url": "file:///etc/passwd"})[0] == Tier.T2
  assert EXTERNAL["browser_handle_dialog"].classify({"accept": True})[0] == Tier.T2


def test_bundled_launcher_is_used_when_given(tmp_path):
  s = AgentSettings(browser_command=["/opt/Aura/aura", "/x/cli.js"], browser_env={"ELECTRON_RUN_AS_NODE": "1"})
  p = browser.server_params(s, ["--browser", "chrome"])
  assert p.command == "/opt/Aura/aura" and p.args == ["/x/cli.js", "--browser", "chrome"] and p.env["ELECTRON_RUN_AS_NODE"] == "1"
  dev = browser.server_params(AgentSettings(), ["--browser", "chrome"])
  assert dev.command == "npx" and dev.args[:2] == ["-y", browser.PLAYWRIGHT_MCP]


def test_build_script_bundles_the_same_version():
  script = (Path(__file__).parents[3] / "scripts" / "build-agent.sh").read_text()
  assert "PLAYWRIGHT_MCP" in script and re.search(r"tools/browser\.py", script)
