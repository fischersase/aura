# Product vision

Status: draft for review (AURA-25) · Owner: maintainer · Last updated: 2026-10-12

## Problem

Using a computer still means knowing *where* things are and *how* each program works: which setting hides
the dark mode, which folder holds last month's invoices, how to pause the music that a browser tab is
playing. Today's AI assistants fall into two groups, and neither solves this:

- **Chat assistants** answer questions but do not act. The user still has to click through every step.
- **Agents** act, but usually in the cloud, with broad permissions, and they often *claim* success without
  checking it. Screen contents, files and voice leave the device by default.

People want to *ask* their computer to do things, and trust that it does exactly that: nothing more,
nothing behind their back, and honestly reported.

## Vision

> **Aura is the assistant you talk to instead of operating your computer. It does what you ask — safely,
> verifiably and privately by default.**

You press a hotkey or speak. Aura understands the request, plans, uses the computer's own programs and
settings, checks the result and tells you honestly what happened. Anything consequential waits for your OK.
It runs entirely on your machine with open models, or with Google Gemini if you choose to.

## Goals

| ID | Goal | Measured by (target) |
|---|---|---|
| G1 | **Useful.** Everyday desktop tasks (files, programs, windows, media, settings, web look-ups, dictation) get done by asking. | Desktop eval suite with the default local model: pass^3 ≥ 95 %; median task time ≤ 5 s |
| G2 | **Safe.** No consequential action without the user's approval; forbidden actions never happen. | 0 unsafe actions in evals; 0 successful attacks in the prompt-injection suite; no open high-severity security issue older than 7 days |
| G3 | **Honest.** Success is only reported when a check confirms it. | 0 false success claims in the honesty eval category; every changing tool verifies its effect |
| G4 | **Private by default.** Full functionality locally; cloud only by explicit choice; no telemetry. | Local mode works offline after model download; no network traffic except to hosts the user chose |
| G5 | **For everyone.** Linux, Windows and macOS; English and German; accessible; usable by voice. | Supported platforms pass the same E2E suite; WCAG 2.2 AA for all windows; every feature reachable by keyboard and voice |
| G6 | **Trustworthy delivery.** Installing and updating is one step per platform, and every build can be verified. | Signed packages on all platforms; provenance attestation for every release asset; `apt install aura` / winget / Homebrew |
| G7 | **Healthy project.** Contributors become productive quickly; quality gates catch regressions. | Onboarding ≤ 1 day; CI green on all platforms before merge; OpenSSF Scorecard ≥ 8 |

## Non-goals

- **No cloud service and no accounts.** Aura is a desktop application; there is no Aura server that sees user data.
- **No telemetry, ads or training on user data.** Crash reports, if ever added, are opt-in and inspected by the user first.
- **Not an unattended autonomous system.** Aura works for the user while they are present; consequential steps
  always need their approval, also for long tasks.
- **Not a coding agent or IDE replacement.** Developers use dedicated tools; Aura helps with the computer around them.
- **No mobile platforms, no Flatpak.** The Flatpak sandbox prevents desktop control by design (see ADR 0018).
- **No enterprise fleet management** in the first major version (central policy distribution may come later).

## Product principles

1. **Safety before convenience, enforced in code.** Models can be manipulated; therefore approvals, forbidden
   actions and data-exfiltration checks live in the harness, not in the prompt.
2. **Local first.** Everything works with local models. Data leaves the computer only to services the user
   picked, and the app says so.
3. **Verified, not claimed.** Every changing action checks its result; the UI shows whether a result was verified.
4. **The user stays in control.** Approvals with clear effects, an emergency stop, editable rules, a readable
   memory and a tamper-evident audit log.
5. **Least privilege, least data.** Each window, tool and process gets only what it needs; secrets never reach
   renderers, URLs or logs.
6. **Transparent.** Open source, documented decisions (ADRs), reproducible and attested builds.
7. **Accessible and multilingual from the start.** Not a later add-on.
8. **Boring reliability.** Predictable behaviour, graceful failure with a clear message, no silent fallbacks.

## Capabilities (today and planned)

| Capability | Today (v0.11) | Planned |
|---|---|---|
| Chat panel with optional screenshot | ✓ | i18n EN/DE, accessibility |
| Voice input in chat (local Whisper or Gemini) | ✓ | |
| Live voice mode (Gemini Live; local variant) | ✓ | |
| Rambler dictation into any text field | ✓ | |
| Agent: files, programs, windows, media, volume, settings, shell, browser, desktop apps via accessibility, MCP, skills, memory | ✓ Linux, Windows | macOS (AURA-10) |
| Approvals T0–T3, rules, hooks, audit log, emergency stop | ✓ | stricter IPC and permission model (M1/M3) |
| Zentrale (management UI, also in the browser) | ✓ | |
| Install and update | .deb + apt source, AppImage, Windows installer | `apt install aura`, signed installers, winget, Homebrew, in-app update notice (M4/M5) |

## Related documents

- [Stakeholders](stakeholders.md) · [Needs](needs.md) · [System requirements](../requirements/system-requirements.md)
- [System context](../architecture/context.md) · [Threat model](../security/threat-model.md) · [ADRs](../adr/README.md)
