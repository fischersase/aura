# 0003 Approvals and rules at the tool boundary

Status: accepted

## Context

ADK offers `FunctionTool(require_confirmation=…)` and `tool_context.request_confirmation()`. Both are marked experimental and, according to the docs, cannot be used with `DatabaseSessionService`. They also require resume logic via the ADK API.

## Decision

- Every tool execution passes through the harness `GuardedTool`, hooked in as an ADK plugin (`before_tool_callback`, `after_tool_callback`, `on_tool_error_callback`). This also applies to MCP tools.
- Flow: validate arguments → determine tier T0 to T3 and the exact effect → evaluate rules (deny before ask before allow) → if needed, request approval from Electron via RPC → execute → check postcondition → mark taint → audit.
- A rejection is reported to the model as the tool result `{"error": "Der Nutzer hat diese Aktion abgelehnt."}` (The user rejected this action.).
- The harness answers unknown tool names with an error message and the list of available tools.
- Exceptions in tools become error results via `on_tool_error_callback`.
- The TaskController rejects empty final answers once.

## Evidence (canary tests)

- `test_plugin_sees_and_blocks_tools_inside_agent_tool`: the plugin also sees and blocks calls inside the specialist (AgentTool inherits plugins); the inner model sees the rejection.
- `test_plugin_can_answer_unknown_tool_names`: invented names do not cause a crash.
- `test_tool_exception_reaches_on_tool_error_callback`: errors come back as results.

## Consequences

- Approvals wait as an awaited RPC. If the process dies, pending approvals count as rejected; this is the safe default.
- The canary tests must be green before every ADK update.
