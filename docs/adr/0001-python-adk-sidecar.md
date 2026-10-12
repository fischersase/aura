# 0001 Python ADK as a sidecar, stdio JSON-RPC to Electron

Status: accepted

## Context

The agent is being rebuilt with Google ADK and should run with local models via Ollama first. ADK exists for Python, TypeScript, Go and Java. Aura is an Electron app (CommonJS, Node).

## Decision

- The agent runs as its own Python process `aura-agent` with `google-adk==2.11.0`, pinned in `agent/uv.lock`.
- Electron starts it and talks to it via JSON-RPC 2.0 over stdin/stdout (one JSON line per message), in both directions. There is no open port.
- Requests from the agent to Electron (approval, ask_user, screenshot, clipboard) are requests in the reverse direction.
- The operating-system tools live in the Python process. Electron only provides what only Electron can do: screen capture (including the Wayland stream), clipboard, notifications.

## Rationale

- **The TypeScript ADK is not sufficient.** It has no Ollama or OpenAI-compatible model (issue google/adk-js#533 open), no evaluation (`adk eval` exists only in Python), Live only as experimental, and no persistent local memory.
- **stdio instead of HTTP.** A process that executes shell commands should not open a port; this removes tokens, DNS rebinding and foreign local processes from the picture. The sidecar exits when Electron exits (EOF).
- **Tools in the sidecar.** Rules, tiers, verification and audit sit in the same process as the tool. Tests and evals run without Electron, with a fake host.

## Evidence (P0)

- Sidecar startup with all ADK imports: 1.1 s, 73 MB RSS.
- Canary tests `agent/tests/adk_canary/` (7 green): plugins also apply inside AgentTool sub-agents, `abort_signal` stops a running tool in under 2 s, SQLite sessions survive a restart, `SqliteMemoryService` finds earlier sessions.

## Consequences

- Two languages in the repo. The interface is secured by JSON schemas in `protocol/` and contract tests on both sides.
- Python must be shipped with the app (see 0006).
