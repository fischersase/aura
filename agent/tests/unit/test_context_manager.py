from google.genai import types

from aura_agent.harness.context_manager import (
  current_request,
  drop_oldest_steps,
  estimate_tokens,
  shorten_old_results,
  trim_images,
)

IMG = types.Blob(mime_type="image/jpeg", data=b"\xff\xd8x")


def user(text):
  return types.Content(role="user", parts=[types.Part(text=text)])


def call(name, i):
  return types.Content(role="model", parts=[types.Part(function_call=types.FunctionCall(id=f"c{i}", name=name, args={"i": i}))])


def resp(name, i, size=100, image=False):
  parts = [types.Part(function_response=types.FunctionResponse(id=f"c{i}", name=name, response={"out": "x" * size}))]
  if image:
    parts.append(types.Part(inline_data=IMG))
  return types.Content(role="user", parts=parts)


def test_only_last_two_images_survive():
  contents = [user("los")] + [c for i in range(5) for c in (call("screenshot", i), resp("screenshot", i, image=True))]
  assert trim_images(contents) == 3
  images = [p for c in contents for p in c.parts or [] if p.inline_data]
  assert len(images) == 2 and contents[-1].parts[-1].inline_data is not None


def test_old_large_results_are_shortened_recent_kept():
  contents = [user("los")] + [c for i in range(10) for c in (call("read_file", i), resp("read_file", i, size=5000))]
  assert shorten_old_results(contents) == 4
  sizes = [len(str(p.function_response.response)) for c in contents for p in c.parts or [] if p.function_response]
  assert all(s < 2000 for s in sizes[:4]) and all(s > 5000 for s in sizes[4:])


def test_dropping_keeps_pairs_first_message_and_recent_steps():
  contents = [user("Räum Downloads auf")] + [c for i in range(30) for c in (call("list_dir", i), resp("list_dir", i, size=2000))]
  before = estimate_tokens(contents)
  dropped = drop_oldest_steps(contents, budget_chars=20000)
  assert dropped and estimate_tokens(contents) < before
  assert contents[0].parts[0].text == "Räum Downloads auf" and "ausgeblendet" in contents[1].parts[0].text
  # Jeder verbliebene Aufruf hat direkt danach sein Ergebnis.
  for i, c in enumerate(contents):
    if c.role == "model" and any(p.function_call for p in c.parts):
      assert any(p.function_response for p in contents[i + 1].parts)


def test_current_request_is_the_latest_real_user_message():
  contents = [user("Wie heißt mein Drucker?"), types.Content(role="model", parts=[types.Part(text="Brother")]),
              user("Und räum jetzt Downloads auf"), call("list_dir", 1), resp("list_dir", 1), user("[Hinweis der App] …")]
  assert current_request(contents) == "Und räum jetzt Downloads auf"
