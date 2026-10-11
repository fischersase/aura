# Aura

*Formerly "Gemini Overlay".* A hotkey assistant for Windows and Linux.

Gemini the way it works on a Googlebook: a glowing screen edge, a small rounded Gemini window in the corner, Gemini Live that sees your screen and points where to click, and Rambler dictation in any text field.

Aura can also act on your PC: open programs, folders and websites, find and read documents, and run terminal commands. Anything that changes something waits for your OK.

Runs with Google Gemini (API key) or fully local with open models through [Ollama](https://ollama.com) (Gemma 4, Qwen, DeepSeek, …).

## Install

**Windows:** download **`Aura.exe`** from the [latest release](https://github.com/fischersase/aura/releases/latest) and run it. SmartScreen may warn because the file is unsigned: click **More info → Run anyway**.

**Linux (x64):** download **`Aura-x86_64.AppImage`** (any distro, `chmod +x` and run) or **`aura_amd64.deb`** for Debian/Ubuntu. Double-clicking the .deb may just open an archive viewer; install it from a terminal instead: `sudo apt install ~/Downloads/aura_amd64.deb`, then start "Aura" from the app menu. Upgrading from "Gemini Overlay"? Remove the old package with `sudo apt remove windows-gemini`; your settings move over automatically.

The setup assistant opens on first start and lets you pick Gemini or local models. The app lives in the system tray (star icon); right-click it for settings, or start "Aura" again.

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

## Agent: Aura acts on your PC

Ask in the chat, e.g. "open my downloads folder", "find the invoice from March", "how much disk space is left?", "start Spotify", "write these notes to ~/notes.txt".

| Tool | What it does | Asks first? |
| --- | --- | --- |
| Open | folders, files, websites, installed programs by name (Start menu / app menu) | only for scripts and `.exe` files |
| Find files | by name or pattern, optionally text files containing a word | no |
| List folder, read file | text files and PDFs (PDF needs `pdftotext`) | no |
| Run command | PowerShell on Windows, bash on Linux | yes, unless it only reads (`ls`, `df`, `Get-ChildItem` …) |
| Write file | create, replace or append | yes |
| Screenshot | lets the model look at your screen | no |
| Click, type, press keys | operate programs with mouse and keyboard, checking a fresh screenshot after each step | yes (or *Alle erlauben* for the rest of the task) |

- Approve or decline right in the Aura window; declining is passed back to the model. *Alle erlauben* approves the remaining steps of the current task only.
- Mouse and keyboard on Linux need `xdotool` (X11) or `ydotool`/`wtype` (Wayland).
- **Emergency stop:** the stop button, or Ctrl+Alt+Esc while Aura is working, cancels the task and ends commands it started.
- Every action is logged: tray menu → *Aktionsprotokoll öffnen* (`agent-log.jsonl` in the settings folder).
- Turn it off under Settings → *Agent*.
- Local models get a 16k context by default (Settings → *Lokale Modelle*; choose 32k on a 24 GB GPU).
- Local models need tool support: `qwen3.6:27b` or `gemma4:31b` on a 24 GB GPU, smaller `gemma4`/`qwen3.5` models also work but make more mistakes. DeepSeek R1 cannot use tools.

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

## Build from source

Requires [Node.js](https://nodejs.org) 22+.

```
npm ci --ignore-scripts && node scripts/vendor.js && node node_modules/electron/install.js
npm start                                        # run
npx electron-builder --win portable             # Windows .exe
npx electron-builder --linux AppImage deb        # Linux packages
```

## Privacy and secrets

Your API key is stored only on your computer, encrypted with the OS keystore (Windows DPAPI, Linux keyring) in the app's settings folder. It is never part of this repository; every push is scanned with gitleaks. With Ollama, nothing leaves your computer except the one-time model downloads.
