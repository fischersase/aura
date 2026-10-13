# Contributing to Aura

Thanks for helping! Bug reports, ideas and pull requests are welcome.

## Before you start

- **Bugs and ideas:** open an [issue](https://github.com/fischersase/aura/issues/new/choose) first, so we can agree on the
  approach before you spend time on code.
- **Security problems:** never as a public issue, see [SECURITY.md](SECURITY.md).
- Aura's user interface and code comments are German; issues and pull requests may be in German or English.

## Development setup

You need [Node.js](https://nodejs.org) 22+, [uv](https://docs.astral.sh/uv/) and, for the agent with a real model,
[Ollama](https://ollama.com).

```bash
git clone https://github.com/fischersase/aura.git && cd aura
npm ci --ignore-scripts && node scripts/vendor.js && node node_modules/electron/install.js
(cd agent && uv sync)
npm start
```

Linux tests also use `xvfb dbus gsettings-desktop-schemas libglib2.0-bin at-spi2-core python3-gi gir1.2-gtk-3.0
gir1.2-atspi-2.0` (see `.github/workflows/ci.yml`).

## Checks (the same as CI)

```bash
npm run check && npm run lint && npm run typecheck && npm test   # app (JavaScript) and the bridge to the agent
cd agent && uv run ruff format --check src tests spikes evals && uv run ruff check src tests spikes evals \
  && uv run pyright && uv run pytest -q                           # agent: format, lint, unit, harness, contract tests
```

Python follows PEP 8 with 4 spaces (ADR 0017); `cd agent && uv run ruff format src tests spikes evals` formats it.
Mechanical reformatting commits are listed in `.git-blame-ignore-revs`; GitHub skips them in blame views, and locally
`git config blame.ignoreRevsFile .git-blame-ignore-revs` does the same.

Changes to the agent's behaviour (prompts, tools, guard) should also pass the desktop eval suite with a real model:
`cd agent && uv run python -m evals.desktop.run --k 3 --num-ctx 32768` (see [ADR 0008](docs/adr/0008-eval-suite.md)).
Prompt growth has caused regressions before; prefer mechanisms in the guard over more prompt text.

## Pull requests

Every issue follows the [working agreement](docs/engineering/working-agreement.md): an issue must be *ready*
(goal, evidence, scope, numbered acceptance criteria, test approach) before work starts, and a pull request
must be *done* (criteria proven, tests and evals green on all platforms, docs updated) before it is merged.

- Branch from `main`, one topic per pull request, with tests for new behaviour.
- `main` is protected: pull request required, all checks green (CI on Linux and Windows, CodeQL, secret scan),
  linear history (squash merge).
- Every merge to `main` that touches the app builds a release (`.github/workflows/release.yml`). Bump `version` in
  `package.json` when your change should ship as a new version.
- Architecture decisions go into `docs/adr/` (context, decision, evidence, consequences).
- Never commit secrets, API keys or personal data. Every push is scanned with gitleaks.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
