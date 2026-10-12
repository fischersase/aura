# Aura threat model

Status: 2026-10-12, based on `main` at commit 3313787. Jira: AURA-30.
Owner: maintainers. Review: on every change to a trust boundary, and at least once per release cycle.

Related: [privacy.md](privacy.md), [SECURITY.md](../../SECURITY.md), [ADR 0003 (approvals in the harness)](../adr/0003-freigaben-in-der-huelle.md).

## 1. Scope and method

**In scope:** the Electron app ([src/](../../src)), the Python agent sidecar ([agent/src/aura_agent](../../agent/src/aura_agent)),
the legacy v1 agent ([src/agent](../../src/agent)), the local Zentrale web server ([src/web.js](../../src/web.js)),
the GNOME Shell extension ([gnome-extension](../../gnome-extension)), and the build/release chain
([.github/workflows](../../.github/workflows), [scripts/build-apt-repo.sh](../../scripts/build-apt-repo.sh)).

**Out of scope:** security of Ollama, Google Gemini, the OS, the browser engine itself and user-installed MCP servers
(treated as actors, not as components we harden).

**Method:**

1. Enumerate assets (section 2) and actors (section 3).
2. Draw trust boundaries (section 4) and apply **STRIDE** per boundary
   (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege).
3. Add LLM-specific threats mapped to the **OWASP Top 10 for LLM Applications 2025**:
   LLM01 Prompt Injection, LLM02 Sensitive Information Disclosure, LLM03 Supply Chain, LLM04 Data and Model Poisoning,
   LLM05 Improper Output Handling, LLM06 Excessive Agency, LLM07 System Prompt Leakage, LLM08 Vector and Embedding
   Weaknesses, LLM09 Misinformation, LLM10 Unbounded Consumption.
4. For each threat record existing mitigations (with code references), residual risk and open work (Jira keys).
5. Derive testable requirements (section 8).

**Core design assumption:** the model is not a security boundary. Any text the model reads may steer it. Therefore every
enforcement decision (tiers, path blocks, approvals, exfiltration checks) lives in deterministic code in the harness, not in
the system prompt.

## 2. Assets

| ID | Asset | Why it matters |
|---|---|---|
| A1 | **The user's machine** | The agent runs bash/PowerShell ([tools/shell.py](../../agent/src/aura_agent/tools/shell.py)), reads/writes/moves files ([tools/files.py](../../agent/src/aura_agent/tools/files.py)), controls apps via AT-SPI/UIA, keyboard and pointer ([tools/ui.py](../../agent/src/aura_agent/tools/ui.py), [tools/pointer.py](../../agent/src/aura_agent/tools/pointer.py)) and a Chrome instance via Playwright MCP ([tools/browser.py](../../agent/src/aura_agent/tools/browser.py)). Compromise of the agent's decisions equals code execution as the user. |
| A2 | **Credentials stored by Aura** | Gemini API key (`apiKeyEnc` in `settings.json`, Electron `safeStorage`, [src/store.js](../../src/store.js)); MCP secrets (`secrets.json`, `safeStorage`, mode 0600, [src/secrets.js](../../src/secrets.js)); resolved MCP env/headers passed to the agent. |
| A3 | **Credentials on the machine** | OS keyrings (`~/.local/share/keyrings`, Windows Credential Manager/DPAPI), browser profiles (cookies, `Login Data`), `~/.ssh`, `~/.gnupg`, password stores, cloud CLI tokens (`~/.aws`, `~/.config/gcloud`, `~/.azure`, `~/.kube`, `~/.docker`, `gh` hosts.yml), `.netrc`, `.npmrc`, `.env` files. |
| A4 | **User data** | Chats (`userData/chats`), agent sessions/memory DBs, `~/.aura/memory/MEMORY.md`, audit log, screenshots, microphone audio, screen sharing frames, user profile text. See [privacy.md](privacy.md). |
| A5 | **Aura's own control files** | `~/.aura/policy.toml` (allow rules), `~/.aura/hooks.json` (commands run on every tool call), `~/.aura/mcp.json`, `~/.aura/AGENTS.md`, `~/.aura/skills/`. Writing them changes what the agent may do. |
| A6 | **Release channel integrity** | Installers (`Aura-Setup.exe`, AppImage, `.deb`) on GitHub Releases, `SHA256SUMS`, build provenance attestations, the signed apt repository on GitHub Pages, the signing key secret `APT_SIGNING_KEY`, and the public keyring [packaging/linux/aura-archive-keyring.asc](../../packaging/linux/aura-archive-keyring.asc). |
| A7 | **Availability and cost** | The user's Gemini budget (`monthlyBudgetUsd`, [src/usage.js](../../src/usage.js)), local GPU/CPU. |

## 3. Actors and attackers

| ID | Actor | Capability | Primary targets |
|---|---|---|---|
| X1 | **Injected content**: web pages, files, program UIs, command output, screenshots read by the agent | Controls text the model reads (indirect prompt injection, LLM01) | A1, A3, A4 via tool calls |
| X2 | **Hostile or compromised MCP server** | Returns arbitrary tool results and tool descriptions/annotations; runs as a local process with the user's rights (stdio) or as a remote service (HTTP) | A1, A2 (its own secrets), A4 |
| X3 | **Malicious website in the user's normal browser** | Can send requests to `127.0.0.1` (CSRF, DNS rebinding) | Zentrale web server → A2, A5 |
| X4 | **Other local process in the same user session** | Can call session D-Bus (`org.aura.Bridge`), read user files, ptrace, write `~/.aura` | A1–A5 (mostly out of scope, see 7) |
| X5 | **Compromised renderer** (XSS in panel/Zentrale/settings, malicious navigation) | Calls the channels its window may use ([src/security.js](../../src/security.js) `IPC_ACCESS`) | A2, A5, A1 via approvals |
| X6 | **Supply-chain attacker** | npm, PyPI/uv, GitHub Actions, Playwright MCP from npm, Whisper model on Hugging Face, Ollama model registry, release assets | A6 → A1 on every install |
| X7 | **Curious or compromised cloud provider** | Sees everything sent when provider = Gemini | A4 |
| X8 | **The model itself** (hallucination, misalignment, jailbreak by the user's own text) | Proposes wrong or destructive tool calls | A1, A4 |

## 4. Trust boundaries

```
 ┌──────────── Browser (default) ───────────┐          ┌──── Cloud ────┐
 │ X3 malicious site    Zentrale tab (B5)   │          │ Gemini API    │◀─ B3 (provider = gemini)
 └──────────┬───────────────────┬───────────┘          └──────▲────────┘
            │ HTTP 127.0.0.1    │                             │ HTTPS / WSS (Live, dictation, chat)
 ┌──────────▼───────────────────▼────────────────────────────────────────┐
 │ Electron main (src/main.js, store.js, secrets.js, web.js)              │
 │   ▲ B1 IPC (per-window preloads / contextBridge)                       │
 │ Renderers: panel, settings, setup, Zentrale, overlay, stt, rambler     │
 └──────────┬─────────────────────────────────────────────────────────────┘
            │ B2 stdio JSON-RPC (src/agent2/bridge.js ↔ aura_agent/rpc)
 ┌──────────▼─────────────────────────────────────────────────────────────┐
 │ Python agent (ADK) ── GuardPlugin ── tools ──▶ shell, files, apps, UI  │
 │      │ B3 model (Ollama localhost / Gemini)                            │
 │      │ B4 untrusted content: web (Playwright MCP), files, UI text,     │
 │      │    command output, user MCP servers, screenshots                │
 └──────┴─────────────────────────────────────────────────────────────────┘
 B6 build/release: GitHub Actions → Releases / Pages (apt) → user install
 B7 session D-Bus: GNOME extension org.aura.Bridge ↔ any session process
```

### B1 Renderer ↔ main (IPC)

Code: [src/preload*.js](../../src/preload.js), [src/security.js](../../src/security.js), [src/main.js](../../src/main.js), [src/zentrale.js](../../src/zentrale.js).

| STRIDE | Threat | Existing mitigations | Residual risk | Open work |
|---|---|---|---|---|
| S | A non-Aura page loaded in an Aura window (navigation, `window.open`) gets the `window.api` bridge | Renderers load local files only; `contextIsolation: true`, `nodeIntegration: false` in `BrowserWindow` options ([main.js](../../src/main.js) ~L110, L186, L214, L915) | Navigation guard (AURA-14) and per-channel sender validation (AURA-18) in place | — |
| T | Compromised renderer rewrites policy, MCP servers, skills, `AGENTS.md`, hooks via `z:*` handlers | Handlers only exist in main; `z:*` accepts only the Zentrale window's main frame (`guardIpc`), and only its preload exposes `z` | An XSS inside the Zentrale itself still reaches `z:*` (mitigated by CSP and no remote content) | AURA-18 (done) |
| R | Approvals clicked by a forged renderer cannot be told apart from the user | Audit log records every approval ([harness/audit.py](../../agent/src/aura_agent/harness/audit.py)) | Origin of the click not recorded | AURA-18 |
| I | Renderer obtains secrets | `publicSettings()` strips `apiKeyEnc` ([store.js](../../src/store.js)); `secrets.list()` returns only the last 4 chars ([secrets.js](../../src/secrets.js)) | Fixed: Gemini Live runs through a main-process relay ([live-relay.js](../../src/live-relay.js)), the key travels only in the `x-goog-api-key` header; the panel CSP has `connect-src 'none'` | AURA-15 (done) |
| D | Renderer floods IPC (e.g. `ollama:pull`, `chat:send`) | Budget check `budgetError()` for Gemini | Low impact, local | — |
| E | Renderer gets microphone / screen capture silently | `setDisplayMediaRequestHandler` picks the panel's display | `setPermissionRequestHandler` grants `media` and `display-capture` to **every** webContents, without origin check ([main.js](../../src/main.js) ~L1122) | AURA-14 (PR #4) |
| E | Electron runtime flags (`RunAsNode`, `NODE_OPTIONS`, inspect, ASAR integrity) let a local attacker or child process run code as Aura | — | Fuses not set; note: Playwright MCP is started with `ELECTRON_RUN_AS_NODE=1` and needs a separate path | AURA-53 |

### B2 Main ↔ agent (stdio JSON-RPC)

Code: [src/agent2/bridge.js](../../src/agent2/bridge.js), [src/agent2/rpc.js](../../src/agent2/rpc.js), [agent/src/aura_agent/rpc/peer.py](../../agent/src/aura_agent/rpc/peer.py), [runtime/server.py](../../agent/src/aura_agent/runtime/server.py).

| STRIDE | Threat | Existing mitigations | Residual risk | Open work |
|---|---|---|---|---|
| S | Another process impersonates the agent or the host | Private stdio pipes of a child process; no socket, no port | Same-user attacker can replace the bundled Python (out of scope, see 7) | — |
| T | Malicious Python code injected via `PYTHONPATH` / user site-packages | Spawned with `python -I`, `PYTHONNOUSERSITE=1` ([bridge.js](../../src/agent2/bridge.js) L309–311) | `AURA_AGENT_PYTHON` is ignored in packaged builds (AURA-62) | — |
| R | Agent actions not attributable | Hash-chained audit log per month ([audit.py](../../agent/src/aura_agent/harness/audit.py)), `verify()` detects edits/deletions | Chain is not anchored externally; a same-user attacker can rewrite the whole file | — |
| I | Secrets leak via `initialize` params, logs or the child's environment | Gemini key passed in `initialize` (not argv); `AgentSettings.gemini_api_key` has `repr=False`; audit `redact()` masks secret-named keys | Agent **inherits the full Electron environment** (`...process.env`), and `run_command` passes `os.environ` to every shell ([tools/shell.py](../../agent/src/aura_agent/tools/shell.py)); `env`/`printenv` are T0. A `GEMINI_API_KEY` or cloud tokens in the environment are readable by the model. Secrets inside command strings are logged (AURA-17, PR #5) | AURA-17; scrub env (NFR-SEC-009) |
| D | Agent hangs; cancel ignored | `task.cancel` with 2 s timeout, then `SIGKILL` / `taskkill /T` ([bridge.js](../../src/agent2/bridge.js) `kill()`), per-command process groups ([platform/proc.py](../../agent/src/aura_agent/platform/proc.py)), `max_llm_calls` = 60, loop guard (5 identical calls stop) | — | — |
| E | Agent requests `host.input`/`host.screenshot` beyond the task | Approval requests without a live sender window are denied ([main.js](../../src/main.js) host `approve`) | `host.screenshot` stays T0; it shows as a step in the open panel, otherwise a notification (at most once a minute, AURA-62) | AURA-48 (screen consent indicator) |

### B3 Agent ↔ model

Code: [runtime/server.py](../../agent/src/aura_agent/runtime/server.py) `make_model`, [models/ollama_llm.py](../../agent/src/aura_agent/models/ollama_llm.py), [src/gemini.js](../../src/gemini.js), [src/ollama.js](../../src/ollama.js).

| STRIDE / OWASP | Threat | Existing mitigations | Residual risk | Open work |
|---|---|---|---|---|
| S | Ollama URL points to a hostile host (user-configurable `ollamaUrl`) | Default `http://127.0.0.1:11434` | Non-local URL is accepted without warning; traffic is plain HTTP | Warn on non-loopback Ollama URL (AURA-48) |
| I / LLM02 | Prompt, tool results, screenshots, memory and profile go to Gemini | Local-first: Ollama is the agent default; Gemini only when the user selects it with their own key | Everything in the context leaves the machine in Gemini mode, see [privacy.md](privacy.md) | AURA-48 |
| T / LLM05 | Model output used unsafely (HTML in renderer, shell strings) | Tool calls are structured and classified before execution; Zentrale served with strict CSP | Panel/Zentrale rendering of model Markdown not covered by an automated XSS test | Add XSS regression test (proposed, with AURA-18) |
| E / LLM06 | Model proposes destructive action (X8) | Tier model and guard (see B4) | Human approval fatigue | — |
| D / LLM10 | Unbounded cost / loops | `max_llm_calls`, loop guard ([guard.py](../../agent/src/aura_agent/harness/guard.py) `REPEAT_STOP`), monthly budget ([usage.js](../../src/usage.js)), context manager ([harness/context_manager.py](../../agent/src/aura_agent/harness/context_manager.py)) | Budget is an estimate; Google spend cap recommended | — |
| LLM07 | System prompt leakage | Prompt contains no secrets by design (profile and `MEMORY.md` are user data, shown to the user anyway) | — | — |

### B4 Agent ↔ untrusted content (tools)

This is the main boundary. Code: [harness/guard.py](../../agent/src/aura_agent/harness/guard.py), [harness/tiers.py](../../agent/src/aura_agent/harness/tiers.py), [policy/](../../agent/src/aura_agent/policy), [tools/](../../agent/src/aura_agent/tools), [extensions/mcp.py](../../agent/src/aura_agent/extensions/mcp.py), [tools/browser.py](../../agent/src/aura_agent/tools/browser.py), [memory/store.py](../../agent/src/aura_agent/memory/store.py).

**Enforcement chain per tool call** (`GuardPlugin.before_tool_callback`): unknown tool → error; loop guard; required
arguments; tier classification (`ToolMeta.classify`) → **T3 is blocked** before anything else; user policy
(`policy.toml`, deny > ask > allow, cannot unlock T3, [policy/engine.py](../../agent/src/aura_agent/policy/engine.py));
plan mode for bulk requests; user hooks (`~/.aura/hooks.json`, fail-closed, [harness/hooks.py](../../agent/src/aura_agent/harness/hooks.py));
**T2 asks the user** via `host.approve` (timeout → deny); audit. Tools without metadata are `UNKNOWN = T2`
([tiers.py](../../agent/src/aura_agent/harness/tiers.py)). Specialists (`AgentTool`) inherit the plugin.

| STRIDE / OWASP | Threat | Existing mitigations | Residual risk | Open work |
|---|---|---|---|---|
| E / LLM01, LLM06 | **Indirect prompt injection** makes the agent run a consequential command | Shell classifier: allow-list of read-only commands and subcommands, control operators (`; & \` $( > <(`) → T2, `sudo/pkexec/su` → T2, everything unknown → T2 ([policy/shell_classifier.py](../../agent/src/aura_agent/policy/shell_classifier.py)); PowerShell classifier strips strings, rejects `.NET`/method calls/script blocks ([policy/powershell_classifier.py](../../agent/src/aura_agent/policy/powershell_classifier.py)); results of `read_file`, `run_command`, `ui_snapshot`, `screenshot`, `recall`, `browser_*`, `mcp_*` are marked untrusted (`TAINT_TOOLS`, `UNTRUSTED_NOTE`) | **High: read-only allow-list contains programs that execute arbitrary code**: `env rm -rf …`, `awk 'BEGIN{system(…)}'`, `find` variants, `git` aliases/`-c`, `python3`/`node` flags; classified T0 and run without asking | **AURA-13** (high, fix in PR #3) |
| I / LLM02 | Agent reads credentials (A3) and puts them in the model context | `FORBIDDEN_PATHS` → T3 for all file tools incl. symlink resolution ([policy/paths.py](../../agent/src/aura_agent/policy/paths.py)); shell `FORBIDDEN` patterns (`.ssh`, `.gnupg`, keyrings, browser cookies, `secret-tool`, `/etc/shadow`, Aura secrets); PowerShell equivalents (`Get-Credential`, `cmdkey`, DPAPI, SAM) | **Gaps**: `~/.config/gcloud`, `~/.azure`, `~/.config/gh/hosts.yml`, `.npmrc`, `.pypirc`, `.env` files, Electron `userData/settings.json`; shell patterns are string-based and bypassable (globs, variables, `cd` + relative paths) | **AURA-16** |
| I / LLM02 | **Exfiltration via tools** after injection (URL with data, form submit, MCP call, `curl`) | `policy/exfil.py`: when a task is both tainted and holds local data, `browser_navigate` to URLs with query or long path → T2; consequential browser clicks (send, buy, post …) → T2; `file:` URLs → T2; `curl`/`wget` not read-only → T2; browser JS evaluation and file upload not enabled ([tools/browser.py](../../agent/src/aura_agent/tools/browser.py)) | Exfil check only covers browser navigation; low-bandwidth channels (typed text into a form field, DNS, image URLs inside visited pages, T1 MCP tools) remain | Extend taint check to `browser_type`/`fill_form` and T1 MCP tools (proposed) |
| T / LLM04 | **Memory poisoning**: injected content persists instructions in `MEMORY.md` | `remember` is T2 once the task is tainted ([tools/memory.py](../../agent/src/aura_agent/tools/memory.py)); secrets rejected by regex ([memory/store.py](../../agent/src/aura_agent/memory/store.py)); file is user-readable and editable in the Zentrale; overwriting existing files is T2 | Memory content is placed in every system prompt; a poisoned entry approved once persists | AURA-48 (memory review UI) |
| E / LLM06 | **Self-modification of Aura's control files (A5)** | Overwriting an existing file is T2 | **Creating** a file that does not yet exist is T1 (runs without asking) — e.g. a new `~/.aura/hooks.json` (commands run on every tool call), `~/.aura/policy.toml` (allow rules), `~/.config/autostart/*.desktop`, `~/.bashrc.d/*`. `~/.aura/*` (other than `secrets`) is not in `FORBIDDEN_PATHS` | New finding, to be filed: treat `~/.aura/{policy.toml,hooks.json,mcp.json,AGENTS.md,skills}`, autostart and shell-rc locations as T2/T3 for agent writes |
| S / LLM01 | Fake approval text inside content ("the user already approved") | Approval decisions only come from `host.approve` (UI), never from model text; plan-mode confirmation only from `ask_user` result | User may approve a misleading label | Show `effect` (exact command/diff) on the card — implemented via `ToolMeta.effect` |
| E / LLM03, LLM06 | **Hostile MCP server (X2)** lies about `readOnlyHint` to get T0 | Unknown MCP tools are T2; `autoApprove` only by user config; results are tainted; MCP specialist instruction treats results as data | `readOnlyHint` counts only for local stdio servers, which already run as the user; remote (url) servers' hints are ignored, their tools are T2 unless in `autoApprove` (AURA-62) | — |
| I | MCP server receives env with all Aura secrets | Only `${secret:NAME}` references the user wrote are resolved ([secrets.js](../../src/secrets.js) `resolveServerConfig`) | stdio servers get `{**os.environ, **cfg.env}` — whole agent environment | NFR-SEC-009 |
| R | User or attacker denies an action happened | Hash-chained audit with `tool_start`, `approval`, `blocked`, `tainted`, `rule_added` ([audit.py](../../agent/src/aura_agent/harness/audit.py)) | Values are clipped to 500 chars; secrets in command strings are logged verbatim | AURA-17 (PR #5) |
| D | Command runs forever or fork-bombs | Timeout 5–900 s, process-group kill, fork-bomb pattern is T3 | — | — |
| E | User hooks/policy grant too much | Policy cannot unlock T3; hooks can only deny/ask, not allow; failing hook denies | "Always allow" rules are exact-match regex but persist forever | — |

### B5 Zentrale web server ↔ browser

Code: [src/web.js](../../src/web.js), [src/renderer/web-shim.js](../../src/renderer/web-shim.js).

| STRIDE | Threat | Existing mitigations | Residual risk | Open work |
|---|---|---|---|---|
| S | Malicious site or other LAN host calls the API | Binds `127.0.0.1` only; 256-bit random token per app start, passed in URL fragment (never sent to server logs/Referer), compared with `timingSafeEqual`; `resetToken()` logs out all tabs | Token lives in the tab's JS memory/history; any local process can read it from browser history files | — |
| T | CSRF / DNS rebinding | `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (421 otherwise); foreign `Origin` → 403; POST requires `Content-Type: application/json` (forces CORS preflight, which is never answered); body ≤ 2 MiB | — | — |
| I | Clickjacking, script injection, leakage | CSP `default-src 'none'; script-src 'self'; frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, COOP/CORP, `no-store` | A token holder can read Aura's state; changes to MCP servers, rules, skills, AGENTS.md and secrets need a confirmation in the desktop app, `openPath`/`openWeb` are not served ([src/web-access.js](../../src/web-access.js)) | AURA-63 (done) |
| D | Port squatting by another local process | Tries ports 47800–47805, then random | Same-user attacker could pre-bind and phish the token (out of scope) | — |
| E | API runs arbitrary functions | Explicit `API` table, `hasOwnProperty` check; web allow-list with deny by default for new functions | — | — |

### B6 Build/release ↔ user

Code: [.github/workflows](../../.github/workflows), [scripts/build-apt-repo.sh](../../scripts/build-apt-repo.sh), [docs/RELEASING.md](../RELEASING.md).

| STRIDE / OWASP | Threat | Existing mitigations | Residual risk | Open work |
|---|---|---|---|---|
| T / LLM03 | Compromised dependency (npm, PyPI, Actions) | Lockfiles (`package-lock.json`, `agent/uv.lock`); `npm ci --ignore-scripts`; all actions pinned to full commit SHAs; `permissions: contents: read` by default, write only per job; `persist-credentials: false`; CodeQL ([codeql.yml](../../.github/workflows/codeql.yml)); gitleaks ([secret-scan.yml](../../.github/workflows/secret-scan.yml)) | Playwright MCP is fetched by version (`@playwright/mcp@0.0.80`) via `npx` in development; Whisper ONNX model downloaded at runtime from Hugging Face without hash pinning | Pin Whisper model revision + hash (lower finding) |
| T | Tampered installer | `actions/attest-build-provenance` on release assets; `SHA256SUMS` uploaded | **v0.11.0 was published without attestation**; `SHA256SUMS` upload uses `--clobber`; assets can be overwritten or a release published incomplete | **AURA-19**, **AURA-20** |
| T / S | Tampered or replayed apt repository | `InRelease`/`Release.gpg` signed; script checks the signing key's fingerprint is in the shipped keyring; Pages deploy via OIDC | Key is a long-lived repo secret usable by any workflow on `main`; no `Valid-Until` (freeze/replay attacks); input `.deb` is downloaded from the latest release without verifying its attestation/hash | **AURA-22** |
| I | Secret leakage in CI | gitleaks; secrets only exposed to the signing step via `env` | — | — |
| R | Unknown provenance of a binary | Attestations (`gh attestation verify`) | Only for releases after AURA-19 fix | AURA-19 |
| E | Workflow injection via PR titles/branch names | No untrusted expressions interpolated in `run:` blocks (CodeQL actions queries) | — | — |

### B7 Session D-Bus (GNOME extension)

Code: [gnome-extension/aura-bridge@aura/extension.js](../../gnome-extension/aura-bridge%40aura/extension.js).

| STRIDE | Threat | Existing mitigations | Residual risk | Open work |
|---|---|---|---|---|
| S / E | Any process on the session bus calls `org.aura.Bridge` (`ListWindows`, `Activate`, `Minimize`, `Maximize`, `Close`) | Narrow interface; no input injection or screen capture methods | No caller authentication; leaks window titles; closing windows can lose work. Under the same-user assumption (section 7) any such process could already do worse | Low: check caller PID/unique name against the agent (proposed) |

## 5. Known findings (security review 2026-10-12)

| Jira | Severity | Finding | Boundary | Status |
|---|---|---|---|---|
| AURA-13 | High | Shell classifier read-only bypass: `env`, `awk`, and similar allow-listed programs execute arbitrary commands at T0 | B4 | Fix in PR #3 |
| AURA-14 | Medium | `media` and `display-capture` permissions granted to every window/origin; no navigation or `window.open` guard | B1 | PR #4 |
| AURA-15 | Medium | Gemini API key exposed to the renderer and placed in the Live WebSocket URL query string | B1, B3 | Fixed (0.11.1) |
| AURA-16 | Medium | Protected-path list gaps: gcloud, azure, `.env`, `.npmrc`, `gh` | B4 | Open |
| AURA-17 | Medium | Secrets inside logged command values (audit/agent log) | B2, B4 | PR #5 |
| AURA-18 | Medium | IPC handlers without sender validation | B1, B5 | Fixed (0.11.1) |
| AURA-19 | Medium | Release v0.11.0 published without build provenance attestation | B6 | Open |
| AURA-20 | Medium | Release assets can be overwritten (`--clobber`) / release published incomplete | B6 | Open |
| AURA-22 | Medium | apt signing key scope, missing `Valid-Until`, unverified input `.deb` | B6 | Open |
| AURA-53 | Low | Electron fuses not set | B1 | Open |
| — | Low | GNOME bridge D-Bus without caller authentication | B7 | To be filed |
| — | Low | Whisper model downloaded from Hugging Face without pinned revision/hash ([renderer/stt.html](../../src/renderer/stt.html) CSP allows `huggingface.co`) | B6 | To be filed |
| — | Medium | Agent can create new control/autostart files at T1 (section B4 "self-modification") | B4 | To be filed (found while writing this model) |
| — | Medium | Agent environment and all shell children inherit the full Electron environment | B2, B4 | To be filed (NFR-SEC-009) |

## 6. LLM-specific threat summary (OWASP LLM Top 10 2025)

| OWASP | Applies | Primary controls | Gaps |
|---|---|---|---|
| LLM01 Prompt Injection | Yes, central | Tiers enforced in code, taint marking, exfil check, T3 block | AURA-13, self-modification at T1 |
| LLM02 Sensitive Information Disclosure | Yes | Path blocks, secret redaction in audit/memory, no secrets in prompts | AURA-15, AURA-16, AURA-17, env inheritance |
| LLM03 Supply Chain | Yes | Pinned actions, lockfiles, attestations, signed apt repo | AURA-19, AURA-20, AURA-22, Whisper download |
| LLM04 Data and Model Poisoning | Memory, skills, AGENTS.md | `remember` T2 when tainted; overwrite T2 | New control files creatable at T1 |
| LLM05 Improper Output Handling | Tool args, renderer | Structured tool calls, classifiers, CSP | — |
| LLM06 Excessive Agency | Yes, central | T0–T3, approvals, plan mode, policy, hooks, emergency stop (`hotkeyStop`) | Approval fatigue; "allow for task" |
| LLM07 System Prompt Leakage | Low | No secrets in prompts | — |
| LLM08 Vector/Embedding Weaknesses | Low | SQLite full-text memory, local only | — |
| LLM09 Misinformation | Yes | Verification of state-changing actions (`verified`), honesty nudges in [runtime/controller.py](../../agent/src/aura_agent/runtime/controller.py) | — |
| LLM10 Unbounded Consumption | Yes | `max_llm_calls`, loop guard, budget, timeouts | Budget is an estimate |

## 7. Assumptions and residual risks

1. **Same-user local attacker (X4) is out of scope for most controls.** A process running as the user can already read
   `~/.ssh`, edit `~/.aura/policy.toml`, replace the bundled Python or Electron app in user-writable locations, and read
   the Zentrale token from browser history. Aura does not try to defend against it, except where cheap (file modes 0600,
   `python -I`, Electron fuses).
2. **The model can always be manipulated.** No control relies on the model following instructions. Prompt-level notes
   (`UNTRUSTED_NOTE`, specialist instructions) reduce the success rate but are not counted as mitigations.
3. **The human approval is the last line of defence for T2.** Its quality depends on the label/effect shown; users
   may click "allow for this task" or "always". Residual risk accepted; mitigated by exact-match "always" rules and audit.
4. **Classifiers are deny-by-default but allow-lists can be wrong** (AURA-13). Each allow-listed program must be reviewed
   for code execution capabilities; new entries require a test.
5. **OS keyring quality on Linux varies.** If `safeStorage` falls back to `basic_text`, stored secrets are effectively
   obfuscated only; [secrets.js](../../src/secrets.js) reports this as `weak` and refuses to store MCP secrets if no
   encryption is available. The Gemini key path in [store.js](../../src/store.js) still stores base64 when encryption is
   unavailable (accepted, documented; see NFR-SEC-006).
6. **Cloud provider (X7)** is trusted under Google's terms once the user chooses Gemini; see [privacy.md](privacy.md).
7. **User-installed MCP servers and skills** are trusted code chosen by the user; Aura limits what the model may do with
   them, not what the server process itself can do.

## 8. Derived security requirements

| ID | Requirement | Rationale | Verification |
|---|---|---|---|
| NFR-SEC-001 | Every tool call, including calls inside specialist agents and MCP toolsets, passes `GuardPlugin.before_tool_callback`. Tools without Aura metadata are classified T2. | Single enforcement point; new tools fail safe | Canary test that a specialist tool call is audited; unit test `meta_of(unknown) == T2` |
| NFR-SEC-002 | T3 actions are never executed; no policy rule, hook, approval or "allow for task" can unlock them. | Credentials and irreversible destruction must not depend on user attention | Unit tests on `PolicyEngine.evaluate` and guard with T3 + allow rule + `allow_all` |
| NFR-SEC-003 | T2 actions execute only after an explicit approval from the UI; a missing, failed or timed-out approval is a denial. | Model text cannot approve | Test `host.approve` raising/timeout → `DENIED`; e2e approval test |
| NFR-SEC-004 | A command classified T0 or T1 by the shell or PowerShell classifier cannot execute an arbitrary sub-command, write a file, or reach the network beyond reading. | Read-only allow-lists are the largest bypass surface (AURA-13) | Corpus of bypass payloads (env, awk, find -exec, git -c, python -c, node -e, xargs, sed `e`, …) must classify ≥ T2; reviewed per new allow-list entry |
| NFR-SEC-005 | All file tools and the shell classifiers block (T3) access to credential stores listed in section 2 (A3), including cloud CLI configs, `.env`, `.npmrc`, `.pypirc`, `gh` tokens and Aura's `userData` secrets, regardless of path spelling or symlinks. | Prevent secret disclosure to model/provider | Parametrised tests over path variants (`~`, relative, symlink, case on Windows) |
| NFR-SEC-006 | No credential is ever passed to a renderer process, placed in a URL, command line argument, or log line. | Renderers are the XSS surface; URLs and argv leak via logs and process lists | Grep/test that `live:config`, `settings:get` and Zentrale API responses contain no key; `test/live-relay.test.js` (AURA-15) |
| NFR-SEC-007 | Secrets at rest are encrypted with the OS keyring via Electron `safeStorage`; if only a weak backend is available the user is warned, and MCP secrets are not stored without encryption. Files holding secrets have mode 0600. | Protect A2 against casual disclosure and backups | Unit tests for `protection()`; file mode check |
| NFR-SEC-008 | Audit and agent logs redact secret-named fields and secret-looking substrings inside values (tokens, `Authorization:`, `-p…`, URLs with credentials). | Logs are long-lived (AURA-17) | Unit tests on `redact()` with command strings containing tokens |
| NFR-SEC-009 | Child processes of the agent (shell commands, hooks, MCP stdio servers, browser) do not inherit secret-looking environment variables (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `GEMINI_API_KEY`, cloud credentials), except values the user explicitly mapped for that MCP server. | Prevent `printenv` disclosure and leakage to third-party servers | Test: spawn `run_command("printenv")` with a dummy secret in the parent env; assert absent |
| NFR-SEC-010 | Results of tools that return external content are marked untrusted, and a task that read untrusted content and local data must ask (T2) before any outbound channel that can carry data (navigation with parameters, form input, consequential clicks, network commands, non-read-only MCP tools). | Breaks the injection → exfiltration chain | Unit tests on `url_tier`, browser tiers and taint propagation |
| NFR-SEC-011 | The agent cannot create or modify Aura's control files (`~/.aura/policy.toml`, `hooks.json`, `mcp.json`, `AGENTS.md`, `skills/`) or OS autostart/shell-startup locations without an approval (at least T2). | Prevents persistent self-escalation after injection | Tests on `write_file`/`move` tier for these paths when the file does not exist |
| NFR-SEC-012 | Writing to long-term memory after the task read untrusted content requires approval; memory entries containing secrets are rejected. | Memory poisoning (LLM04) | Existing tests for `_remember_tier` and `SECRET` regex |
| NFR-SEC-013 | All `BrowserWindow`s use `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and block navigation and `window.open` to anything outside the app's own files; external links open in the default browser only for `https:`. | Limit XSS impact (AURA-14) | Test that iterates all windows' `webPreferences`; navigation test |
| NFR-SEC-014 | Every IPC handler validates that the sender is one of Aura's own windows (expected URL/frame) before acting; privileged `z:*` handlers are limited to the Zentrale window. | Compromised renderer containment (AURA-18) | Unit test calling handlers with a foreign `senderFrame` |
| NFR-SEC-015 | Microphone and screen capture permissions are granted only to the windows that need them (panel, stt, rambler) and only while a user-started feature is active. | Least privilege for sensors (AURA-14) | Permission handler test with foreign webContents |
| NFR-SEC-016 | The Zentrale web server listens only on loopback, requires a per-start random token for every API call, validates `Host` and `Origin`, requires JSON content type and sends the CSP and anti-framing headers. | CSRF/DNS rebinding protection | Existing web.js tests (wrong Host → 421, foreign Origin → 403, no token → 401) |
| NFR-SEC-017 | The agent sidecar runs in isolated mode (`python -I`, no user site-packages) and packaged builds ignore developer overrides (`AURA_AGENT_PYTHON`, test script env). | Code injection into the agent | Bridge test in packaged mode |
| NFR-SEC-018 | The audit log is append-only and hash-chained; `AuditLog.verify` detects modification or deletion of entries. | Repudiation, forensics | Existing audit tests |
| NFR-SEC-019 | The emergency stop terminates the task, all its child processes (process group / tree) within 2 s, or kills the agent process. | Recover from runaway actions | Cancel e2e test with a long-running command |
| NFR-SEC-020 | Every release asset has a build provenance attestation and an entry in `SHA256SUMS`; published assets are never overwritten; a release is published only when all assets are present. | Release integrity (AURA-19, AURA-20) | Release workflow check step: `gh attestation verify` for each asset before publish |
| NFR-SEC-021 | The apt repository is signed with a dedicated key available only to the signing job/environment; `Release` contains `Valid-Until`; the input `.deb` is verified (attestation + hash) before signing. | Prevent replay/freeze and signing of tampered input (AURA-22) | Inspect `Release`; workflow verification step |
| NFR-SEC-022 | All GitHub Actions are pinned to full commit SHAs, workflows default to `contents: read`, and dependencies are installed from lockfiles without install scripts. | Supply chain (LLM03) | CI lint (e.g. zizmor/actionlint) and review |
| NFR-SEC-023 | Electron fuses are set: `RunAsNode` off (with a supported path for Playwright MCP), `EnableNodeOptionsEnvironmentVariable` off, `EnableNodeCliInspectArguments` off, ASAR integrity on, `OnlyLoadAppFromAsar` on. | Prevent abuse of the signed binary (AURA-53) | `npx @electron/fuses read` in CI |
| NFR-SEC-024 | Runtime-downloaded models (Whisper, Ollama models) come from a pinned revision and are integrity-checked where the source supports it. | Supply chain | Review of model loader config |
