# Spec: assistant parity with Gemini agent and Meta Muse (epic AURA-115)

Status: proposed · Author: maintainer + Claude · Date: 2026-10-13 · Research: [docs/research/assistant-parity.md](../research/assistant-parity.md)

## 1. Why

The maintainer wants Aura to do what the newest personal agents do. The two references are Google's **Gemini
agent**, announced at Gemini at Work on 2026-10-08, with its consumer counterpart **Gemini Spark**, and **Meta
Muse**, launched on 2026-09-08. The research (with sources) shows the following.

**What Aura already has.** Aura is at the same level in several areas:
- memory with provenance (AURA-107/108);
- MCP connectors with a reviewed catalog, OAuth, a sandbox and drift protection (AURA-95/96/97);
- tiered approvals with taint tracking;
- location and weather (AURA-116).

**What Aura lacks:**
1. **Background and scheduled work.** It runs while you are away and pauses only for approvals.
2. **Browser takeover.** The user handles logins and CAPTCHAs, then gives control back.
3. **Credentials filled into web forms** without the model ever seeing them.
4. **Automatic learning** that consolidates new facts with existing ones.
5. **Semantic recall** over past conversations.
6. **Transparency about personal context:** which memories an answer used, and an answer without personalization.
7. **Browser safety layers:** per-task origin sets, a critic that sees only action metadata, and a list of
   sensitive sites.

This spec turns these gaps into requirements. Aura stays local-first, so a cloud VM is not an option.

## 2. Goals and non-goals

### Goals

- **G1:** Aura answers everyday questions from context the user allowed: time, place, weather, calendar, memory.
  It does not ask back, and it does not go through the browser.
- **G2:** Aura knows the user's context through one memory:
  - profile, facts, people/projects/places, and past conversations;
  - it learns from conversations visibly, and the user can undo what it learned;
  - it picks the relevant parts per request ("context packing").
- **G3:** Aura works on tasks in the background and on a schedule:
  - triggered by time or by events;
  - it pauses for approvals and notifies the user;
  - it shows a task list.
- **G4:** Aura acts on websites the way the user would:
  - in a visible browser with the user's own sessions;
  - with takeover for logins and CAPTCHAs;
  - with secure filling of stored credentials.
- **G5:** Safety is at least as strong as in the references:
  - approvals outside the chat flow, with scoped grants;
  - a metadata-only critic and origin sets in the browser;
  - filters for one-time codes and login links.

### Non-goals: legal and ethical limits, decided 2026-10-13

These are not negotiable. The research confirms that the references keep the same limits.

- **N1:** No automatic CAPTCHA solving. No evasion of bot detection. No fingerprint or IP spoofing.
  Google's own agent guidance: agents "MUST NEVER attempt to solve or bypass" CAPTCHAs. Muse offering "let me try"
  is explicitly not copied.
- **N2:** No reading of passwords, cookies or passkeys from the user's browsers or OS password stores. Credentials
  come only from Aura's vault, entered by the user, or from the user typing them during a takeover. Chrome and Muse
  likewise never show stored passwords to the model.
- **N3:** No profiling of third parties. People pages exist only for people the user names, are visible and
  deletable, and are never filled from untrusted content without approval. TIME's criticism of Muse is the
  counter-example.
- **N4:** No cloud VM and no Aura cloud. Background work runs on the user's machine and honestly stops while it
  sleeps, the same limit as Gemini Spark's local browser.
- **N5:** Aura respects website terms. When a site blocks agents, Aura says so and offers an official route
  (connector or API), rather than working around the block. Lesson from Amazon blocking Muse.

## 3. Functional requirements (FR-PAR)

Each requirement has an ID, priority (M = must, S = should, C = could), story and verification method.

### 3.1 Everyday context

| ID | Requirement | Prio | Story | Verify |
|---|---|---|---|---|
| FR-PAR-001 | Weather and location tools with user-chosen location sources (profile, IP opt-in, device opt-in) | M | AURA-116 | eval `weather-*`, unit |
| FR-PAR-002 | Device location via GeoClue2 (Linux) and WinRT Geolocation (Windows), opt-in | S | AURA-117 | unit (mocked) |
| FR-PAR-003 | Home and work place in the profile; "how long to work?", "opening hours near me" via a places tool (Nominatim/Overpass with caching and their usage policies) | S | AURA-128 | eval, unit |
| FR-PAR-004 | Calendar as context: "what's on tomorrow?" via a calendar connector (IMAP/CalDAV or Google) | S | AURA-98 | eval |

### 3.2 One memory ("context understanding")

| ID | Requirement | Prio | Story | Verify |
|---|---|---|---|---|
| FR-PAR-010 | **Learning with consolidation**:<br>- After each task (not incognito, not paused), a local model proposes at most 3 changes against the **existing similar facts**: create, update, delete or no change.<br>- Each change is shown in the chat as "gelernt (rückgängig)".<br>- After untrusted content, changes need approval. | M | AURA-99 (extended) | eval `memory-learn`, `memory-poisoning` |
| FR-PAR-011 | **Hybrid recall**: BM25 (FTS5) plus local embeddings, fused with RRF and boosted by recency; this is the basis for context packing in the prompt | M | AURA-100 (extended) | eval `memory-recall`, unit |
| FR-PAR-012 | **Entity pages** for people, projects and places the user names:<br>- consolidation unit for facts;<br>- visible and editable in the Zentrale;<br>- never created from untrusted content without approval | S | AURA-127 | unit, eval |
| FR-PAR-013 | **Transparency**: an answer shows which memories it used ("Genutzt: …"), plus an action "ohne Personalisierung neu beantworten" | S | AURA-126 | e2e |
| FR-PAR-014 | Procedures as skills that Aura proposes itself | S | AURA-102 | eval |

### 3.3 Background and scheduled tasks

| ID | Requirement | Prio | Story | Verify |
|---|---|---|---|---|
| FR-PAR-020 | Task scheduler in the app:<br>- one-off, recurring (RRULE) and event-triggered tasks;<br>- stored in SQLite;<br>- runs headless through the agent;<br>- at most 3 run in parallel, each with a token/step budget | M | AURA-120/121 | unit, contract |
| FR-PAR-021 | **Pause at approval**:<br>- a background run that needs T2 waits;<br>- the approval appears as an OS notification and in an inbox in the panel/Zentrale;<br>- after a timeout the task ends without the action | M | AURA-122 | contract |
| FR-PAR-022 | Event triggers via connector polling, e.g. new mail from X or a new Jira ticket; the polling interval is per trigger | S | AURA-123 | contract |
| FR-PAR-023 | "Tagesbriefing": an opt-in morning summary of weather, calendar, mail and tickets as a scheduled task | C | AURA-123 | eval |
| FR-PAR-024 | Task list in the Zentrale: planned, running, waiting for approval and finished tasks, each with its log and a stop button | M | AURA-122 | e2e |

### 3.4 Browser like the user

| ID | Requirement | Prio | Story | Verify |
|---|---|---|---|---|
| FR-PAR-030 | **Takeover**: tool `request_takeover(reason)`.<br>- It brings the browser to the front and shows a banner in the panel.<br>- The agent waits for "Weiter" or "Abbrechen".<br>- Rule: login without stored credentials, CAPTCHA, payment step → takeover, never solve.<br>- Content after the takeover stays untrusted. | M | AURA-118 | eval `captcha-takeover`, contract |
| FR-PAR-031 | **Secure credential filling**: `browser_fill_secret(element, secret)`.<br>- The value comes from the vault and is filled in the main process; the model sees only the name.<br>- A secret is filled only on its stored origin.<br>- T2; password fields are masked in snapshots. | M | AURA-124 | unit, contract (secret never in model context or audit) |
| FR-PAR-032 | **Origin sets per task**:<br>- A trusted function fixes at task start which origins are read-only and which read-write.<br>- New origins need a deterministic check or approval.<br>- Iframes from other origins are hidden. | S | AURA-125 | unit, eval |
| FR-PAR-033 | **Metadata-only critic**:<br>- Before each consequential browser action, a small model call sees only the task, action, element label and origin, never page content.<br>- Its answer is allow or veto; after repeated vetoes, control goes to the user. | S | AURA-125 | eval (injection pages) |
| FR-PAR-034 | **Sensitive sites** (banking, health, government; a deterministic list, extendable by the user) always need confirmation for every action | M | AURA-125 | unit |
| FR-PAR-035 | The browser specialist gets **no JavaScript evaluation and no DevTools** (Playwright MCP `--caps`) and observes through accessibility snapshots | M | AURA-125 | unit (configuration) |
| FR-PAR-036 | **The user's own browser** (optional): a Chrome extension bridge.<br>- Aura acts in the user's real Chrome profile with the user's sessions.<br>- Only after consent per site, visibly; the same tiers and critic apply.<br>- No access to the password manager. | C | AURA-129 (needs refinement) | e2e |

### 3.5 Safety and trust

| ID | Requirement | Prio | Story | Verify |
|---|---|---|---|---|
| FR-PAR-040 | **Scoped grants**:<br>- An approval can apply once, for this task, for this session, for N hours, or always.<br>- It is bound to the tool plus connector or origin plus action.<br>- Later calls must match the scope exactly. | M | AURA-119 | unit, contract |
| FR-PAR-041 | Approvals are only possible in Aura's own UI (panel, notification, Zentrale), never through chat text. Text in the chat that claims an approval has no effect. | M | AURA-119 (check existing) | eval (injection) |
| FR-PAR-042 | Mail connectors filter one-time codes, password-reset links and magic login links out of results before the model sees them | M | AURA-130 (under AURA-98) | unit |
| FR-PAR-043 | Websites that block agents: Aura says so honestly and offers a connector or API. No retries with tricks. | M | AURA-118 (part of 030) | eval |

## 4. Non-functional requirements

- **NFR-PAR-001: local models first.**
  - Reflection, critic and recall run with the local model (gemma4:26b) in reasonable time:
    - critic under 1.5 s per action;
    - reflection asynchronous, not blocking the answer.
- **NFR-PAR-002: privacy.**
  - Every new external endpoint is listed in `docs/security/privacy.md`.
  - Background tasks and learning respect pause, incognito and deletion (cascade per chat).
- **NFR-PAR-003: honest limits.** Background tasks do not run while the computer is off or asleep. The task list
  says so.
- **NFR-PAR-004: evals.**
  - Every story brings eval tasks.
  - The full suite must stay at pass^3 ≥ 95 % with 0 unsafe actions.

## 5. Delivery plan (stories under AURA-115; existing AURA-91 stories are linked)

Order by value and dependencies:

1. AURA-116 location and weather (done in PR #50), AURA-117 device location.
2. **Browser takeover and CAPTCHA rule** (FR-PAR-030, 043). Small, and closes the most painful gap.
3. **Scoped grants and approvals outside the chat** (FR-PAR-040, 041). Prerequisite for background work.
4. **Background and scheduled tasks** (FR-PAR-020–024), in 3 PRs:
   - scheduler and runner;
   - approval inbox and notifications;
   - event triggers and briefing.
5. **Learning with consolidation** (AURA-99 extended by FR-PAR-010) and **hybrid recall** (AURA-100 extended by
   FR-PAR-011).
6. **Secure credential filling** (FR-PAR-031) plus the **mail OTP filter** (FR-PAR-042, under AURA-98).
7. **Browser safety layers** (FR-PAR-032–035).
8. **Transparency** (FR-PAR-013) and **entity pages** (FR-PAR-012).
9. **Places and home/work** (FR-PAR-003).
10. Later: **own-browser extension bridge** (FR-PAR-036); watch WebMCP and Web Bot Auth.

## 6. Open questions for the maintainer

- **Q1.** Should background tasks also run when Aura's window has never been opened since login? Proposal: yes, as
  long as Aura runs in the tray.
- **Q2.** The extension bridge (FR-PAR-036) means a Chrome Web Store listing and Google's review. Is this wanted, or
  is the visible Aura browser profile with a one-time sign-in enough?
