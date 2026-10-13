"""Tool results are shortened so the model still sees every entry (2026-10-13: Jira search with long descriptions)."""

import json

from aura_agent.harness.guard import MAX_RESULT_CHARS, _clip_result, _failed, compact_json


def _jira(n: int, desc: int) -> str:
    issues = [
        {
            "key": f"AURA-{i}",
            "fields": {
                "summary": f"Ticket {i}",
                "status": {"name": "Zu erledigen"},
                "description": "x" * desc,
            },
        }
        for i in range(n)
    ]
    return json.dumps({"issues": issues})


def test_long_json_keeps_every_entry_and_stays_valid():
    out = compact_json(_jira(60, 8000))
    assert out is not None
    assert len(out) <= MAX_RESULT_CHARS
    data = json.loads(out)
    assert [i["key"] for i in data["issues"]] == [f"AURA-{i}" for i in range(60)]
    assert data["issues"][0]["fields"]["summary"] == "Ticket 0"


def test_very_long_lists_are_cut_with_a_note():
    data = json.loads(compact_json(_jira(2000, 10)) or "null")
    assert data["issues"][-1].startswith("…")
    assert data["issues"][0]["key"] == "AURA-0"


def test_mcp_results_inside_lists_are_clipped():
    result = {"content": [{"type": "text", "text": _jira(60, 8000)}], "isError": False}
    out = _clip_result(result)
    text = out["content"][0]["text"]
    assert len(text) <= MAX_RESULT_CHARS
    assert len(json.loads(text)["issues"]) == 60
    plain = _clip_result({"content": [{"type": "text", "text": "y" * 50000}]})
    assert len(plain["content"][0]["text"]) < 13000


def test_short_results_stay_untouched_and_non_json_is_none():
    assert _clip_result({"content": [{"text": "kurz"}]}) == {"content": [{"text": "kurz"}]}
    assert compact_json("kein json") is None


def test_mcp_tool_errors_count_as_failed():
    assert _failed({"content": [{"type": "text", "text": "invalid cloudId"}], "isError": True})
    assert not _failed({"content": [], "isError": False})
