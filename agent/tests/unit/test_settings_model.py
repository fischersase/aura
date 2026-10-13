import pytest

from aura_agent.models.ollama_llm import OllamaLlm
from aura_agent.rpc.peer import RpcError
from aura_agent.runtime.server import make_model
from aura_agent.runtime.settings import AgentSettings


def test_local_is_default():
    m = make_model(AgentSettings.from_params({"model": "gemma4:26b", "numCtx": 32768}))
    assert isinstance(m, OllamaLlm) and m.num_ctx == 32768 and m.model == "ollama/gemma4:26b"


def test_gemini_only_when_chosen_and_with_key():
    from google.adk.models.google_llm import Gemini

    m = make_model(
        AgentSettings.from_params(
            {"provider": "gemini", "geminiModel": "gemini-3.8-flash", "geminiApiKey": "k"}
        )
    )
    assert isinstance(m, Gemini) and m.model == "gemini-3.8-flash"
    with pytest.raises(RpcError):
        make_model(AgentSettings.from_params({"provider": "gemini"}))


def test_api_key_is_not_in_repr():
    assert "geheim123" not in repr(
        AgentSettings.from_params({"provider": "gemini", "geminiApiKey": "geheim123"})
    )
