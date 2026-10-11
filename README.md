# Gemini Overlay for Windows

Gemini the way it works on a Googlebook: a glowing screen edge, a small rounded Gemini window in the corner, Gemini Live that sees your screen and points where to click, and Rambler dictation in any text field.

## Install

1. Download **`GeminiOverlay.exe`** from the [latest release](https://github.com/fischersase/windows-gemini/releases/latest).
2. Run it. Windows SmartScreen may warn because the file is unsigned: click **More info → Run anyway**.
3. The setup assistant opens and walks you through the API key and budget.

The app lives in the system tray (star icon). Right-click it for settings, or start "Gemini Overlay" again from the Start menu.

## API key (no Google Cloud project needed)

1. Open [Google AI Studio → API keys](https://aistudio.google.com/apikey) and click **Create API key**. AI Studio creates a project for you.
2. If asked, click **Set up billing** for that project. Google AI Pro subscribers get $10/month in credits: activate them under [Google Developer Program benefits](https://developers.google.com/program/my-benefits).
3. Paste the key (starts with `AIza`) into the setup assistant.

To replace the key later: tray icon → right-click → **Settings** → paste the new key → **Test** → **Save**.

## Budget (default: $10/month)

- **In the app:** set the monthly budget in the setup assistant or in Settings. The Gemini window shows the estimated cost for the current month, and requests stop once the budget is reached. Set it to `0` for no limit.
- **At Google (recommended):** open [AI Studio → Spend](https://aistudio.google.com/spend), pick the project of your key, then **Monthly spend cap → Edit spend cap**. Google bills with up to ~10 minutes delay, so small overruns are possible.

The in-app number is an estimate based on token usage; AI Studio shows the real figures.

## Shortcuts (configurable)

| Shortcut | Action |
| --- | --- |
| Ctrl+Alt+Space | Open Gemini (new chat each time) |
| Ctrl+Alt+L | Gemini Live with screen sharing |
| Ctrl+Alt+D | Rambler: dictate into the focused text field; press again to finish |

## Build from source

Requires [Node.js](https://nodejs.org) 22+.

```
npm install
npm start                 # run
npx electron-builder --win portable   # build GeminiOverlay-*-portable.exe
```

## Privacy and secrets

Your API key is stored only on your PC, encrypted with Windows DPAPI (`%APPDATA%\Gemini Overlay\settings.json`). It is never part of this repository; every push is scanned with gitleaks.
