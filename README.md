<p align="center"><img src="assets/icon.png" width="96" alt=""></p>

# Aura

[![CI](https://github.com/fischersase/aura/actions/workflows/ci.yml/badge.svg)](https://github.com/fischersase/aura/actions/workflows/ci.yml)
[![CodeQL](https://github.com/fischersase/aura/actions/workflows/codeql.yml/badge.svg)](https://github.com/fischersase/aura/actions/workflows/codeql.yml)
[![Release](https://img.shields.io/github/v/release/fischersase/aura)](https://github.com/fischersase/aura/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A desktop assistant for Windows and Linux. Press a hotkey and a small window opens in the corner: chat, talk, share your screen, dictate into any text field, and let Aura do things on your PC for you.

- **Chat and voice:** type or press the microphone; *Live* mode sees your screen and points where to click.
- **Rambler:** dictate into any text field of any program.
- **Agent:** opens programs and websites, finds and edits files, controls music, windows and settings, runs commands. It plans first, checks its own results and asks before anything consequential.
- **Your choice of model:** fully local and free with open models through [Ollama](https://ollama.com) (Gemma 4, Qwen, …), or Google Gemini with an API key.

The user interface is German. *Formerly "Gemini Overlay".*

## Install

**Windows 10/11 (x64):** download [**Aura-Setup.exe**](https://github.com/fischersase/aura/releases/latest/download/Aura-Setup.exe) and run it. It installs for your user only (no admin rights) and adds Aura to the Start menu. The installer is not code-signed yet, so SmartScreen may ask: **More info → Run anyway**.

**Ubuntu / Debian (x64):**

```bash
curl -fLo /tmp/aura.deb https://github.com/fischersase/aura/releases/latest/download/aura_amd64.deb
sudo apt install /tmp/aura.deb
```

Then start "Aura" from the app menu. The package also adds the signed Aura package source, so updates come with your normal system updates (see below). Upgrading from "Gemini Overlay"? Remove it with `sudo apt remove windows-gemini`; your settings move over automatically.

**Other Linux (x64):** [Aura-x86_64.AppImage](https://github.com/fischersase/aura/releases/latest/download/Aura-x86_64.AppImage), then `chmod +x` and run it.

The setup assistant opens on first start and lets you pick Gemini or local models. Aura lives in the system tray (ring icon); right-click it for settings, or start "Aura" again. All downloads and instructions are also on [fischersase.github.io/aura](https://fischersase.github.io/aura/).

## Update

| System | How |
| --- | --- |
| Ubuntu / Debian | `sudo apt update && sudo apt upgrade` (or the *Software Updater*) |
| Windows | run the newest [Aura-Setup.exe](https://github.com/fischersase/aura/releases/latest/download/Aura-Setup.exe) over the old one; settings stay |
| AppImage | download the newest AppImage |
| From a clone of this repository | `make update` (newest release) or `make local` (build and install your checkout) |

The running version is shown next to the name in the Aura window, in the Zentrale and in the tray menu.

**Verify a download:** every release has [SHA256SUMS](https://github.com/fischersase/aura/releases/latest/download/SHA256SUMS) and a build provenance attestation (`gh attestation verify aura_amd64.deb -R fischersase/aura`). The apt source is signed with key `868F 8CD6 AA8A 4427 E924 3587 21C1 6696 774D 4865` (and, during the key rotation, also `2D1C 8196 491F 9E92 A004 F4AE 102E AFB1 7FC8 5F90`).

## Option A: Gemini (API key, no Google Cloud project needed)

1. Open [Google AI Studio → API keys](https://aistudio.google.com/apikey) and click **Create API key**. AI Studio creates a project for you.
2. If asked, click **Set up billing** for that project. Google AI Pro subscribers get $10/month in credits: activate them under [Google Developer Program benefits](https://developers.google.com/program/my-benefits).
3. Paste the key (starts with `AIza`) into the setup assistant.

To replace the key later: tray icon → right-click → **Settings** → paste the new key → **Test** → **Save**.

### Budget (default: $10/month)

- **In the app:** set the monthly budget in the setup assistant or in Settings. The Gemini window shows the estimated cost for the current month, and requests stop once the budget is reached. Set it to `0` for no limit.
- **At Google (recommended):** open [AI Studio → Spend](https://aistudio.google.com/spend), pick the project of your key, then **Monthly spend cap → Edit spend cap**. Google bills with up to ~10 minutes delay, so small overruns are possible.

The in-app number is an estimate based on token usage; AI Studio shows the real figures.

## Option B: local models with Ollama (free, private)

1. Install [Ollama](https://ollama.com/download) (Linux: `curl -fsSL https://ollama.com/install.sh | sh`) and make sure it runs.
2. In the setup assistant (or Settings → *KI-Modell*) choose **Lokal über Ollama**, pick a model and click **Herunterladen**.

| Model | Good for | Rough hardware |
| --- | --- | --- |
| `gemma4:e4b` (default) | chat, dictation, Live with screen | 16 GB RAM or 8 GB VRAM |
| `gemma4:e2b` | weaker PCs | 8 GB RAM |
| `qwen3.5:9b`, `qwen3-vl:8b` | chat, Live; Qwen3-VL is good at pointing | 16 GB RAM or 8 GB VRAM |
| `gemma4:26b` | best quality | 24 GB VRAM or 32 GB RAM |
| `qwen3.6:27b`, `gemma4:31b` | agent tasks (tools) | 24 GB VRAM |
| `deepseek-r1:8b` | text only (no screen) | 16 GB RAM |

Any other Ollama model you have installed shows up in the list too. Kimi is only available as a cloud model.

What changes locally:

- **Speech recognition** runs inside the app with Whisper ([transformers.js](https://github.com/huggingface/transformers.js)); the model downloads once on first use. Ollama itself cannot take audio.
- **Rambler:** Whisper transcribes, the local model cleans up the text or applies your spoken instruction to the selection.
- **Gemini Live** becomes turn-based: you talk, it hears the pause, the model looks at a screenshot, answers out loud (system voices) and can point at the screen. Talk over it to interrupt. It is slower than Gemini Live and pointing is less precise.
- No costs, no budget; the window shows "lokal · 0 $".

## Voice input in the chat

Click the **microphone** next to the Live button, speak as long as you like (pauses are fine), click it again: Aura turns your speech into text and sends it, like the dictation in Gemini or ChatGPT. **Esc** cancels; closing the window keeps the text in the input field instead of sending it.

- **Local (Ollama):** Whisper runs on your computer (Settings → *Lokale Modelle* → speech model; `whisper-small` by default, downloaded once). Nothing leaves your PC. Whisper is told your Aura language, so short recordings are not mistaken for English.
- **Gemini:** `gemini-3.5-flash-lite`, the cheapest current model with audio input (about 0.1 cent per minute of speech), counted in your monthly budget. Change it under Settings → *Spracheingabe im Chat*.

## Agent: Aura acts on your PC

Ask in the chat or by voice, e.g. "pause the music", "open Antigravity", "tidy up my downloads folder by file type", "what's on my screen?", "search the web for tomorrow's weather in Berlin", "remember that my printer is a Brother HL-L2350DW".

Since v0.11 the agent is **Agent v2**, built on [Google ADK](https://adk.dev). It runs as its own process next to the app (`agent/`, Python, bundled in the Windows installer and the Linux packages) and works with your local Ollama model by default, or with Gemini if you chose Gemini in the settings. Architecture decisions and their evidence are in [docs/adr](docs/adr/README.md).

**How it works**

- **Plans, then acts.** Bigger or vague tasks ("tidy up", "sort") are explored first; Aura shows the plan and asks before changing anything. It keeps a task list visible in the window and asks you instead of guessing when something is unclear.
- **Checks its own results.** Opening a program waits for its window, pausing music reads the player state back, file changes are re-read. A claimed success that the check contradicts gets corrected; the answer shows *Ergebnis überprüft* or a warning.
- **Uses the most reliable way, not pixels.** Web pages via their structure (Playwright in its own Chrome profile; Edge on Windows without Chrome). Screenshot clicks are only a fallback.
  - Linux: music via MPRIS, programs via the accessibility tree (AT-SPI), windows via EWMH on X11 or the *Aura Bridge* GNOME extension on Wayland.
  - Windows: music via the Windows media controls, programs via UI Automation, windows via user32, programs from the Start menu (Store apps too), commands in PowerShell, settings in the registry ([ADR 0012](docs/adr/0012-windows-backend.md)).
- **Specialists** with their own context: `browser` (web pages, web search via DuckDuckGo), `apps` (desktop programs), `integrations` (your MCP servers).
- **Memory.** Facts you tell it go to `~/.aura/memory/MEMORY.md` (readable, editable); earlier conversations are searchable. Passwords, PINs and account data are never stored.

**Safety: every action has a tier**

| Tier | Examples | What happens |
| --- | --- | --- |
| T0 read | list files, read a file, media status, screenshot | runs |
| T1 local, reversible | open a program, pause music, new file, focus a window | runs |
| T2 consequential | delete (always to the trash), overwrite (with a diff), send, buy, install, close a window, unknown commands | asks you: *Nur jetzt*, *Für diesen Auftrag*, *Immer erlauben* (creates a rule), *Ablehnen* |
| T3 forbidden | SSH/GPG keys, browser passwords, keyrings and Windows credentials, `rm -rf ~` / `Remove-Item -Recurse C:\`, disk formatting, lock-screen, Defender and firewall settings | never, no rule can allow it |

- Rules in `~/.aura/policy.toml` (*Zentrale → Regeln*), your own hooks in `~/.aura/hooks.json` (block or force a question before a tool, observe after; on Windows `~` is your user folder, hooks may be `.ps1` or `.cmd`).
- Content from web pages, files and programs is treated as data, never as instructions. After reading such content together with local data, addresses that could carry data out always ask.
- **Emergency stop:** the stop button or Ctrl+Alt+Esc cancels the task and kills the commands it started (hard after 2 s).
- Every step goes to a hash-chained audit log (*Zentrale → Aktionsprotokoll*).
- A task that finishes while the window is closed sends a desktop notification.

**Tested, not just written:** over 300 unit, harness, contract and protocol tests run on every push, on Linux and on Windows (real windows, Start menu, UI Automation, PowerShell, recycle bin); a desktop eval suite of 54 everyday tasks (isolated: own display, D-Bus, home folder, test web server) checks the real end state with a real local model. See `agent/evals/` and [ADR 0008](docs/adr/0008-eval-suite.md).

**Models:** on an RTX 3090 `gemma4:26b` scored best (100 % of the eval tasks, ~3 s per task); see [ADR 0007](docs/adr/0007-local-default-model.md). Use a 32k context (Settings → *Lokale Modelle*).

**Previous agent:** *Zentrale → Übersicht → Agent-Version → v1* switches back.

## Aura Zentrale

One window to manage everything the agent uses: tray menu → *Aura Zentrale*, the grid button in the Aura window, or `aura --zentrale`.

- **Werkzeuge:** every built-in tool with a rule: *Standard* (ask only for changing actions), *Immer fragen*, *Nie fragen* or *Aus* (hidden from the model).
- **MCP-Server:** status, the tools each server offers (each with the same rule), switch servers on and off, add or edit them with a form.
- **MCP-Katalog:** search the official MCP registry and add a server in one click, including the keys it needs.
- **Skills:** list, switch on/off, create and edit `SKILL.md` files.
- **Anweisungen:** edit `AGENTS.md`. **Aktionsprotokoll** and **Chats:** what the agent did, and saved chats.
- **Regeln** (`policy.toml`), **Gedächtnis** (`MEMORY.md`) and **Systemprüfung:** checks Ollama, model, context size, Chrome, accessibility, session type and tools, and installs the *Aura Bridge* GNOME extension on Wayland.
- **Profil:** your name, location, role, background and how Aura should answer. Added to the system prompt of chats and agent tasks (can be switched off).
- **Schlüssel:** API keys and tokens, encrypted with the OS keystore in `secrets.json`. Values go in but never come back out; you can replace or delete them. Use them in `mcp.json` as `${secret:NAME}` in `env`, `headers`, `args` or `url`. Keys typed into a server form (names containing KEY, TOKEN, SECRET, PASSWORD, Authorization) and secret fields from the catalog are moved there automatically.

### In the browser

Tray menu → *Aura Zentrale im Browser*, the button in the Zentrale, or `aura --zentrale-web`. The page is served by Aura itself, only on `127.0.0.1` (port 47800 or the next free one), never on your network:

- Access needs a random 256-bit token that is created on every Aura start. It travels in the URL fragment (never sent to a server or logged), is moved into the tab's session storage and removed from the address bar.
- Requests are checked for the right `Host` and `Origin` (protects against DNS rebinding and other websites), must be JSON with a `Bearer` token, and pages get a strict Content-Security-Policy.
- "Alle Browser abmelden" in the Zentrale invalidates all open tabs.
- A browser tab can look at everything, but changing MCP servers, rules, skills, `AGENTS.md` or keys pops up a confirmation in Aura on the desktop. Opening local files and folders only works in the app.

## Extensions: instructions, skills, MCP servers

Like Claude Code, Gemini CLI or Codex, Aura reads extensions from `~/.aura` (Windows: `%USERPROFILE%\.aura`). Settings → *Erweiterungen* opens the files and shows what loaded.

- **`AGENTS.md`**: your standing instructions ("my invoices are in ~/Ablage", "answer briefly"). Added to every agent request.
- **Skills** in `~/.aura/skills/<name>/SKILL.md` or `~/.agents/skills/` ([Agent Skills format](https://agentskills.io): `name` and `description` in the front matter). The model only sees name and description and loads the full skill when it fits the task. Scripts in a skill still go through the approval for commands.
- **MCP servers** in `~/.aura/mcp.json`, same format as Claude Desktop:

```json
{
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest", "--isolated"] },
    "my-remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" } }
  }
}
```

  MCP tools marked read-only by the server run directly; all others ask first. Add `"autoApprove": ["tool_name"]` to a server to skip the question for specific tools. Only install skills and servers from sources you trust: published skill stores have contained malware.

### Your own tools (MCP server)

An MCP server is a small program that tells Aura which tools it has and runs them. You can write one in any language; the official SDKs ([TypeScript](https://github.com/modelcontextprotocol/typescript-sdk), [Python](https://github.com/modelcontextprotocol/python-sdk)) make it a few lines. Without any library, a Node server with one tool looks like this (`~/.aura/my-tools.mjs`):

```js
import readline from 'node:readline';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const tools = [{
  name: 'greet',
  description: 'Greets a person by name',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  annotations: { readOnlyHint: true } // read-only: Aura runs it without asking
}];
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'my-tools', version: '1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools } });
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `Hello ${m.params.arguments.name}!` }] } });
});
```

Register it in `~/.aura/mcp.json` with `"my-tools": { "command": "node", "args": ["/home/you/.aura/my-tools.mjs"] }`, then click *Neu laden* in Settings → *Erweiterungen*; the tool list appears there.

## Shortcuts (configurable)

| Shortcut | Action |
| --- | --- |
| Ctrl+Alt+Space | Open Aura (new chat each time; earlier chats via the clock button) |
| Ctrl+Alt+L | Gemini Live with screen sharing |
| Ctrl+Alt+D | Rambler: dictate into the focused text field; press again to finish |
| Ctrl+Alt+Esc | Emergency stop for a running agent task (only active while Aura works) |

### Linux notes

- On **Wayland**, global shortcuts go through the desktop portal (GNOME/KDE ask once). If one does not work, add a custom shortcut in your system settings that runs `aura --toggle`, `--live` or `--rambler` (with the AppImage, use the path to the `.AppImage` file).
- Rambler types via `xdotool` (X11) or `wtype` / `ydotool` (Wayland). Without them the text stays in the clipboard for Ctrl+V.
- On Wayland the glowing screen edge and the Live pointer are off: Wayland cannot keep a full-screen click-through window, and it would block clicks in the Aura window.
- Screen sharing on Wayland asks for permission through the system dialog. Aura keeps that share open for a few minutes so it does not ask for every screenshot.
- Read-aloud for local Live needs `speech-dispatcher` with a voice (e.g. `espeak-ng`).
- The tray icon needs AppIndicator support (on GNOME: the "AppIndicator" extension).

## Development

```bash
git clone https://github.com/fischersase/aura.git && cd aura
npm ci --ignore-scripts && node scripts/vendor.js && node node_modules/electron/install.js
(cd agent && uv sync)                            # Agent v2 (needs uv: https://docs.astral.sh/uv/)
npm start                                        # run
npm run check && npm test                        # app tests
(cd agent && uv run ruff check src tests spikes evals && uv run pytest -q)   # agent tests
npm run dist:linux                               # Linux packages (bundles Python, agent and browser server)
npm run dist:win                                 # Windows installer (in Git Bash)
(cd agent && uv run python -m evals.desktop.run --k 3)   # desktop evals (needs Ollama)
```

Every push runs the tests on Linux and Windows, CodeQL and a secret scan; `main` only accepts pull requests with all checks green. Every merge that changes the app builds a release ([docs/RELEASING.md](docs/RELEASING.md)). Architecture decisions are in [docs/adr](docs/adr/README.md).

## Privacy and secrets

Your API key and all keys under *Schlüssel* are stored only on your computer, encrypted with the OS keystore (Windows DPAPI, Linux GNOME keyring or KWallet) in the app's settings folder. Without a keyring on Linux, the *Schlüssel* page cannot store keys and says so; install gnome-keyring or KWallet. It is never part of this repository; every push is scanned with gitleaks. With Ollama, nothing leaves your computer except the one-time model downloads.

## Contributing, security, license

- Contributions are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md).
- Please report security problems privately, see [SECURITY.md](SECURITY.md).
- Aura is released under the [MIT License](LICENSE). Bundled third-party software is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). "Gemini" and "Google" are trademarks of Google LLC; Aura is an independent project and not affiliated with Google.
