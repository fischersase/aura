from aura_agent.models import repair

KNOWN = ["media_control", "launch_app", "read_file", "web_search"]


def test_resolve_name_exact_and_normalized():
  assert repair.resolve_name("launch_app", KNOWN) == "launch_app"
  assert repair.resolve_name("Launch-App", KNOWN) == "launch_app"
  assert repair.resolve_name("functions.read_file", KNOWN) == "read_file"
  assert repair.resolve_name("default_api.web_search", KNOWN) == "web_search"


def test_resolve_name_fuzzy_only_when_close():
  assert repair.resolve_name("media_controll", KNOWN) == "media_control"
  assert repair.resolve_name("launch", KNOWN) is None
  assert repair.resolve_name("delete_everything", KNOWN) is None
  assert repair.resolve_name(None, KNOWN) is None


def test_parse_args_variants():
  assert repair.parse_args({"a": 1}) == {"a": 1}
  assert repair.parse_args('{"a": 1}') == {"a": 1}
  assert repair.parse_args("{'a': 1,}") == {"a": 1}
  assert repair.parse_args("") == {}
  assert repair.parse_args(None) == {}
  assert repair.parse_args("[1, 2]") is None


def test_extract_tagged_call_and_keep_rest():
  text = 'Ich pausiere.\n<tool_call>{"name": "media_control", "arguments": {"action": "pause"}}</tool_call>'
  calls, rest = repair.extract_text_calls(text, KNOWN)
  assert [(c.name, c.args) for c in calls] == [("media_control", {"action": "pause"})]
  assert rest == "Ich pausiere."


def test_extract_fenced_and_bare_json():
  fenced = '```json\n{"name": "launch_app", "parameters": {"name": "Firefox"}}\n```'
  calls, rest = repair.extract_text_calls(fenced, KNOWN)
  assert calls[0].name == "launch_app" and calls[0].args == {"name": "Firefox"} and rest == ""
  calls, _ = repair.extract_text_calls('{"name": "web_search", "arguments": "{\\"query\\": \\"x\\"}"}', KNOWN)
  assert calls[0].args == {"query": "x"}


def test_extract_ignores_unknown_tools_and_plain_text():
  calls, rest = repair.extract_text_calls('<tool_call>{"name": "rm_rf", "arguments": {}}</tool_call>', KNOWN)
  assert calls == [] and "rm_rf" in rest
  calls, rest = repair.extract_text_calls("Die Musik ist pausiert.", KNOWN)
  assert calls == [] and rest == "Die Musik ist pausiert."


def test_coerce_types_to_schema():
  schema = {"properties": {"level": {"type": "integer"}, "on": {"type": "boolean"}, "name": {"type": "string"}, "x": {"type": "number"}}}
  out = repair.coerce_types({"level": "30", "on": "true", "name": "30", "x": "0.5"}, schema)
  assert out == {"level": 30, "on": True, "name": "30", "x": 0.5}
  assert repair.coerce_types({"level": "laut"}, schema) == {"level": "laut"}
