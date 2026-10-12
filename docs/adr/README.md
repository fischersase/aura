# Architecture decision records (ADR) for Aura Agent v2

Each decision is in its own file: context, decision, evidence, consequences.
Evidence from phase 0 (spikes) is in `agent/spikes/` and `agent/tests/adk_canary/`.

| No. | Decision | Status |
|---|---|---|
| [0001](0001-python-adk-sidecar.md) | Python ADK as a sidecar, stdio JSON-RPC to Electron | accepted |
| [0002](0002-custom-ollama-adapter.md) | Custom `OllamaLlm` on the native Ollama API instead of LiteLLM | accepted |
| [0003](0003-approvals-in-the-harness.md) | Approvals and rules as a plugin at the tool boundary, not via ADK confirmation | accepted |
| [0004](0004-context-within-a-task.md) | Own context management within a task, ADK compaction only between tasks | accepted |
| [0005](0005-perception-api-before-pixels.md) | Order of perception: API, AT-SPI, browser DOM, pixels | accepted |
| [0006](0006-bundle-python.md) | The Python runtime is bundled | accepted |
| [0007](0007-local-default-model.md) | Local default model gemma4:26b (benchmark: 100 %, ahead of qwen3.6 27b/35b and gemma4:e4b) | accepted |
| [0008](0008-eval-suite.md) | Desktop eval suite as acceptance test (real state, isolated, pass^k) | accepted |
| [0009](0009-browser-specialist.md) | Browser via Playwright MCP as a separate specialist, click tiering by target | accepted |
| [0010](0010-desktop-apps-via-at-spi.md) | Desktop apps via AT-SPI (system Python helper), specialist "apps" | accepted |
| [0011](0011-wayland-gnome-extension.md) | Windows under GNOME Wayland via our own Shell extension "Aura Bridge" | accepted |
| [0012](0012-windows-backend.md) | Windows backend behind the same tools (user32, UI Automation, SMTC, PowerShell tiering), NSIS installer | accepted |
