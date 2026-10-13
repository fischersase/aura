import json

import httpx
from google.adk.models.llm_request import LlmRequest
from google.genai import types

from aura_agent.models.ollama_llm import OllamaLlm, to_messages, tool_specs


def request(contents, tools=None, system="Du bist Aura."):
    cfg = types.GenerateContentConfig(system_instruction=system, tools=tools)
    return LlmRequest(model="ollama/test", contents=contents, config=cfg)


def decl(name, props):
    return types.Tool(
        function_declarations=[
            types.FunctionDeclaration(
                name=name,
                description=f"{name} tut etwas",
                parameters=types.Schema(
                    type=types.Type.OBJECT, properties={k: types.Schema(type=t) for k, t in props.items()}
                ),
            )
        ]
    )


def test_messages_cover_text_calls_responses_and_images():
    png = b"\x89PNG\r\n\x1a\nfake"
    contents = [
        types.Content(role="user", parts=[types.Part(text="Pausiere")]),
        types.Content(
            role="model",
            parts=[
                types.Part(text="denke", thought=True),
                types.Part(
                    function_call=types.FunctionCall(id="c1", name="media_control", args={"action": "pause"})
                ),
            ],
        ),
        types.Content(
            role="user",
            parts=[
                types.Part(
                    function_response=types.FunctionResponse(
                        id="c1", name="media_control", response={"status": "Paused"}
                    )
                ),
                types.Part(inline_data=types.Blob(mime_type="image/png", data=png)),
            ],
        ),
    ]
    msgs = to_messages(request(contents))
    assert msgs[0] == {"role": "system", "content": "Du bist Aura."}
    assert msgs[1] == {"role": "user", "content": "Pausiere"}
    assert msgs[2] == {
        "role": "assistant",
        "content": "",
        "tool_calls": [{"function": {"name": "media_control", "arguments": {"action": "pause"}}}],
    }
    assert (
        msgs[3]["role"] == "tool"
        and msgs[3]["tool_name"] == "media_control"
        and json.loads(msgs[3]["content"]) == {"status": "Paused"}
    )
    assert msgs[4]["role"] == "user" and len(msgs[4]["images"]) == 1


def test_tool_specs_use_lowercase_json_schema():
    specs = tool_specs(request([], tools=[decl("volume", {"level": types.Type.INTEGER})]))
    assert specs == [
        {
            "type": "function",
            "function": {
                "name": "volume",
                "description": "volume tut etwas",
                "parameters": {"type": "object", "properties": {"level": {"type": "integer"}}},
            },
        }
    ]


def fake_ollama(lines, seen):
    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(json.loads(req.content))
        return httpx.Response(200, content="\n".join(json.dumps(x) for x in lines).encode())

    return httpx.MockTransport(handler)


async def collect(llm, req, stream=False):
    return [r async for r in llm.generate_content_async(req, stream=stream)]


async def test_generate_sends_num_ctx_and_parses_tool_call():
    seen = []
    lines = [
        {
            "message": {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"function": {"name": "Volume", "arguments": {"level": "30"}}}],
            }
        },
        {
            "message": {"role": "assistant", "content": ""},
            "done": True,
            "prompt_eval_count": 120,
            "eval_count": 8,
        },
    ]
    llm = OllamaLlm(model="ollama/gemma4:26b", num_ctx=32768, think=False, transport=fake_ollama(lines, seen))
    req = request(
        [types.Content(role="user", parts=[types.Part(text="Lautstärke 30")])],
        tools=[decl("volume", {"level": types.Type.INTEGER})],
    )
    out = await collect(llm, req)
    body = seen[0]
    assert (
        body["model"] == "gemma4:26b"
        and body["options"]["num_ctx"] == 32768
        and body["think"] is False
        and body["keep_alive"] == "30m"
    )
    fc = out[-1].content.parts[0].function_call
    assert fc.name == "volume" and fc.args == {"level": 30} and fc.id
    assert out[-1].usage_metadata.prompt_token_count == 120


async def test_generate_streams_partial_text_then_final():
    lines = [
        {"message": {"content": "Die Musik "}},
        {"message": {"content": "ist pausiert."}},
        {"message": {"content": ""}, "done": True, "eval_count": 5},
    ]
    llm = OllamaLlm(model="ollama/x", transport=fake_ollama(lines, []))
    out = await collect(llm, request([types.Content(role="user", parts=[types.Part(text="?")])]), stream=True)
    assert [r.partial for r in out] == [True, True, False]
    assert out[-1].content.parts[0].text == "Die Musik ist pausiert."


async def test_generate_extracts_text_tool_call():
    lines = [
        {
            "message": {"content": '<tool_call>{"name": "volume", "arguments": {"level": 10}}</tool_call>'},
            "done": True,
        }
    ]
    llm = OllamaLlm(model="ollama/x", transport=fake_ollama(lines, []))
    req = request(
        [types.Content(role="user", parts=[types.Part(text="leiser")])],
        tools=[decl("volume", {"level": types.Type.INTEGER})],
    )
    out = await collect(llm, req)
    parts = out[-1].content.parts
    assert len(parts) == 1 and parts[0].function_call.name == "volume"


async def test_missing_model_gives_clear_error():
    def handler(req):
        return httpx.Response(404, json={"error": "model 'gemma4:26b' not found"})

    llm = OllamaLlm(model="ollama/gemma4:26b", transport=httpx.MockTransport(handler))
    out = await collect(llm, request([types.Content(role="user", parts=[types.Part(text="hi")])]))
    assert out[0].error_code == "OLLAMA_404" and "nicht heruntergeladen" in out[0].error_message


async def test_empty_answer_is_retried():
    calls = []

    def handler(req):
        calls.append(1)
        if len(calls) == 1:
            lines = [{"message": {"content": ""}, "done": True, "eval_count": 8}]
        else:
            lines = [
                {
                    "message": {
                        "content": "",
                        "tool_calls": [{"function": {"name": "volume", "arguments": {"level": 5}}}],
                    },
                    "done": True,
                }
            ]
        return httpx.Response(200, content="\n".join(json.dumps(x) for x in lines).encode())

    llm = OllamaLlm(model="ollama/x", transport=httpx.MockTransport(handler))
    req = request(
        [types.Content(role="user", parts=[types.Part(text="leiser")])],
        tools=[decl("volume", {"level": types.Type.INTEGER})],
    )
    out = await collect(llm, req)
    assert len(calls) == 2 and out[-1].content.parts[0].function_call.name == "volume"


async def test_retry_after_empty_answer_turns_thinking_on():
    bodies = []

    def handler(req):
        body = json.loads(req.content)
        bodies.append(body)
        msg = {"content": "Fertig."} if body.get("think") else {"content": ""}
        return httpx.Response(200, content=json.dumps({"message": msg, "done": True}).encode())

    llm = OllamaLlm(model="ollama/x", think=False, transport=httpx.MockTransport(handler))
    out = await collect(llm, request([types.Content(role="user", parts=[types.Part(text="x")])]))
    assert [b.get("think") for b in bodies] == [False, True] and out[-1].content.parts[-1].text == "Fertig."
