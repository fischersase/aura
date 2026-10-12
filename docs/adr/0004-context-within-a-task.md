# 0004 Context management within a task

Status: accepted

## Context

ADK's `EventsCompactionConfig` only summarizes events **after** a task has completed (trigger `compaction_interval` or `token_threshold`, "post-invocation"). A long task with 40 or more steps and screenshots can therefore overflow the context window in the middle of the task, especially with `num_ctx` 32K.

## Decision

- **Between tasks:** ADK compaction with `LlmEventSummarizer` on the same local model.
- **Within a task:** our own `ContextManager` in `before_model_callback`. It only modifies the request, never the stored events.
  - Only the last 2 images are kept.
  - Tool outputs over 4,000 characters are truncated in the middle; the full output is available as an artifact.
  - From 60 % of `num_ctx`, older steps are condensed into a summary.
  - Re-pinned on every request: original request, task list, AGENTS.md, MEMORY.md index, tier rules.

## Consequences

- Tests with `ScriptedLlm` check that pinned context survives every condensation and that images stay limited.
