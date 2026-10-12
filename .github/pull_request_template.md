## What and why

<!-- What does this change, and which issue does it address? -->

## How it was tested

- [ ] `npm run check && npm test`
- [ ] `cd agent && uv run ruff check src tests spikes evals && uv run pytest -q`
- [ ] Desktop evals with a real model (only for changes to prompts, tools or the guard)
- [ ] Tried it in the app (describe below)

## Safety

- [ ] No secrets, keys or personal data in the diff
- [ ] New or changed tools have a tier (T0–T3) and verify their result
