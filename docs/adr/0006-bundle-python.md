# 0006 The Python runtime is bundled

Status: accepted

## Context

The sidecar needs Python 3.12 and the ADK dependencies. Users should not have to install anything, and Aura should start offline.

## Decision

- CI fetches python-build-standalone 3.12 (variant `install_only_stripped`, sha256 pinned).
- It installs the locked dependencies from `agent/uv.lock` with `--require-hashes` and the `aura_agent` wheel.
- The test suite, IDLE and tkinter are removed.
- The result goes into electron-builder `extraResources/python`.
- The AT-SPI helper runs with the system Python (`python3-gi`, `gir1.2-atspi-2.0`; a dependency in the .deb).

Rejected: `uv sync` on first start. It needs network, is slow and can fail on users' machines.

## Evidence (P0)

- Python 3.12.13 standalone plus all dependencies: 171 MB unpacked, **35 MB** as tar.xz. The .deb grows from 104 MB to about 140 MB.
- `site-packages` of the dependencies: 77 MB.

## Consequences

- CI checks a size limit, initially 200 MB unpacked. Since P3 the limit is **230 MB**: MCP SDK, dbus-fast and python-xlib brought the bundle to 200 MB. The .deb is now 153 MB (including the 19 MB browser server).
- The release job builds the sidecar and runs `aura-agent --selftest` before the package is created.
