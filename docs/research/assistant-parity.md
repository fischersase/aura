# Research: Meta Muse and Google's Gemini agent, compared with Aura (as of 2026-10-13)

Legend: **[P]** primary source (vendor blog, docs or help page) · **[S]** secondary source (press or analyst) · **[U]** uncertain or unverified (single third-party source, inference, or sources disagree).
I read Aura's current state from `docs/specs/personal-agent.md` and the code: `agent/src/aura_agent/tools/context.py`, `memory/store.py` and `tools/browser.py`.

---

## 1. Meta "Muse"

### 1.1 What it is

The name is not ambiguous. "Muse" is **Meta's consumer personal AI agent** ("Introducing Muse: The World's First Personal AI Agent Built for Everyone").

- **Announced:** 2026-09-08 by Meta (post updated 2026-09-30) [P].
- **Availability:** US only, adults [S]. It runs on iOS, Android and the web (muse.ai), and inside WhatsApp chats [P]. AI glasses are "coming soon".
- **Model:** **Muse Spark**, "Meta's most capable model to date" [P]. Muse Spark 1.3 shipped on 2026-09-02, with a focus on coding and agentic tasks [S, Axios]. A 1M-token context window is reported [U, DataCamp only].
- **Pricing:** free up to a usage cap, plus "Power" at $20/month and "Maximum" at $100/month. A payment card is required [S, TechCrunch].
- **Announced at Connect (2026-09-23), no dates given [S, TechCrunch]:**
  - a Mac version that "operate[s] any app on a user's desktop"
  - a wake word on glasses
  - better background work ("walk away … it keeps working")
  - its own e-mail address for Muse, and forwarding mail to it
  - a realtime avatar
  - more connectors, and an open platform for third-party connectors
- **Muse for Small Business (2026-09-29) [S, CNBC]:** connects to Asana, Zoom, Intuit, Box, Canva, Slack, Meta ad accounts and business Instagram/Facebook pages.
- **Related names that could be confused with it:** "Muse Spark" is the model. "Muse Code" is a developer coding product (dev.meta.ai/docs/muse-code). "Muse for Small Business" is the business version above.

### 1.2 Architecture

Main source: Meta's engineering post "How We Built Safety Into Muse" (research.meta.ai, 2026-09-08) [P].

- **One dedicated cloud VM per user** ("Muse Secure VM"). It is the system of record for the user's data.
- **Inside the VM, a `systemd-nspawn` "runtime cell"** holds the agent daemon, workspace and tools:
  - Root inside the cell maps to an unprivileged host user.
  - Syscalls are filtered (no `io_uring`).
  - It has no `CAP_SYS_PTRACE` and no `CAP_NET_ADMIN`.
  - It has its own virtual network interface.
- **Outside the cell, as separate systemd units:**
  - `hatch-safety`: classifiers on inference input and output
  - `privsep` workers: connector code with scoped privileges
  - `hatch-authd`: the credential store, which issues surrogate tokens
  - **Sentinel**: the permission authority
  - Postgres for application state
  - proxies for inference and telemetry
- **Communication between these parts:** Unix domain sockets with `SO_PEERCRED` and peer ACLs.
- **Sentinel is a separate agent and the "sole permission authority":**
  - It decides on every connector action and every network egress.
  - Network checks run at layers 4 and 7: hostname, resolved and final IP, port, protocol, method, path and decoded request. There is also SSRF protection.
  - The outcome is **allow / deny / ask**.
- **Taint tracking ("tainted egress"):**
  - Each tool process starts clean and becomes tainted once it reads user data.
  - Tainted or unverifiable processes lose auto-allow.
  - It is implemented with eBPF cgroup programs and LSM hooks.
- **Prompt-injection defense:**
  - The model is trained to resist injection ("close to SOTA").
  - External data is labeled untrusted.
  - An ensemble of independently trained classifiers runs in parallel.
  - Data leaving the VM needs human approval.
  - Meta explicitly cites Simon Willison's "lethal trifecta".
- **Bug bounty:** up to $300k overall, up to $130k for a single-user prompt injection [P].
- **Planned "Muse Confidential VM":** encrypted with a key only the user holds, "later this year" [P]. Until then, Meta personnel can technically access the VM [S].

### 1.3 Memory and personal context

- **What Meta says:** Muse "remembers what matters to a person", acts on details mentioned once, and makes unprompted suggestions. Users can tell it to "forget". Example source: an Instagram recipe reel saved by the user becomes a grocery list [P].
- **Storage:** memory is kept as **files in the VM, which users can inspect, edit and download**. Meta's David Singleton referred to "the markdown files Muse writes" [S, TIME 2026-10-06].
- **How the profile is built,** per TIME's review of Muse's internal instructions, which are visible in its file browser and session logs [S, TIME 2026-10-06]:
  - **Hourly job:** updates dossier-style pages on the user and on *every person mentioned* in chats, messages and e-mails Muse has read. A page records how people met, shared interests, disputes, and "tensions and alliances". Non-users are included.
  - **Nightly job:** analyzes the day's conversations.
  - Muse infers goals the user has not stated and learns which prompts work for each user.
  - Meta did not dispute the report. It says it "de-identif[ies] learnings" that are shared across the system.
- **Data sources:**
  - Connected Facebook and Instagram, e-mail, calendar, and chats [P/S].
  - In testing, Facebook and Instagram were connected by default, and onboarding built a profile from them (location, relationship status, interests) [S, MindStudio; U].
- **Privacy controls:**
  - Conversations and VM data are not shared with Meta's ad systems. Browsing activity still appears as the user's activity [P].
  - Users can opt out of model training. PII is scrubbed before trajectories are used for training [P].
  - Users can change connector access or disconnect any connector [P].
- **Criticism:** profiles of non-users; "forget" does not delete the original messages [S, TIME].

### 1.4 Browser control

- **Where the browser runs:** a **real Chromium in the cloud VM**, behind a virtualization layer. It is **not the user's own browser** [P].
- **What the browser sub-agent sees:** an **accessibility-tree snapshot, not the raw DOM** [P].
  - It **cannot run JavaScript or use DevTools**.
  - A separate broker owns the CDP connection.
- **Watching and taking over:**
  - The user can watch live and **take over at any time**, which pauses the agent [P].
  - The agent is also paused while credentials are filled in.
- **Classifiers on the browser:** personal-data egress, prompt injection in the DOM, images and downloads, and high-risk form submissions. Known malicious sites are blocked inside the VM [P].
- **Logins:**
  - **Credentials the user shares go into a vault** in the app and are stored in `authd`.
  - **They are injected into the page where needed. The agent never sees them.**
  - Muse "cannot see passwords a person types into the browser themselves" [P].
  - 1Password integration is "coming" [P].
  - A reviewer stored airline credentials in the vault [S, Slate].
  - **Cookies, passkeys and session persistence are not documented [U].**
- **Payments:**
  - Checkout pages are detected, and each purchase needs approval with the exact details.
  - Payment uses single-use virtual cards (Stripe Link), each bound to one merchant, one amount and a time window [P].
  - Shop Pay and PayPal follow [S].

### 1.5 Connectors

- **Built in:** Gmail, Google Calendar, Facebook, Instagram, plus OpenTable, Peloton, Plaid and Function Health (seen in tests) [S].
- **From Connect:** Shopify catalog, Best Buy, Gap, Sephora, Walmart, Wayfair, Expedia, Instacart, GitHub, Granola and Notion [S].
- **Access levels:** chosen per connector, for example mail "read only" vs "read + send" [P].
- **Custom APIs:** if a service has an API but no connector, Muse can connect with credentials the user supplies. **If there is no API, it uses the browser** [S, TechCrunch].
- **Credential isolation:** connector credentials are allowlisted per worker cgroup. The calendar worker cannot request mail credentials [P].
- **Mail filtering:** the mail connector **filters OTPs, password-reset links and magic login links**, using rules plus a classifier [P].

### 1.6 Bot protection and CAPTCHAs

- **There is no official Meta statement on CAPTCHAs.**
- **Observed behavior [S, Slate 2026-09-23]:** at an airline CAPTCHA, Muse "asked me if I should take over or if it should attempt to pass the test". It failed. The reviewer took over, logged in, and handed control back.
- **Identification:**
  - Cloudflare Radar lists a `muse-` user-agent prefix [U, reported via aicrawlercheck].
  - Meta has published no Web Bot Auth support, IP ranges or robots.txt policy for Muse [U].
- **Amazon blocked Muse.** It said Amazon received no notice or choice, and per secondary reports that Muse did not identify itself. Meta disputed parts of this [S, CNN 2026-09-28]. **Lesson: agents that do not identify themselves and use no partner channel get blocked.**

### 1.7 Safety and approval model

- **Approval for sensitive actions:** mail, purchases, and signing in [P/S].
- **Approval dialogs appear in the client UI, not in the chat.** The user's answer goes straight to Sentinel, so injected text cannot fake an approval [P].
- **Grants are scoped capabilities:**
  - Bound to a connector or destination plus a use case.
  - Durations: one-time, session, task, time-bounded, or permanent.
  - Later calls must match the granted scope exactly.
  - Read-only or previously allowed actions run without asking [P].
- **Audit trail and background work:** there is a full audit trail of past and planned actions. Muse works on after the app is closed and comes back when it needs approval [P].

---

## 2. Google's Gemini agent (work) and the consumer Gemini agents

### 2.1 Event and announcement

The event is **"Gemini at Work 2026"**, the Google Cloud event the user called "Gemini for work". The **"Gemini agent"** was announced there on **2026-10-08** by Thomas Kurian (Google Cloud blog "Welcome to Gemini at Work 2026: Introducing Gemini agent") [P].

- **Positioning:** "a single, universal agent for work that answers your questions, handles your knowledge work, creates your images and media, and writes and runs code". "You give it objectives, not instructions." [P]
- **Status:** **private preview**, with wide availability "soon" for selected Workspace Business/Enterprise plans [S, 9to5Google]. Most features have no GA date or pricing [S, Futurum].
- **Where it runs:** web, iOS, Android, Windows, Mac, the command line, inside Workspace, Microsoft 365 and Slack, and headless through an API [P].
- **Models:** it routes each job to "the model that fits best", across Gemini and **Anthropic's Claude** models [P].

### 2.2 Capabilities

**Memory** has four types [P]:
- **Session:** the current task, "even when it runs for days".
- **Semantic:** "a structured knowledge base it builds as it reads documents, talks to people".
- **Procedural:** how a job gets done, "including skills it writes for itself".
- **Episodic:** "everything it has done before".
- It "onboards itself the way a new hire would". Projects bundle context, skills and tools.
- 9to5Google describes a "single set of memories, context, and one personalization graph" [S].

**Skills** [P]:
- Reusable instructions or workflows stored as modular prompts.
- Three layers: a global library, a team registry, and personal skills.
- The agent picks skills and "continuously learns from each execution".

**Connectors** [P]:
- Workspace (Gmail, Drive, Docs, Sheets, Slides, Chat, Calendar), Microsoft Office/Teams, Slack, Confluence, Jira, Git, Salesforce, ServiceNow, BigQuery, Databricks, Postgres, Snowflake, and **"files on the user's desktop"**.
- **Any MCP server**, inside or outside the corporate network.
- An enterprise tools registry.
- Earlier release notes: Custom MCP server data stores became GA on 2026-08-07 (off until an admin enables them). Federated Data Cloud connectors via MCP use **each user's own credentials** (preview, 2026-10-02) [P].

**Background and scheduled work** [P]:
- "Runs in the cloud … work that takes hours or days keeps running after you close your laptop."
- "You can assign it work, **schedule tasks**, or have it **respond to events**."
- It creates temporary sub-agents, "each with their own identity".
- **Coworker agents** get their own Workspace account (`@agents.company.com` mail, calendar, Drive, directory entry) and see only what is shared with them.
- Workflow Builder (formerly Agent Designer) became GA on 2026-09-03 with scheduled, on-demand and @-mention workflows [P].

**Governance** [P]:
- Each agent has a cryptographically attested identity with least privilege.
- Permissions are role-based and approved by admins. External systems use OAuth.
- The audit trail attributes every action to the agent.
- Execution happens in an **Agent Sandbox** with its own network boundary. All traffic passes through **Agent Gateway**, an AI firewall with policies such as "agents may not open documents classified Need to Know".
- Per-project spend caps pause the agent; resuming takes one click.

**Not described in the announcement:** browser or computer use, Deep Research, Maps, location or weather, and per-action approval gates.

**Adjacent building blocks on the platform** [P]:
- **Computer Use sandboxes** in the Gemini Enterprise Agent Platform:
  - What they are: a "secure, isolated browser environment".
  - How they are driven: through the API or through **CDP** (so Playwright works).
  - Users can watch through a **VNC live view**.
  - The docs mention no takeover.
  - GA on 2026-09-09 is reported [U, secondary only].
- **Computer use is built into Gemini 3.5 Flash** (2026-06-24).
- **Deep Research** agents `deep-research-preview-04-2026` and `-max-` support MCP and File Search (Gemini API changelog).

**Personalization in the Gemini Enterprise app** (docs, updated 2026-10-09) [P]:
- **Learning:** memory "remembers your recent conversations and **infers stylistic preferences and location**". It extracts insights from mail, calendar and documents.
- **Saved memories:** "remember …" creates a saved memory that can be viewed, edited and deleted.
- **On by default:** users cannot disable memory; only admins can.
- **Retention:** deleted saved memories "might still be retained as long as the original conversation is saved".
- **Data-source changes** take up to 24 hours to take effect.

### 2.3 Consumer Gemini agents (2026)

**Gemini Spark**, announced on 2026-05-19 at I/O, is the successor of "Gemini Agent" (Nov 2025). The help page now lives under the Spark name [P].
- **Runtime:** a cloud agent on Gemini 3.5 with the Antigravity harness. It "keeps working in the background even when you close your laptop".
- **Triggers:** recurring tasks or triggers, and schedules "at a specific date and time or **in response to an event**", for example a flight delay. At most **15 tasks run in parallel** [P help].
- **Three execution environments** [P help]:
  1. The **local browser**: the user's own Chrome. "Has access to all the same sites that you do, including sites you're signed into". The device must stay awake.
  2. A **remote browser**: "a separate, new browser instance, not your local browser in the cloud". It keeps running after the device is closed.
  3. A **remote computer** for running code, which keeps data between sessions.
- **Sign-in:**
  - Spark asks to use "Sign in with Google". Otherwise the user signs in themselves.
  - With permission it can use Password Manager logins.
  - It pauses and asks the user to **take over** for passwords and payment data.
  - "Take over task" and "Go back to Gemini" switch control [P help].
- **Confirmation before:** sending, purchases, form submissions, Sign in with Google, and edits to shared files. Every browsing task needs confirmation [P help].
- **Sources:** Personal Intelligence (including memory of past chats), Gemini instructions, Connected Apps (Workspace, Contacts, Photos, Search/Maps/Flights/Hotels/Finance, YouTube, third-party apps), skills, and "location" [P help].
- **MCP partner connections:** Canva, OpenTable, Instacart [P, I/O blog].
- **Availability:** AI Pro/Ultra, 18+, personal accounts. **Not in the EEA, UK, Switzerland or Nigeria** [P help]. This matters for German users.
- **Mac app:** Spark there works with local files and folders the user connects (beta since 2026-07-01) [S, TechCrunch].
- **Daily Brief:** an opt-in morning digest from connected apps, built in the background [P].

**Gemini in Chrome "auto browse"** [P]:
- **Rollout:** desktop since January 2026 for US Pro/Ultra; Android from late June 2026.
- **It runs in the user's own Chrome profile.**
- **Passwords:** Google Password Manager signs in after permission, and "Google doesn't share your passwords with Gemini in Chrome" [P help].
- **Confirmation** before sending, changing data, form submissions, and before "accessing sites with highly sensitive financial or health data". Finalizing a payment is handed to the user.
- **Limits:** 20 tasks/day on Pro, 200 on Ultra. Not in Incognito mode.

**Chrome's security architecture** (Google Security Blog, 2025-12-08) [P]:
- **User Alignment Critic:**
  - A separate Gemini model checks every planned action against the user's task.
  - It sees **only metadata about the action, not web content**, so it cannot be injected through the page.
  - It can veto the action. After repeated failures, control goes back to the user.
- **Agent Origin Sets:**
  - A trusted gating function, never exposed to web content, decides which origins are **read-only** and which are **read-write** for this task.
  - Iframes from other origins are hidden.
  - A new origin needs a check. Model-generated URLs are checked deterministically against known public URLs.
- **Mandatory confirmation:** sensitive sites (deterministic list), sign-in through Password Manager, purchases and sending messages.
- **Other layers:** a prompt-injection classifier on every page, running in parallel with planning. A visible work log; pause or take over at any time.

**Personal Intelligence** (2026-01-14) [P]:
- Opt-in. It connects Gmail, Photos, YouTube and Search.
- **Data is retrieved at query time** ("Gemini accesses your data to answer your specific requests").
- It tries to cite which personal data it used.
- Against over-personalization: correct it in the chat, thumbs down, "regenerate without personalization", and temporary chats.
- Secondary sources call the core problem "context packing": choosing the relevant personal data without flooding the context [S, DataCamp; U].

**Agent identification on Google's side** [S]:
- Since 2026-03-20 there is a user agent **`Google-Agent`** for agents on Google infrastructure acting for a user. Project Mariner was the example.
- It uses published IP ranges (`user-triggered-agents.json`).
- It **experiments with Web Bot Auth** (identity `agent.bot.goog`).
- It generally ignores robots.txt because fetches are user-triggered.

---

## 3. Context for simple questions ("Wie ist das Wetter?")

| | Location source | Weather/places tool |
|---|---|---|
| **Gemini app (consumer)** [P] | Location is "always collected". By default the **general area from the IP address, or the Home/Work addresses in the Google account**. **Precise device location only with permission** (on mobile, the Google app's location permission; on the web, a blue/grey dot in Settings). It can also receive the location from another Google service such as Maps. Precise location from the device is "not stored". | Google Search grounding and **Grounding with Google Maps** (API: `toolConfig.retrievalConfig.latLng`). Google also offers a **Maps Platform Weather API** (`currentConditions:lookup`, `forecast/days`, `forecast/hours`). **[U]** It is not documented that the Gemini app uses exactly this API internally; Weather in the app most likely comes from Search grounding. |
| **Gemini Enterprise** [P] | Location is **inferred from conversation history** (personalization docs); Spark lists "location" as a source. | Not documented for the work agent. |
| **Meta Muse** | **[U] Not documented.** Secondary reports say onboarding derived location from Facebook/Instagram profile data. Meta's general products estimate approximate location from the IP address even when device location is off (Quest help); there is no Muse-specific statement. | Not documented. The browser in the cloud VM or web search are plausible, but unverified. |
| **Aura today** (code) | `location_mode` = `profile` (place from the profile, default, no network call) · `ip` (opt-in, ipapi.co) · `device` (stub; behaves like profile for now). | `weather` tool via **Open-Meteo** (geocoding plus forecast, no key, 15-minute cache), tier T0. The router explicitly says "never use the browser for this". |

So Aura is already roughly on par with Gemini for weather. It is missing (a) device location through the OS location service (Linux GeoClue2, Windows `Windows.Devices.Geolocation`), (b) a "Home/Work" place pair from the profile (Gemini has this), and (c) a places/opening-hours tool (Gemini: Maps grounding). One open source for (c) is Nominatim/Overpass, which has strict usage policies; a local cache is required.

---

## 4. Techniques worth copying, explained for an engineer

### 4.1 Memory extraction and consolidation

**Google Agent Platform Memory Bank** [P] (docs updated 2026-10-13; Aura uses ADK, so this applies directly):
1. **Events in, extraction in the background.** After a session, or by batching rules, the conversation events go to an LLM extractor. The agent does not wait for it.
2. **Topic-guided extraction.** Configurable "topics" plus few-shot examples define what counts as memorable. **[U, from ADK/Memory Bank docs that I did not re-check today]** The managed topics are `USER_PERSONAL_INFO`, `USER_PREFERENCES`, `KEY_CONVERSATION_DETAILS` and `EXPLICIT_INSTRUCTIONS`.
3. **Consolidation.** Each new extraction is compared with the existing memories in the same **scope** (for example `{user_id}`). An LLM decides **create / update / delete**, and contradictions update or delete the old fact. An explicit "forget X" deletes it [P quickstart].
4. **Revisions** record every change, which gives an audit trail. A **TTL** per memory removes stale facts.
5. **Retrieval** returns either everything or a **similarity search** over the current request. In ADK this is `PreloadMemoryTool`, which adds memories to every turn, or `LoadMemoryTool`, which the model calls on demand [U, ADK names from prior knowledge].

**Meta Muse** [S, TIME]:
- An **entity page per person**, as markdown files.
- An **hourly** consolidation job over newly read messages and mail, and a **nightly** reflection over the day.
- Worth copying: entity pages ("people, projects, places") as the unit of consolidation, instead of loose facts.
- Not worth copying: profiling third parties who never agreed to it. For Aura: only people the user mentions themselves, visible, deletable, and never from untrusted content without approval.

**Gemini Enterprise** [P]: four memory types (session, semantic, procedural, episodic) and **skills the agent writes itself**. This matches Aura's four layers (profile, facts, episodes, procedures).

**Concrete algorithm for Aura (FR-MEM-003, story 8):**
```
after_task(chat):
  if chat.incognito or memory.paused: return
  cands = LLM_extract(chat.turns, topics=[prefs, people, projects, places, corrections, explicit],
                      existing=facts.similar(chat, k=20), max=3)      # sees existing facts → can update
  for c in cands:
      op = c.op ∈ {create, update(id), delete(id), noop}
      if chat.tainted: queue_for_approval(c)                         # NFR-SEC-012 / FR-MEM-009
      else: apply(op); emit_chat_note("Aura hat gelernt: … (rückgängig)")
  episodes.add(summary(chat), embedding(summary))                   # FR-MEM-004
```
- Give the extractor the existing similar facts. Without them it cannot decide between update and delete.
- Run it with a local model in the background (NFR-PA-003).

### 4.2 Retrieving personal context

- **Query-time retrieval instead of a full dump.** Gemini Personal Intelligence fetches mail and photo data per request. Memory Bank uses similarity search. Aura's `FactStore.select_for_prompt(request, budget)` already follows this principle (lexical scoring).
- **Next step for Aura:** hybrid ranking with BM25 (FTS5) plus local embeddings, fused with RRF, a boost for recent `last_used`, and the profile always included. Cite which memories were used, as Gemini does ("tries to reference the information it used").
- **Against over-personalization:** add a "Antwort ohne Personalisierung" action and incognito (FR-MEM-007).

### 4.3 Planning and background execution

- **Gemini Spark:** schedules by time or **event** (for example a flight delay). Tasks are tracked in a work panel, with at most 15 in parallel. A **local browser** works only while the device is awake; a remote browser keeps going.
- **Muse:** keeps working with the app closed and **pauses only at "ask" decisions**. The pending approval waits as a system dialog, and the user gets a notification.
- **Gemini at Work:** sub-agents per job, each with its own identity and least privilege. Spend caps pause a project.
- **For Aura (local, no cloud):**
  - A task queue in the main process: SQLite with `next_run`, rrule or cron, and event triggers (for example "new mail from X" through connector polling).
  - Runs execute headless through the existing ADK runner.
  - When an action needs T2 approval, the run **pauses** and sends an OS notification plus an entry in the Zentrale inbox.
  - Limits: maximum parallel runs, a token budget per run, and nothing while the computer sleeps. This is the same limit as Spark's local browser; be honest about it.

### 4.4 Browser automation

| | Muse | Gemini Computer Use API | Chrome auto browse / Spark | Aura |
|---|---|---|---|---|
| Where | Cloud VM, Chromium | Any (recommended: sandbox VM or container) | **User's own Chrome** or remote browser | Own Chrome profile `~/.aura/browser-profile` (visible) |
| Observation | **Accessibility-tree snapshot**, no raw DOM | **Screenshots**, normalized 1000×1000 coordinates | Not documented in detail | Playwright MCP (accessibility snapshot) plus screenshot |
| Restrictions | No JS, no DevTools, CDP broker separate | `safety_decision`: allowed / `require_confirmation` / blocked | Origin sets (read/write), critic, sensitive-site list | Tiers per action (`_act_tier`, `_nav_tier`) |

Worth copying:
1. **An accessibility snapshot as the primary observation, without `browser_evaluate` or JS for the model.** This matches Muse. Check whether Aura's Playwright MCP has `browser_evaluate` and code execution switched off (`--caps`).
2. **Per-task origin sets.** At the start of a task, a trusted function (not exposed to web content) fixes the allowed origins: read-only or read-write. Navigating to a new origin needs a deterministic check or an approval. Iframes from other origins are not shown to the model.
3. **A metadata-only critic.** A second, small LLM call sees only *(user task, proposed action, target element label, origin)*, never page content, and returns allow or veto. This is cheap with a local model and isolated from injection.
4. **A deterministic list of sensitive sites** (banking, health, government) that always needs confirmation.

### 4.5 Credential handling

- **Muse: surrogate tokens.**
  - The agent and the connector workers see only placeholder tokens.
  - `authd` swaps in the real secret **at the network boundary**, only after Sentinel has approved.
  - Credential allowlists are tied to each worker's cgroup.
  - For browser logins: the user enters credentials in a separate client UI. They go directly to `authd`, which **injects them into the page field**; the agent is paused meanwhile.
- **Chrome:** the password manager fills the form; "the model does not have direct access to stored passwords"; sign-in needs a confirmation.
- **Spark:** prefer "Sign in with Google", otherwise **take over** and the user signs in.
- **For Aura (fits the existing vault and `${secret:NAME}` references):**
  - Add a browser tool `browser_fill_secret(element, secret="NAME")` that runs in the **main process**: Electron or Playwright `fill` with the vault value.
  - The LLM only sees `NAME`. The value is never echoed into snapshots: mask password fields in the accessibility snapshot.
  - Tier T2 with origin binding: a secret may only be filled on its stored origin, like a password manager's origin binding.
  - **Sessions stay in the Aura profile.** The user signs in there once through takeover; cookies persist in `~/.aura/browser-profile`. Aura never reads password stores or cookies of the user's browser (spec non-goal, NFR-SEC-005).
  - Like Muse, filter OTPs, reset links and magic links in mail connector output before it reaches the model.

### 4.6 Handoff to the user (login, CAPTCHA, payment)

- **The pattern is the same in all three products:**
  1. The agent detects a login, CAPTCHA or payment step.
  2. It **pauses** and asks the user to take over.
  3. The user acts directly in the browser.
  4. The user clicks "Give back".
  5. The agent continues from a fresh snapshot.
- **Gemini API guidance [P]:** the agent "MUST NEVER attempt to solve or bypass" CAPTCHAs, and must ask the user instead.
- **Muse** offered the user "let me try". Do **not** copy that.
- **For Aura:** a tool `request_takeover(reason)`:
  - It brings the browser window to the front and shows a banner in the panel ("Bitte anmelden / CAPTCHA lösen, dann ‚Weiter'").
  - It blocks the agent until "Weiter" or "Abbrechen".
  - The system prompt plus a guard rule state: CAPTCHA → takeover, never solve it.
  - Taint: content after takeover stays untrusted.

### 4.7 Bot protection handled legitimately

- **Prefer APIs and partner connectors over the browser.** Spark and Muse use MCP or partner connectors for OpenTable, Instacart and shops. This is Aura's FR-CON-005 principle.
- **The user's own, logged-in browser** (Chrome auto browse, Spark local browser). The agent acts as the user, in the user's session, with the user present.
  - Aura's equivalent: a visible Aura profile with a one-time manual sign-in.
  - A Chrome extension bridge would be the next level (out of scope today).
- **WebMCP** (proposed standard, Chrome 149 origin trial): sites expose structured tools to browser agents. This is worth watching.
- **Agent identification:**
  - **Web Bot Auth** (IETF webbotauth, RFC 9421 HTTP Message Signatures, keys at `/.well-known/http-message-signatures-directory`, `Signature-Agent` header). It is **not yet an RFC**; the WG draft `draft-ietf-webbotauth-httpsig-protocol-00` is dated 2026-09-01 [U].
  - Cloudflare, Akamai and AWS WAF reportedly verify these signatures already [U].
  - Google publishes `Google-Agent` with IP ranges [S].
  - For a *local* agent acting in the user's own session, signing makes little sense: there is no central key operator. Aura can instead respect the site's terms and robots policies in its own profile, and identify itself where a site asks.
- **Lesson from Muse and Amazon:** sites block unannounced agents. Open a site only when the user asks for it, prefer an official API, and on a block say so honestly rather than evading it.

---

## 5. Comparison: Meta Muse vs Gemini agent vs Aura today

| Aspect | Meta Muse (consumer, US) | Gemini agent (work) / Spark (consumer) | Aura today (2026-10-13) |
|---|---|---|---|
| **Runtime** | Cloud VM per user (nspawn cell plus host services) | Google Cloud; Agent Sandbox plus Agent Gateway; Spark: cloud plus optional local Chrome | Local desktop app (Electron plus Python ADK); local models via Ollama or Gemini |
| **Memory** | Markdown files in the VM; hourly people dossiers, nightly reflection; forget; export | 4 types (session, semantic, procedural, episodic); self-written skills; consumer: saved info plus past chats plus Personal Intelligence; Enterprise: memory on by default | `FactStore` (SQLite records with source, topic, confidence; `MEMORY.md` view); `remember/forget/recall`; FTS over old chats (episodes); "learned" source exists in the schema, **automatic learning and embeddings not implemented yet** |
| **Context sources** | FB/IG, mail, calendar, chats, health/finance connectors | Workspace/M365, Personal Intelligence (Gmail, Photos, YouTube, Search), location (IP/Home-Work/device), MCP | Profile (name, language, place), facts, chat history, location (profile/IP; device is a stub), Open-Meteo weather, connected MCP connectors |
| **Browser** | Cloud Chromium; accessibility-tree snapshot; no JS/DevTools; live view plus takeover | Chrome auto browse in the user's profile, or a remote browser; origin sets plus alignment critic; Computer Use API (screenshots) | Playwright MCP in its own visible Chrome profile; tiers per action; **no formal takeover/give-back flow** |
| **Credentials** | Vault in the VM (`authd`), surrogate tokens injected at the network boundary; browser passwords injected without the model seeing them; 1Password planned | Google identity, OAuth; Password Manager fills without the model seeing passwords; "Sign in with Google"; takeover | OS-keystore vault (`safeStorage`), `${secret:NAME}`, values never in renderer, LLM or logs; OAuth 2.1 for MCP (spec); **no secure form filling in the browser** |
| **Connectors** | Built-in connectors plus open connector platform; per-connector access level | Workspace, M365, Slack, Jira, Salesforce …, **any MCP**, enterprise tools registry | MCP connectors: curated catalog plus registry, `find_connector`, connect card, bubblewrap sandbox, drift protection |
| **Background/scheduled tasks** | Yes (keeps working after the app closes; "upcoming" recurring tasks) | Yes (hours or days; schedules plus event triggers; Spark ≤ 15 parallel; Daily Brief) | **No** (tasks run only while a chat is active) |
| **Safety/approval** | Sentinel (allow/deny/ask), approval dialog **outside the chat**, scoped grants (one-time … perpetual), eBPF taint, classifier ensemble, audit trail | Admin-approved RBAC, agent identity, audit; consumer: confirmation for sending, buying, forms, sign-in, sensitive sites; critic; injection classifier | Guard plus tiers T0–T3, taint tracking, exfiltration rule, approvals in the panel, MCP drift hash, memory writes after untrusted input need approval |
| **Privacy** | Meta can technically access data until "Confidential VM"; training opt-out; criticism for profiling non-users | Data in Google; memory outlives deleted saved memories; not in the EEA (Spark) | Everything local; delete cascade per chat (spec); no cloud |

---

## 6. Capability gaps for Aura (prioritized)

1. **Background and scheduled tasks, with time and event triggers**, pause-at-approval, OS notifications, and a task list in the Zentrale. Neither competitor lacks this; Aura does entirely.
2. **Browser handoff:** `request_takeover(reason)` with "Weiter/Abbrechen", window to the front, and a hard rule "CAPTCHA → user, never solve". This fixes the Gmail incident pattern (§1.1 of the spec) for sites without a connector.
3. **Secure credential filling in the browser:** `browser_fill_secret(element, NAME)` in the main process, bound to the stored origin, with password fields masked in snapshots. Modeled on Muse `authd` and Chrome's password manager.
4. **Automatic learning (reflection)** with create/update/delete consolidation against existing facts, ≤ 3 per task, an undo note, and approval when tainted (FR-MEM-003). The schema is ready (`source="learned"`, `delete_where`), but no code writes learned facts yet.
5. **Semantic episodes:** local embeddings plus hybrid recall with sources (FR-MEM-004). Today recall is FTS only.
6. **Entity pages** (people, projects, places) as the unit of consolidation, only for people the user mentions, deletable. Optional, a step beyond flat facts.
7. **Origin sets and a metadata-only critic** for the browser specialist, plus a deterministic list of sensitive sites. This is cheap with a local model and isolated from injection.
8. **Approval dialogs strictly outside the chat flow**, with scoped grants (once, this task, this session, time-limited) bound to connector or origin plus action. Check whether Aura's panel approvals already offer this granularity.
9. **Device location** (GeoClue2 on Linux, WinRT Geolocation on Windows) and Home/Work places in the profile; a places/opening-hours tool.
10. **OTP, reset-link and magic-link filter** for mail connector output before the LLM sees it.
11. **"Answer without personalization"** and showing which memories were used for an answer (Personal Intelligence pattern).
12. **Procedures as skills** that the agent proposes itself (Gemini "skills it writes for itself", FR-MEM-005).
13. **Watch: WebMCP** (structured site tools for browser agents) and Web Bot Auth. Neither is needed for Aura today; it only matters if Aura ever offers a cloud browser.

**Deliberately not copied:** a cloud VM (contradicts Aura's no-cloud principle), profiling third parties, letting the agent attempt CAPTCHAs, reading the user's browser password stores or cookies, and fingerprint or IP tricks.

---

## 7. Sources

**Meta Muse**
- Meta Newsroom, "Introducing Muse: The World's First Personal AI Agent Built for Everyone", 2026-09-08 (upd. 2026-09-30): https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/
- Meta AI Research, "How We Built Safety Into Muse" (T. Sheasha), 2026-09-08: https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse
- TechCrunch, "Meta debuts its Muse AI agent. Will consumers trust it?", 2026-09-08: https://techcrunch.com/2026/09/08/meta-debuts-its-muse-ai-agent-will-consumers-trust-it/
- TechCrunch, "Everything new coming to Meta's AI agent Muse", 2026-09-23: https://techcrunch.com/2026/09/23/everything-new-coming-to-metas-ai-agent-muse/
- Axios, "Meta debuts Muse Spark 1.3 …", 2026-09-02: https://www.axios.com/2026/09/02/meta-debuts-muse-spark-13-as-personal-agent-work-continues
- Slate, Muse review (A. Kirshner), 2026-09-23: https://slate.com/technology/2026/09/meta-muse-ai-app-review.html
- TIME, "Meta's Muse AI Agent Is Building a Dossier On You" (H. Booth), 2026-10-06: https://time.com/article/2026/10/06/meta-muse-ai-agent-privacy/
- CNN, "AI agents promise to do everything for you…" (Amazon block), 2026-09-28: https://www.cnn.com/2026/09/28/tech/meta-muse-ai-agents-amazon
- CNBC, "Meta launches Muse for Small Business", 2026-09-29: https://www.cnbc.com/2026/09/29/meta-launches-muse-for-small-business-zuckerberg-pushes-enterprise-ai.html
- MindStudio, "Meta Muse Explained", 2026-09-12 (secondary): https://www.mindstudio.ai/blog/meta-muse-ai-agent
- aicrawlercheck, "Meta Muse AI Agent: User Agent…", undated, 2026 (secondary, U): https://aicrawlercheck.com/blog/meta-muse-ai-agent-website-guide · Cloudflare Radar entry: https://radar.cloudflare.com/bots/directory/muse
- Meta help "How your Muse agent browses the web" (body not retrievable, cookie wall): https://www.meta.com/help/artificial-intelligence/2124746764949121/

**Google**
- Google Cloud Blog, "Welcome to Gemini at Work 2026: Introducing Gemini agent" (T. Kurian), 2026-10-08: https://cloud.google.com/blog/products/ai-machine-learning/welcome-to-gemini-at-work-2026
- Google Keyword, "Google Cloud introduces the Gemini agent", 2026-10-08: https://blog.google/innovation-and-ai/infrastructure-and-cloud/google-cloud/gemini-at-work/
- 9to5Google, "Google Cloud announces 'Gemini agent'…", 2026-10-08: https://9to5google.com/2026/10/08/gemini-agent-google-cloud/
- Futurum, "Google Collapses Enterprise AI Into a Single Gemini Agent…", 2026-10: https://futurumgroup.com/insights/google-collapses-enterprise-ai-into-a-single-gemini-agent-at-gemini-at-work-2026/
- Gemini Enterprise docs, "Configure personalization", updated 2026-10-09: https://docs.cloud.google.com/gemini/enterprise/docs/configure-personalization
- Gemini Enterprise release notes (Jul–Oct 2026 entries): https://docs.cloud.google.com/gemini/enterprise/docs/release-notes
- Agent Platform Memory Bank, updated 2026-10-13: https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank · quickstart: https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank/api-quickstart
- Agent Platform Computer Use sandbox, updated 2026-10-13: https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/sandbox/computer-use
- Google Keyword, "Introducing computer use in Gemini 3.5 Flash", 2026-06-24: https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-computer-use-gemini-3-5-flash/
- Gemini API docs, Computer Use: https://ai.google.dev/gemini-api/docs/computer-use · changelog: https://ai.google.dev/gemini-api/docs/changelog
- Google Keyword, "The Gemini app becomes more agentic…" (Spark), 2026-05-19: https://blog.google/innovation-and-ai/products/gemini-app/next-evolution-gemini-app/
- Gemini Apps Help, "Use Gemini Spark…" (accessed 2026-10-13): https://support.google.com/gemini/answer/16596215?hl=en&co=GENIE.Platform%3DDesktop
- Chrome Help, "auto browse" (accessed 2026-10-13): https://support.google.com/chrome/answer/16821166?hl=en
- Chrome for Developers, "15 updates from Google I/O 2026" (WebMCP, auto browse), 2026-05-19: https://developer.chrome.com/blog/chrome-at-io26
- Google Security Blog, "Architecting security for agentic capabilities in Chrome" (N. Parker), 2025-12-08: https://blog.google/security/architecting-security-for-agentic/
- Google Keyword, "Personal Intelligence", 2026-01-14: https://blog.google/innovation-and-ai/products/gemini-app/personal-intelligence/
- Gemini Apps Privacy Hub (location), updated 2026-09-24: https://support.google.com/gemini/answer/13594961?hl=en
- TechCrunch, "Gemini Spark … now available on Mac", 2026-07-01: https://techcrunch.com/2026/07/01/gemini-spark-googles-agentic-assistant-is-now-available-on-mac/
- Gemini API, Grounding with Google Maps: https://ai.google.dev/gemini-api/docs/generate-content/maps-grounding
- Google Maps Platform Weather API: https://developers.google.com/maps/documentation/weather
- SERoundtable, "Google Adds New Google-Agent User Agent", 2026-03 (secondary): https://www.seroundtable.com/google-agent-user-agent-41089.html

**Standards**
- IETF webbotauth registry draft: https://datatracker.ietf.org/doc/html/draft-meunier-webbotauth-registry-01 · WG status (check directly): https://datatracker.ietf.org/wg/webbotauth/
- Web Bot Auth status summary, 2026-09 (secondary, U): https://nerdleveltech.com/web-bot-auth-ietf-standard-agent-verification

**Unverified or open points:**
- Muse's location sources and weather tool.
- Muse's cookie and passkey handling.
- Muse's 1M-token context.
- GA date of the Computer Use sandbox.
- Memory Bank topic names and ADK tool names (from prior knowledge).
- Web Bot Auth WG draft status.
- Whether the Gemini app gets weather from Search grounding or a weather API.
- Whether the Gemini agent (work) can operate a browser itself; the announcement says nothing about it.
