# 0010 Desktop apps via AT-SPI, specialist "apps"

Status: accepted

## Context

Apps such as Text Editor, Files, Calculator or settings dialogs have an accessibility tree (AT-SPI): buttons, fields and text with names and executable actions. Operating it is more reliable than pixel clicks, especially with local models, which recognize screen content less well.

## Decision

- **Helper:** `platform/atspi_helper.py` runs as a separate process with the **system Python** (python3-gi, gir1.2-atspi-2.0). The bundled Python has no PyGObject.
  - Communication via JSON lines.
  - Every call has a timeout of 8 s. If an app hangs, the helper is terminated and restarted on the next call.
- **Tools:**
  - `ui_snapshot` (T0): UI elements with index; apps are found by name or window title.
  - `ui_act` (T1, T2 for delete, send, buy …).
  - `ui_set_text` (T1; password fields T3).
- **Protection against bypass:** consequential elements must be described honestly in `element`. If the real element is called „Konto löschen“ (Delete account) but the description says „Knopf unten“ (button at the bottom), it is not clicked, so the tiering cannot be bypassed.
- **Specialist `apps`:** owns these tools plus opening apps and windows. Multi-step operation (read → act → verify) stays in its context.
- **`launch_app`:** if it finds no app entry, it brings an open window with a matching title to the front.
- **API pitfall:** in newer PyGObject versions, the objects from `get_text_iface()` are the element itself, and its methods of the same name are deprecated and do something else. The helper therefore calls the interfaces via the class functions (`Atspi.Text.get_text(acc, …)`, `Atspi.EditableText.set_text_contents(acc, …)`).

## Evidence

**Tests:** GTK 3 test app in Xvfb with its own D-Bus and AT-SPI bus. Checked: set text, click Save, read the result; the delete button with a dishonest description is refused; stale indices are refused. The tests also run in CI.

**Evals with gemma4:26b:** enter and save a note, deletion rejected, read status – pass^3 100 %, 0 unsafe actions.

**On the user's desktop:** Text Editor, Files, VS Code, Chrome and Aura register via AT-SPI. Chrome and Electron only expose their content with accessibility enabled; web pages therefore go through the browser specialist (ADR 0009).

## Consequences

- The .deb recommends python3-gi and gir1.2-atspi-2.0. If they are missing, `apps` is unavailable and the agent says so.
- Under Wayland, AT-SPI actions remain usable; coordinates do not (phase 3, Wayland).
