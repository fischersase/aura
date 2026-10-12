# Working agreement: Definition of Ready, Definition of Done

Status: accepted (AURA-32) · Applies to every Jira issue in project AURA and every pull request.

These rules let anyone — a human contributor or an AI coding agent — pick up an issue and finish it without
guessing. An issue that is not *ready* is refined first; a pull request that is not *done* is not merged.

## Definition of Ready (before work starts)

An issue is ready when its description contains all of the following:

1. **Goal** — one or two sentences: what changes for the user or the project, and why.
2. **Context with evidence** — the current behaviour with file paths and line numbers (`src/main.js:1122`),
   links to the requirement IDs (FR-/NFR-/N-) and ADRs it relates to.
3. **Scope** — the files or modules expected to change, and an explicit *out of scope* list.
4. **Acceptance criteria** — numbered, each one checkable by a test, an eval or an observable result.
   No "should be better"; instead "X returns T2 for Y".
5. **Test approach** — which test level proves each criterion (unit, contract, harness, E2E, eval, container
   install) and on which platforms.
6. **Decisions made** — no open architecture question. If one exists, it becomes its own issue (ADR) first.
7. **Size** — fits one pull request (roughly ≤ 400 changed lines excluding generated files and tests).
   Larger work is split into sub-tasks.
8. **Risk label** — `security`, `privacy`, `legal` or `area-packaging` when relevant, so reviewers and agents
   apply the extra checks below.

Issues created as placeholders carry the label `needs-refinement` until they meet this definition.

## Definition of Done (before merge)

A pull request is done when:

1. **Acceptance criteria met** — each one is ticked in the PR description with the proof (test name,
   command output, eval result).
2. **Tests** — new behaviour has tests at the lowest sensible level; bugs get a regression test that failed
   before the fix. All required checks are green on every platform (Linux, Windows; macOS once supported):
   CI, CodeQL, secret scan, packaging tests when packaging changed.
3. **No silent regressions** — changes to prompts, tools, the guard or model handling pass the desktop eval
   suite with the recommended local model: 0 unsafe actions, success not lower than the last recorded run
   (`cd agent && uv run python -m evals.desktop.run --k 3 --num-ctx 32768`).
4. **Security and privacy** — no secrets or personal data in code, tests or logs (test secrets are assembled
   at runtime); new tools have a tier (T0–T3) and verify their effect; new IPC/RPC surface validates its
   input and sender; threat model and privacy docs updated when trust boundaries or data flows change.
5. **Docs** — user-visible changes in README or docs; architecture changes in an ADR; requirement and
   traceability updated.
6. **Code quality** — follows the style of the surrounding code and, once enforced, the linters and type
   checkers (AURA-33); English for new comments and docs (ADR 0013).
7. **Commit and PR** — Conventional Commit title with the issue key, e.g. `fix(agent): … (AURA-13)`;
   description says what, why and how it was tested; squash merge.
8. **Jira** — issue moved to *Erledigt* with a comment linking the PR; follow-ups found on the way are filed
   as new issues instead of being silently fixed or forgotten.

## Who merges

Pull requests are merged as soon as all required checks are green (maintainer decision, 2026-10-12).
Branch protection on `main` (`.github/rulesets/main.json`) enforces the checks; nobody bypasses it.

## Model guidance for AI agents

- Refinement to *ready*, specifications, ADRs, security-relevant changes and cross-cutting refactors:
  use the most capable model available.
- Issues that are *ready* with precise acceptance criteria can be implemented by a faster model; the
  Definition of Done and the CI gates stay the same.
