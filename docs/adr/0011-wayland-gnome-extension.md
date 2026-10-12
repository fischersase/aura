# 0011 Windows under GNOME Wayland via our own Shell extension

Status: accepted

## Context

Under Wayland, no app can see or control other apps' windows. GNOME's own interface `org.gnome.Shell.Introspect` is locked without "unsafe mode". xdotool and EWMH only see Xwayland windows under Wayland.

## Decision

- **Extension:** `gnome-extension/aura-bridge@aura` (GNOME 45–49, ESM).
  - Offers exactly five functions on the session D-Bus: `ListWindows`, `Activate`, `Minimize`, `Maximize`, `Close`.
  - No reading of window content, no input.
- **Agent:** `platform/gnome_wayland.py` uses the extension when `XDG_SESSION_TYPE=wayland`.
  - The tools `list_windows`, `window_action` and `launch_app` (window verification) run through a shared window layer for X11 and Wayland.
  - Wayland window IDs start with `w`.
- **Installation:** the Linux package ships the extension. Under Wayland, the system check in the Zentrale (control center) offers „Installieren“ (Install): it copies the extension to `~/.local/share/gnome-shell/extensions` and enables it with `gnome-extensions enable`. Then log out and back in once.
- **Other paths under Wayland:**
  - Screenshots: via Electron's screen sharing.
  - Apps: via AT-SPI, which works under Wayland (actions instead of coordinates).
  - Mouse and keyboard (fallback): via the v1 input with ydotool.

## Evidence

**Test:** `agent/tests/wayland/` starts an invisible, isolated GNOME Shell 46 (`gnome-shell --headless --wayland`, own D-Bus, own settings) with the extension and a native Wayland GTK window. The real agent tools list, minimize, focus, maximize and close the window, each verified.

**Run:** green locally. Skipped in GitHub CI because no GNOME Shell is installed there.

**Pitfall:** in a terminal from the VS Code snap, outdated GNOME schemas come before the real ones (`XDG_DATA_DIRS`, `GSETTINGS_SCHEMA_DIR`). This crashed GNOME Shell and explained the seemingly missing `color-scheme`. The test therefore starts with an empty environment (`env -i`).

## Open questions

- Mouse and keyboard under GNOME Wayland go through ydotool; the RemoteDesktop portal with stored consent would be cleaner.
- Not yet tried on the user's real Wayland desktop (their working session is X11 via Chrome Remote Desktop).
