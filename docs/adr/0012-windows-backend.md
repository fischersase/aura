# 0012 Windows backend: same tools, separate platform layer, installer instead of portable .exe

Status: accepted

## Context

Phase 7 brings Agent v2 to Windows. Tools, tiers, checks and evals should stay the same as on Linux. Only the platform layer is swapped. Windows lacks everything the Linux backend builds on: X11/EWMH, D-Bus (MPRIS), AT-SPI, gsettings, gio and bash.

## Decision

- **Tools stay the same.** Name, tier logic and verification of each tool remain unchanged. Inside the tool, `platform.base.IS_WINDOWS` decides. Only `settings` and `dark_mode` are separate functions (`tools/win_settings.py`), because their arguments differ (registry instead of gsettings).

| Area | Linux | Windows |
|---|---|---|
| Windows | X11 EWMH (`platform/x11.py`), Wayland extension | user32 via ctypes (`platform/win32.py`): windows as in the taskbar; UWP apps via the child window of their ApplicationFrameHost |
| Apps | `.desktop` files | Start menu: `Get-StartApps` (including Store apps) and shortcuts (`platform/win_apps.py`); launch via the shortcut or `shell:AppsFolder\<AppID>` |
| UI elements | AT-SPI helper with system Python | UI Automation helper with the agent Python (`platform/uia_helper.py`, comtypes) |
| Media | MPRIS (D-Bus) | System Media Transport Controls (`platform/win_media.py`, pywinrt) |
| Volume | pactl | Core Audio (`platform/win_audio.py`, pycaw) |
| Settings | gsettings | user registry (`platform/win_registry.py`) |
| Trash | `gio trash` | `SHFileOperationW` with `FOF_ALLOWUNDO`, only on fixed drives (`platform/win_shell.py`) |
| Shell | bash, `classify_bash` | PowerShell 5.1, `classify_powershell` |
| Processes | process group, `killpg` | own process group without a console window, `taskkill /T` (`platform/proc.py`) |

- **UI elements** go through a helper with the same line protocol and the same role names as AT-SPI ("push button", "entry", "password text" …). As a result, `ui_snapshot`, `ui_act` and `ui_set_text` work the same on both systems, with their tiers (consequential buttons T2, password fields T3).
  - The helper runs as a separate process so that a hanging app only blocks the helper.
  - `Invoke` can block until a modal dialog is closed. It therefore runs in a thread with a 3 s deadline. After that, the action counts as triggered.
- **PowerShell tiering** follows the same principle as bash: only what is on a fixed list counts as read-only. PowerShell, however, can also execute things outside command names. Therefore, additionally:
  - Quoted strings are removed before the check; `"$(…)"` asks.
  - Outside strings, `; & \` # < > = ( ) [ ] :: $( @( @{` and method calls ask.
  - Script blocks may only contain comparisons on `$_`.
  - `-EncodedCommand`, Defender, firewall, ExecutionPolicy, credentials and deleting a drive, Windows or the user folder are T3.
  - Aura itself starts commands as `-EncodedCommand` with UTF-8 output. The command itself is what gets tiered.
- **stdin** is read in a separate thread, on both systems. Reason: `loop.connect_read_pipe` is not reliable on Windows with the pipe inherited from Electron.
- **Distribution:** per-user NSIS installer (`Aura-Setup.exe`), without administrator rights. Python and the browser server are bundled as on Linux (`scripts/build-agent.sh` also runs in Git Bash).
  - The portable .exe is dropped because it would have to unpack about 200 MB of Python on every start.
  - Updates: run the new installer. Settings in `%APPDATA%\Aura` are preserved.
- **Browser:** Chrome in the default locations, otherwise Edge (`--browser msedge`), which is always present on Windows.

## Evidence

- **Windows tests:** `agent/tests/windows/` run in CI on `windows-latest` against real windows: a Win32 test app (`testing/win_app.py`) and a real Start menu shortcut. Checked:
  - List, minimize, focus and close windows.
  - Launch an app from the Start menu, with window verification.
  - UI Automation: fill a field and press a button, verified; a consequential button needs an honest description.
  - PowerShell with umlauts and timeout including the process tree.
  - Trash, dark mode and registry.
  - Self-test of the whole agent.
- **Other tests:** the rest of the suite (harness, rules, context, protocol) runs there as well.
- **Classifier:** `tests/unit/test_powershell_classifier.py` covers about 120 cases: read-only, ask, blocked.
- **Installer:** the workflow `windows-build.yml` builds it on the branch and checks bundle size and the self-test in the finished bundle.

## Open questions

- **Evals on Windows:** the eval suite (0008) only has a Linux environment (Xvfb, D-Bus). A Windows environment needs a Windows machine with a GPU for Ollama, i.e. yours. Until then, the Windows contract tests secure the backend; model quality is not measured there.
- **Not checked in CI:** media control (SMTC) and volume. The runner has neither a player nor an audio device; there it is only checked that nothing crashes.
- **Signing:** the installer is unsigned; SmartScreen warns on first start.
