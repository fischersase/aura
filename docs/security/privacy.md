# Aura privacy documentation

Status: 2026-10-12, based on `main` at commit 3313787. Jira: AURA-30 (this document), AURA-48 (privacy features).
Related: [threat-model.md](threat-model.md).

## 1. Summary

- Aura is a desktop app without a server of its own. There is **no account, no telemetry, no analytics, no crash
  reporting** (section 5).
- All data is stored **locally** in two places: Electron's `userData` directory and `~/.aura`.
- Data leaves the machine only to services the user chose: **Google Gemini** (when the provider is Gemini, with the
  user's own API key), **Hugging Face** (one-time Whisper model download), **websites** the browser specialist visits,
  **MCP servers** the user configured, and the **MCP registry** / **Ollama model registry** when the user searches or
  downloads there.
- In **fully local mode** (Ollama + Whisper) prompts, audio, screenshots and tool results stay on the machine.

## 2. Storage locations

| Name | Linux | Windows |
|---|---|---|
| `userData` (Electron) | `~/.config/Aura` (`$XDG_CONFIG_HOME/Aura`) | `%APPDATA%\Aura` |
| Agent data dir | `userData/agent` | `%APPDATA%\Aura\agent` |
| Aura home | `~/.aura` | `%USERPROFILE%\.aura` |

Code: [src/store.js](../../src/store.js), [src/secrets.js](../../src/secrets.js), [src/chats.js](../../src/chats.js),
[src/usage.js](../../src/usage.js), [src/agent2/bridge.js](../../src/agent2/bridge.js),
[agent/src/aura_agent/runtime/settings.py](../../agent/src/aura_agent/runtime/settings.py),
[agent/src/aura_agent/runtime/server.py](../../agent/src/aura_agent/runtime/server.py).

## 3. Data inventory

"Gemini" in the recipient column means: only when the provider is Gemini (Settings → *KI-Modell*). "Local" means the
data never leaves the machine through Aura.

| Data item | Source | Where stored | Retention | Recipients | How to delete |
|---|---|---|---|---|---|
| Settings (hotkeys, provider, models, budget, language) | User | `userData/settings.json` | Until changed | Local | Delete file or uninstall |
| **Gemini API key** | User | `userData/settings.json` → `apiKeyEnc` (Electron `safeStorage`; base64 if no keyring); or env `GEMINI_API_KEY` | Until removed | Google (as credential with each request) | Settings or Zentrale → *Schlüssel* → delete |
| **User profile** (name, location, occupation, about, preferences) | User (optional) | `userData/settings.json` → `profile` | Until changed | Gemini (in system prompt, only if *share* is on) | Zentrale → *Profil*; switch off *share* |
| MCP secrets | User | `userData/secrets.json` (`safeStorage`, mode 0600) | Until removed | The MCP server that references `${secret:NAME}` | Zentrale → *Schlüssel* |
| **Chat history** (text only; screenshots replaced by `[Bildschirmfoto]`) | User + model | `userData/chats/<id>.json` | Last 200 chats, older pruned automatically | Gemini (the history is resent with each turn) | Delete chat in panel/Zentrale; delete folder |
| **Agent sessions** (full turns incl. tool calls and results) | Agent | `userData/agent/sessions.db` (SQLite) | No automatic deletion | Gemini (current session context) | Delete file (agent stopped). **Not removed when a chat is deleted** (gap, AURA-48) |
| Episodic memory (past conversations, full-text index) | Agent | `userData/agent/memory.db` (SQLite) | No automatic deletion | Gemini (via `recall` results) | Delete file. Not removed with a chat (gap, AURA-48) |
| **Long-term memory** | Agent (`remember`) and user | `~/.aura/memory/MEMORY.md` (≤ 150 entries), older entries in `~/.aura/memory/archiv.md` | Until removed; archive grows | Gemini (MEMORY.md is in every system prompt) | Edit/delete in Zentrale → *Gedächtnis* or the files; ask Aura to forget |
| **Audit log** (task text, tool names, arguments ≤ 500 chars, approvals, results status) | Agent | `userData/agent/audit/YYYY-MM.jsonl` | No automatic deletion | Local | Delete files (breaks the hash chain for that month by design) |
| Agent process log (stderr) | Agent | `userData/agent/agent.log` (+ `.1`) | Rotated at 5 MB, one backup | Local | Delete files |
| Legacy v1 agent log | v1 agent | `userData/agent-log.jsonl` | No automatic deletion | Local | Delete file |
| Cost tracking (estimated USD, request count, Live minutes) | App | `userData/usage.json` | Current month only (reset monthly) | Local | Delete file |
| Tool policy, hooks, MCP config, instructions, skills | User / "always allow" | `~/.aura/policy.toml`, `hooks.json`, `mcp.json`, `AGENTS.md`, `skills/` | Until removed | `AGENTS.md` and active skills: Gemini (system prompt) | Edit in Zentrale or delete files |
| **Browser specialist profile** (cookies, logins, history of the agent's Chrome) | Websites | `~/.aura/browser-profile` | Until removed | Visited websites | Delete folder |
| Browser artifacts (screenshots/downloads by Playwright MCP) | Websites | `userData/agent/browser` | No automatic deletion | Local | Delete folder |
| **Screenshots** | Screen | Memory only (not written by Aura; chats keep a placeholder) | Request lifetime | Gemini (chat with screen, agent `screenshot` tool, Live turn) | — |
| **Microphone audio** (dictation, Rambler, Live) | Microphone | Memory only | Request lifetime | Gemini (dictation, Rambler, Live) or local Whisper | — |
| **Screen sharing frames** (Live) | Screen | Memory only | Stream lifetime | Gemini Live (WebSocket); local Live sends a JPEG per turn to Ollama | — |
| Tool results (file contents, command output, UI text, web pages, MCP results) | Agent tools | `sessions.db`, `memory.db`; clipped excerpts in audit | See rows above | Gemini (as model context) | See rows above |
| Whisper model | Hugging Face | Chromium cache storage under `userData` | Until cache cleared | Hugging Face sees IP/User-Agent on download | Clear `userData` cache folders |
| Ollama models | Ollama registry (via local Ollama) | Ollama's own store (`~/.ollama`) | Managed by Ollama | Ollama registry sees the download | `ollama rm` |

## 4. Data flows per mode

### 4.1 Fully local (provider = Ollama, Whisper for speech)

| Feature | Flow | Leaves the machine? |
|---|---|---|
| Chat, agent tasks | Electron/agent → Ollama at `ollamaUrl` (default `http://127.0.0.1:11434`) | No (unless the user points `ollamaUrl` to another host) |
| Dictation, Rambler, local Live | Mic → hidden `stt` window → Whisper (ONNX/WASM) → text → Ollama | No (model download once from Hugging Face) |
| Screenshots in chat / agent / local Live | `desktopCapturer` → JPEG → Ollama | No |
| Browser specialist | Agent → Playwright MCP → Chrome → websites | Yes, to the websites visited (normal browsing) |
| User MCP servers | Agent → server (stdio or HTTP) | Depends on the server. Local connectors from the Aura catalog or the MCP registry run in a sandbox on Linux (only their own folder `~/.aura/connectors/<name>`, not your files); on Windows and macOS they can read your files (no sandbox yet) |

### 4.2 Gemini (provider = Gemini, user's own key)

| Feature | Data sent to Google | Endpoint |
|---|---|---|
| Chat | Chat history, system prompt (incl. profile if shared), optional screenshot | `generativelanguage.googleapis.com` ([src/gemini.js](../../src/gemini.js)) |
| Agent tasks | System prompt incl. `MEMORY.md`, profile, `AGENTS.md`, active skills; user request; **all tool results** (file contents, command output, UI trees, web content, screenshots, MCP results) | Gemini via Google ADK ([runtime/server.py](../../agent/src/aura_agent/runtime/server.py) `make_model`) |
| Dictation, Rambler | Recorded audio (WAV), selected text for Rambler instructions | Gemini (`dictationModel`, `ramblerModel`) |
| Live | Continuous microphone audio, screen frames (default 1 fps) while Live is active, spoken answers returned | Gemini Live WebSocket ([src/renderer/live.js](../../src/renderer/live.js)) |

Google processes this under the Gemini API terms that apply to the user's key (for unpaid tiers Google may use content
to improve its products; paid tiers differ). Aura does not control this; the user chooses it.

## 5. Telemetry

Verified on 2026-10-12 by searching `src/`, `agent/src`, `package.json` and `agent/pyproject.toml` for `telemetry`,
`analytics`, `sentry`, `posthog`, `mixpanel`, `crashReporter`, `google-analytics` and by listing all hard-coded URLs in
the Electron main process:

- No telemetry, analytics or crash-reporting SDK is included. The only hit is
  [agent/src/aura_agent/__main__.py](../../agent/src/aura_agent/__main__.py) lowering the log level of ADK's internal
  OpenTelemetry logger (no exporter is configured).
- No auto-updater; updates come through apt or a new installer.
- Hard-coded outbound endpoints: `generativelanguage.googleapis.com` (Gemini, only with provider Gemini),
  `registry.modelcontextprotocol.io` (only when the user searches the MCP registry in the Zentrale),
  Hugging Face (Whisper model download, [src/renderer/stt.html](../../src/renderer/stt.html) CSP).
- **Cost tracking is local only**: [src/usage.js](../../src/usage.js) estimates cost from token counts returned by
  Gemini and stores the monthly sum in `userData/usage.json`. Nothing is reported anywhere.

## 6. Consent and control points

| Point | Exists today | Gap / planned (AURA-48) |
|---|---|---|
| Choice of provider (local vs Gemini) | Setup assistant and Settings; agent defaults to Ollama | Setup preselects Gemini; no explicit "data leaves your PC" notice on choosing Gemini |
| Screenshot in chat | Off by default (`includeScreenInChat: false`), per-message toggle | — |
| Agent `screenshot` tool | Runs at T0 without asking; step visible in the panel | No per-task consent, no on-screen indicator while captured |
| Microphone | Only on explicit hotkey/button (dictation, Rambler, Live); glow overlay shows activity | Electron permission granted to all windows (AURA-14) |
| Screen sharing (Live) | Live started explicitly; status "sees your screen" | Option to start Live without screen is not prominent |
| Profile in prompt | `share` switch | — |
| Memory | `remember` asks after untrusted content; file viewable/editable | No per-entry approval for clean tasks; no "pause memory" switch |
| Consequential actions | T2 approval card with exact effect | — |
| Deletion | Per chat, per memory entry, per secret | Chat deletion does not delete `sessions.db`/`memory.db` content; no "delete all data" or export button |
| Remote Ollama URL | Configurable | No warning for non-loopback / unencrypted URL |

## 7. Legal notes (not legal advice)

### GDPR

- **Controller / data subject:** Aura's maintainers do not receive or process any personal data. Processing happens
  on the user's device under the user's control; for personal use the household exemption (Art. 2(2)(c) GDPR) typically
  applies. The main data subject is the user themself; third-party personal data can appear in files, e-mails, web
  pages or screenshots the agent processes.
- **Gemini:** when the user chooses Gemini with their own API key, the user's relationship with Google governs the
  processing (Google's API terms and, for business use, Google's data processing terms). The user should not choose
  Gemini for data they are not allowed to share with Google; fully local mode is the alternative.
- **Data minimisation:** screenshots and audio are not persisted; chats are pruned to 200; audit values are clipped;
  memory rejects secrets.
- **Access / export (Art. 15, 20):** all data is in plain files (JSON, JSONL, Markdown, SQLite) at the paths in
  section 3. A one-click export is missing (AURA-48).
- **Erasure (Art. 17):** delete the paths in section 3; uninstalling does not remove `userData` or `~/.aura`.
- **Business deployments:** an organisation deploying Aura is the controller and needs its own assessment (DPIA when
  screen/agent access to personal data of others is involved).

### EU AI Act

- Aura is a general-purpose assistant, not a high-risk system under Annex III in its intended use.
- **Transparency (Art. 50(1)):** users interact with Aura knowingly through its own UI, which presents it as an AI
  assistant; the spoken Live voice is part of the same assistant UI.
- **Synthetic content (Art. 50(2)/(4)):** Aura does not generate images, video or deepfakes. Synthetic speech in Live
  comes from Gemini (Google is the provider of that model). Text Aura writes into other programs (Rambler, agent typing)
  is dictated or requested by the user.
- Model providers (Google for Gemini/Gemma, Alibaba for Qwen) carry the GPAI obligations; Aura is a downstream deployer.

### Model terms

- **Gemma** models (default local model `gemma4:*`) are used under the Gemma Terms of Use and Prohibited Use Policy;
  Aura does not redistribute model weights (Ollama downloads them on the user's request). See
  [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
- **Gemini API** use is subject to Google's API terms and Generative AI Prohibited Use Policy, accepted by the user
  when creating the key.
- **Whisper** (MIT) is downloaded from Hugging Face (`onnx-community/whisper-*`).

## 8. Derived privacy requirements

| ID | Requirement | Rationale | Verification |
|---|---|---|---|
| NFR-PRIV-001 | Aura contains no telemetry, analytics or crash reporting, and contacts no endpoint other than those listed in section 5 unless the user configures it (Ollama URL, MCP servers, websites). | Trust; local-first promise | CI grep for telemetry SDKs; review of new outbound URLs in PRs |
| NFR-PRIV-002 | In local mode no prompt, audio, screenshot or tool result is sent to a cloud service by Aura. | Local-first promise | E2E test with network blocked except loopback; chat, dictation and agent task succeed |
| NFR-PRIV-003 | Before the first request to Gemini, the user is told which data is sent (prompts, tool results, screenshots, audio) and must actively choose Gemini. | Informed consent (AURA-48) | UI test of setup flow; no preselected cloud option |
| NFR-PRIV-004 | Screenshots, microphone audio and screen-sharing frames are never written to disk by Aura. | Data minimisation | Code review; test that `chats.save` strips `inlineData` |
| NFR-PRIV-005 | Microphone and screen capture start only on an explicit user action and are visibly indicated while active. | Transparency, no covert capture | Manual test; permission handler test (AURA-14) |
| NFR-PRIV-006 | The agent's screenshot tool is visible as a step and can be disabled or set to ask. | Consent for screen content in agent tasks | Policy rule `screenshot = ask` respected (test) |
| NFR-PRIV-007 | Deleting a chat removes its content from all stores (`chats/`, `sessions.db`, `memory.db`). Deletions while the agent is not running are queued; at every agent start, sessions of chats the app no longer has are removed (voice sessions `voice-*` excepted). | Right to erasure | Implemented (AURA-106): `agent/tests/contract/test_chat_forget.py`, bridge test in `test/agent2.test.js` |
| NFR-PRIV-008 | The user can export and delete all Aura data in one action from the Zentrale. | GDPR Art. 15/17/20 convenience | UI test; export contains all section 3 items |
| NFR-PRIV-009 | Long-term memory never stores secrets (passwords, PINs, keys, account numbers) and is fully viewable and editable by the user. | Data minimisation, transparency | Unit tests on `memory/store.py` `SECRET` |
| NFR-PRIV-010 | Logs (audit, agent log) contain no credentials and clip long values; retention is bounded or user-controlled. | Minimisation; logs outlive tasks | Tests on `redact()` (AURA-17); retention setting |
| NFR-PRIV-011 | Profile data is included in prompts only when the user enabled sharing. | Purpose limitation | Unit test on `profilePrompt()` with `share: false` |
| NFR-PRIV-012 | Uninstall documentation lists all data paths and how to remove them. | Erasure | Doc review (README/this document) |
| NFR-PRIV-013 | A non-loopback or unencrypted Ollama URL triggers a warning that prompts leave the machine. | Avoid accidental disclosure | UI test |
| NFR-PRIV-014 | The browser specialist uses its own profile (`~/.aura/browser-profile`), never the user's normal browser profile. | Separation of the user's logged-in sessions from agent browsing | Test on Playwright MCP launch arguments |
