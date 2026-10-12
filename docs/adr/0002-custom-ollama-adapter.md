# 0002 Custom OllamaLlm on the native Ollama API

Status: accepted

## Context

ADK talks to Ollama via LiteLLM (`ollama_chat/…`) or via `OpenAILlm` (OpenAI-compatible `/v1`).

- LiteLLM had a supply-chain incident in March 2026 (1.82.7/1.82.8).
- `num_ctx` cannot be set via `/v1`. If `num_ctx` differs from what chat and Rambler use in Aura, Ollama reloads the 18 GB model, which takes about 70 s.
- On the OpenAI path, gemma4 needs a special role `tool_responses`.

## Decision

`aura_agent.models.ollama_llm.OllamaLlm(BaseLlm)` talks to `/api/chat` directly:

- sets `num_ctx`, `keep_alive`, `think`, images and streaming,
- leaves the chat template to Ollama itself,
- routes every tool call through `aura_agent.models.repair`: normalize and fuzzy-match names, repair broken JSON, extract calls from the text, coerce types to the schema. Every repair is counted.

## Evidence (P0, `agent/spikes/`)

`tool_reliability.py` tested 10 typical requests (pause music, open app, read file, volume, web search …) with 8, 12 and 20 tools, each through the full ADK runner:

| Model | 8 tools | 12 tools | 20 tools | Median per run | Repairs |
|---|---|---|---|---|---|
| gemma4:26b | 10/10 | 10/10 | 10/10 | 0.5–0.8 s | 0 |
| qwen3.6:27b | 10/10 | 10/10 | 10/10 | 1.9–2.1 s | 0 |

`honesty.py` checks rejected, failed and successful actions with gemma4:26b:
- All 12 answers report the outcome truthfully.
- One answer was **empty**. The harness must catch empty final answers (see 0003).
- Images arrive: the album cover from MPRIS was described correctly.

Further findings:
- The model turned `~/notizen.txt` into the path `/home/user/notizen.txt`. Tools therefore resolve `~` and relative paths themselves, and the system prompt names the real home directory.

## Consequences

- About 300 lines of our own code instead of a dependency, secured by unit tests with recorded responses.
- Gemini continues to run via ADK's native `Gemini` model (only on request).
