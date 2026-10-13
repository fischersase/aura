"""Scoped approvals (harness/grants.py, AURA-119)."""

from aura_agent.harness.grants import GrantStore, origin_of, page_origin, parse_hours, subject


def test_subjects_bind_to_website_connector_tool_or_exact_action():
    assert (
        subject("browser_navigate", {"url": "https://shop.example/a?b=1"}, "", "")
        == "origin:https://shop.example"
    )
    assert (
        subject("browser_click", {"element": "Kaufen"}, "Kaufen", "https://shop.example")
        == "origin:https://shop.example"
    )
    assert subject("mcp_Atlassian_createJiraIssue", {}, "x", "") == "tool:mcp_Atlassian_createJiraIssue"
    assert subject("run_command", {}, "rm a.txt", "") == "label:rm a.txt"


def test_origin_helpers():
    assert origin_of("http://127.0.0.1:8080/x") == "http://127.0.0.1:8080"
    assert origin_of("file:///etc/passwd") == ""
    assert (
        page_origin({"content": [{"text": "### Page\\n- Page URL: https://a.example/b\\n"}]})
        == "https://a.example"
    )
    assert page_origin("nothing") == ""


def test_hours_are_bounded():
    assert parse_hours("hours:8") == 8
    assert parse_hours("hours:99") == 24
    assert parse_hours("hours:100") == 0  # more than two digits is not accepted
    assert parse_hours("hours:48") == 24
    assert parse_hours("hours:0") == 0
    assert parse_hours("always") == 0


def test_session_and_timed_grants(tmp_path):
    clock = [1000.0]
    store = GrantStore(tmp_path / "grants.json", now=lambda: clock[0])
    key = ("browser_click", "origin:https://shop.example")
    assert not store.allows(key)
    store.add_session(key)
    assert store.allows(key)
    assert not store.allows(("browser_click", "origin:https://other.example")), "bound to the website"

    timed = ("mcp_Atlassian_createJiraIssue", "tool:mcp_Atlassian_createJiraIssue")
    store.add_timed(timed, 1)
    assert store.allows(timed)
    # Survives a restart, but not its expiry.
    again = GrantStore(tmp_path / "grants.json", now=lambda: clock[0])
    assert again.allows(timed)
    assert not again.allows(key), "session grants end with the session"
    clock[0] += 3601
    assert not again.allows(timed)
