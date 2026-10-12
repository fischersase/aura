# 0005 Perception: API before AT-SPI before browser DOM before pixels

Status: accepted

## Context

Agent v1 operated YouTube Music via estimated pixel clicks: 8 clicks in 50 s, wrong song, and pausing skipped to the next song. Local models recognize screen content worse than Gemini.

## Decision

Tools always use the most reliable path available:

1. **Programmatic interfaces:** shell, D-Bus, MPRIS for media, gsettings, file system.
2. **Accessibility tree (AT-SPI)** for desktop apps. Actions (`doAction`, setting text) are preferred over coordinates. Under Wayland, AT-SPI coordinates are unreliable.
3. **Browser via the DevTools protocol:** Playwright MCP with its own profile; „Mein Chrome benutzen“ (Use my Chrome) as an opt-in via chrome-devtools-mcp.
4. **Screenshot with pixel input** only as a last resort.

## Evidence (P0, on the user's machine, X11 session :20)

- **MPRIS:** Chrome reports YouTube Music as `org.mpris.MediaPlayer2.chromium.instance…` with title „un x100to“, artist „Grupo Frontera und Bad Bunny“, status `Paused`. Pausing and skipping thus work without a click and can be verified.
- **AT-SPI:** 24 apps visible (Nautilus, Text Editor, VS Code, Aura, Chrome …), even though `toolkit-accessibility` is off.
- **Chrome via AT-SPI:** only 4 empty nodes, because accessibility is not active in the browser. Web pages therefore go through the DevTools protocol, not AT-SPI.

## Consequences

- P2 adds the tools `media_status`/`media_control` (MPRIS), windows via EWMH (X11) and `launch_app` with window verification.
- P3 adds AT-SPI snapshot and actions, the browser specialist and the Wayland paths (GNOME extension, RemoteDesktop portal).
- The Wayland portal and GNOME extension could not be tested in P0 because the working session is X11 via Chrome Remote Desktop. This is a risk for P3.
