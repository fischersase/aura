# Third-party software

Aura's own code is under the [MIT License](LICENSE). The installers and packages also contain or download the
following software, each under its own license. The full license texts ship inside the packages (Electron's
`LICENSES.chromium.html`, the bundled Python's `LICENSE.txt`, and the `LICENSE` files in `resources/python` and
`resources/browser-mcp/node_modules`).

| Component | Used for | License |
|---|---|---|
| [Electron](https://www.electronjs.org) and Chromium | the app itself | MIT; Chromium: BSD-3-Clause and others |
| [Python](https://www.python.org) (python-build-standalone) | runtime for the agent | PSF License |
| [Google ADK](https://github.com/google/adk-python) and its dependencies (see `agent/uv.lock`) | agent framework | Apache-2.0 and others |
| [@playwright/mcp](https://github.com/microsoft/playwright-mcp) | browser specialist | Apache-2.0 |
| [transformers.js](https://github.com/huggingface/transformers.js) and [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | local speech recognition | Apache-2.0, MIT |
| [Whisper](https://github.com/openai/whisper) models (downloaded on first use from Hugging Face) | local speech recognition | MIT |
| comtypes, pycaw, pywinrt, psutil (Windows) | UI Automation, volume, media controls | MIT, BSD-3-Clause |
| dbus-fast, python-xlib (Linux) | media controls, windows | MIT, LGPL-2.1 |

Google Gemini and Ollama models are not part of Aura. Using Gemini is subject to Google's terms; local models are
subject to their own licenses (for example the Gemma terms of use).

"Gemini" and "Google" are trademarks of Google LLC. Aura is an independent project and is not affiliated with or
endorsed by Google.
