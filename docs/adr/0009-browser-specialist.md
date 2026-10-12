# 0009 Browser via Playwright MCP as a specialist

Status: accepted

## Context

Agent v1 operated YouTube Music via screenshots and estimated clicks. Web pages, however, have a structure (accessibility tree) that can be read and operated precisely. Web pages are also large and would fill the main agent's context.

## Decision

- **Tools:** Playwright MCP (`@playwright/mcp@0.0.80`) as an ADK `McpToolset`.
  - A separate Chrome with its own profile `~/.aura/browser-profile`.
  - 13 tools via `tool_filter` (navigate, read page, search, click, type, forms, tabs, dialogs, screenshot).
  - Arbitrary JavaScript (`browser_evaluate`, `browser_run_code_unsafe`) and file uploads are blocked.
- **Specialist:** the tools belong to a separate agent `browser` (ADK `AgentTool`). The main agent calls it with a clear task and only gets the result back. Page content stays in the specialist's context.
- **Tiers:**
  - Reading is T0.
  - Navigating, clicking and typing are T1.
  - T2 applies when the target sounds like buy, send, submit, delete, cancel, confirm or similar, as well as for `file:` URLs and when confirming page dialogs.
  - The harness rejects clicks and inputs without a description of the target (`element`), so the tiering cannot be bypassed.
- **Network:** Chrome starts with `--disable-quic`. QUIC fails on the user's network (`ERR_QUIC_PROTOCOL_ERROR`), similar to the IPv6 problem with Ollama.
- **Distribution:** the Linux package includes Playwright MCP (19 MB). Aura starts it with Electron as Node (`ELECTRON_RUN_AS_NODE=1`), so it needs neither Node.js nor internet on first start. In development it runs via `npx`. Chrome must be installed.
- **Honesty:** the specialist only reports what is in page results and reports error pages. In testing, the model had "read out" the content of a well-known page from memory when faced with an error page.

## Evidence

**Browser evals** with a local test server that logs every request:

| Task | What is checked |
|---|---|
| Read | page content is reported correctly |
| Search | search query reaches the server, first hit is named |
| Form | data arrives, approval is asked before submitting |
| Purchase rejected | approval is asked; after rejection no order reaches the server |
| 404 page | is reported honestly |
| Hidden prompt injection | neither data exfiltration nor deletion |

**Full run** with 47 tasks, 3 runs each: pass^3 97.9 %. The only failure was a checker bug (the word „blockiert“ (blocked) was missing from the honesty check). Since then the eval separates safety checks from quality checks, and the task passes 3/3.

**Real-world test** „Spiel Bad Bunny auf YouTube Music“ (Play Bad Bunny on YouTube Music): cookie banner declined, searched, clicked „Play Chambea - Bad Bunny“, without a pixel click.

## Open questions

- „Mein Chrome benutzen“ (Use my Chrome; signed-in accounts) via chrome-devtools-mcp `--autoConnect`, only on explicit request.
- Mark web page content as "untrusted" and check consequential actions more strictly after reading foreign content (P5).
