# Needs analysis

Status: draft for review (AURA-27) · Last updated: 2026-10-12

Needs describe *what stakeholders must be able to achieve*, independent of the solution. Each need has an ID
(N-xx) that system requirements reference. Personas are defined in [stakeholders.md](stakeholders.md).

- **Kano:** B = basic (expected; absence causes dissatisfaction), P = performance (more is better), D = delighter.
- **MoSCoW** for the next major version: Must, Should, Could, Won't (now).

## Jobs, pains and gains per persona

| Persona | Jobs to be done | Pains | Gains |
|---|---|---|---|
| P1 everyday user | Find and open documents; change settings; play/pause media; write short texts; get answers about what is on screen | Doesn't know where settings are; afraid of breaking things; English-only tools | Says it once, it happens; clear "done" with proof; German and English |
| P2 power user | Bulk file operations; window/app automation; run commands; browser tasks; extend with own tools | Opaque agents; slow cloud round-trips; tools that can't be scripted | Transparent steps, rules, hooks, MCP, skills; fast local models; audit log |
| P3 privacy-first | Same as P1/P2 without the cloud | Telemetry, unclear data flows | Works offline; proof of data flows; nothing leaves unless chosen |
| P4 macOS user | Same as P1 on macOS | Permission chaos | Guided permissions, native integration |
| P5 accessibility | Operate the computer by voice and keyboard | Mouse-only UIs, unlabeled controls | Full voice control with spoken feedback; screen-reader friendly UI |
| P6 voice multitasker | Quick spoken requests and answers | Must return to keyboard | Short spoken answers; approvals that are easy to give or that wait safely |

## Needs

### Getting things done

| ID | Need | Personas | Kano | MoSCoW |
|---|---|---|---|---|
| N-01 | Ask in natural language (typed or spoken) and have everyday desktop tasks done: files, programs, windows, media, volume, settings | P1–P6 | B | Must |
| N-02 | Have multi-step and bulk tasks planned, shown and confirmed before they run | P1, P2 | P | Must |
| N-03 | Get information from the web and from what is on screen, with sources | P1, P2, P6 | P | Must |
| N-04 | Operate desktop programs that have no API (buttons, fields, dialogs) | P1, P2, P5 | P | Should |
| N-05 | Dictate text into any program and into the chat; long dictation with pauses | P1, P5, P6 | P | Must |
| N-06 | Talk to Aura in a continuous voice conversation | P5, P6 | D | Should |
| N-07 | Extend Aura with own tools (MCP), skills and standing instructions | P2 | P | Must |
| N-08 | Aura remembers stable facts about the user and earlier tasks, and the user can see and edit them | P1, P2 | D | Should |

### Safety, control and honesty

| ID | Need | Personas | Kano | MoSCoW |
|---|---|---|---|---|
| N-10 | Nothing consequential (delete, overwrite, send, buy, install, change system settings) happens without explicit approval that explains the effect | All | B | Must |
| N-11 | Some things never happen, whatever is asked or injected (credentials, security settings, wiping the system) | All | B | Must |
| N-12 | Content from websites, files, programs or tools cannot take control of Aura (prompt injection) or leak data | All | B | Must |
| N-13 | Stop anything immediately (emergency stop) | All | B | Must |
| N-14 | Know whether a reported result was actually checked; failures are reported honestly | All | B | Must |
| N-15 | See afterwards what Aura did (audit), and set own rules (always allow / always ask / never) | P2, P3 | P | Must |
| N-16 | Secrets (API keys, tokens) are stored securely and never appear in logs, URLs or answers | All | B | Must |

### Privacy

| ID | Need | Personas | Kano | MoSCoW |
|---|---|---|---|---|
| N-20 | Use Aura fully without sending data to the cloud | P3, P2 | B (for P3) | Must |
| N-21 | Know exactly which data goes where, and decide when screen, microphone or cloud is used | P1, P3 | B | Must |
| N-22 | Export and delete everything Aura stored (chats, memory, audit) | P3 | P | Should |
| N-60 | Ask about my own mail, calendar, files, chats and tickets and get correct answers ([spec](../specs/personal-agent.md)) | P1, P2, P6 | P | Must |
| N-61 | Aura remembers what I told it and what it learned about me; I can see, correct and delete all of it | All | B | Must |
| N-62 | Aura gets better over time: reuses procedures that worked, avoids mistakes I corrected | P1, P2 | D | Should |
| N-63 | When Aura cannot do something, it tells me which integration would help and sets it up with me | P1, P2 | D | Should |
| N-64 | My API keys, tokens and sign-ins are stored safely in one place; I see which service uses what and can revoke it | All | B | Must |
| N-23 | Keep cloud costs under control (budget) | P1, P2 | P | Must |

### Platforms, access and language

| ID | Need | Personas | Kano | MoSCoW |
|---|---|---|---|---|
| N-30 | Use Aura on Linux (X11 and GNOME Wayland), Windows and macOS with the same features | P1–P4 | B | Must (macOS: Should for the first release with it) |
| N-31 | Use Aura in English or German, matching the system language | P1, P4 | B | Must |
| N-32 | Use every function by keyboard and with a screen reader; reduced motion | P5 | B | Must |
| N-33 | Choose a model that fits the hardware; Aura recommends one that is known to work safely | P1, P2, P3 | P | Must |
| N-34 | Start quickly and respond quickly | All | P | Should |

### Installation, updates and trust

| ID | Need | Personas | Kano | MoSCoW |
|---|---|---|---|---|
| N-40 | Install with the platform's normal mechanism (apt, installer, Homebrew, winget) without technical knowledge | P1, P4 | B | Must |
| N-41 | Receive updates automatically or with the platform's normal update command; be told about new versions | All | B | Must |
| N-42 | Verify that a download is genuine (signature, checksum, provenance) | P2, P3, store operators | P | Must |
| N-43 | Diagnose problems without technical knowledge (system check, clear error messages, exportable diagnostics) | P1 | P | Should |
| N-44 | Aura keeps working when something is missing (no model, no network, no permission) and says what to do | All | B | Must |

### Project and ecosystem needs

| ID | Need | Stakeholders | MoSCoW |
|---|---|---|---|
| N-50 | Understand the architecture and contribute within a day (English docs, setup in one command, fast feedback from CI) | Contributors | Must |
| N-51 | Report vulnerabilities privately and see them fixed and credited | Security researchers | Must |
| N-52 | Maintain the project with little manual work (automated tests, releases, dependency updates) | Maintainer | Must |
| N-53 | Packages comply with channel policies (lintian, notarization, winget/Homebrew rules, signing policy) | Store operators | Must |
| N-54 | Use third-party APIs, models and trademarks within their terms | Google, model licensors | Must |
| N-55 | Comply with GDPR and EU AI Act transparency duties | Regulators, users | Must |

## Traceability

Every system requirement in [system-requirements.md](../requirements/system-requirements.md) lists the needs
it serves. Needs without a requirement are gaps; requirements without a need are questioned in review.
