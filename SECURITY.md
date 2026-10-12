# Security policy

Aura runs commands, reads files and controls programs on your computer, so security reports are very welcome.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub:
[Security → Report a vulnerability](https://github.com/fischersase/aura/security/advisories/new).

Include what you did, what happened and, if possible, a minimal way to reproduce it. You will get an answer within
7 days. Fixes are released as a new version and credited in the advisory unless you prefer otherwise.

## Supported versions

Only the latest release gets security fixes. Update with `sudo apt update && sudo apt upgrade` (Linux) or the newest
`Aura-Setup.exe` (Windows).

## What counts

Especially interesting:

- Ways to make the agent run a consequential action (tier T2) **without asking**, or a forbidden one (tier T3) at all,
  for example through prompt injection from web pages, files, programs or MCP servers.
- Ways to read credentials or keys stored by Aura (`secrets.json`, API keys) or the paths Aura protects.
- Access to the local Zentrale web page from other websites or other machines.
- Problems in the release chain: installers, the apt repository and its signing key, GitHub Actions.

The safety model is described in [README → Safety](README.md#agent-aura-acts-on-your-pc) and in
[docs/adr/0003](docs/adr/0003-approvals-in-the-harness.md).
