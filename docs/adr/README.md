# Architekturentscheidungen (ADR) für Aura Agent v2

Jede Entscheidung steht in einer eigenen Datei: Kontext, Entscheidung, Belege, Folgen.
Belege aus Phase 0 (Spikes) liegen unter `agent/spikes/` und `agent/tests/adk_canary/`.

| Nr. | Entscheidung | Status |
|---|---|---|
| [0001](0001-python-adk-sidecar.md) | Python-ADK als Sidecar, stdio JSON-RPC zu Electron | angenommen |
| [0002](0002-eigener-ollama-adapter.md) | Eigener `OllamaLlm` auf der nativen Ollama-API statt LiteLLM | angenommen |
| [0003](0003-freigaben-in-der-huelle.md) | Freigaben und Regeln als Plugin an der Werkzeuggrenze, nicht über ADK-Confirmation | angenommen |
| [0004](0004-kontext-innerhalb-eines-auftrags.md) | Eigene Kontextverwaltung innerhalb eines Auftrags, ADK-Kompaktierung nur zwischen Aufträgen | angenommen |
| [0005](0005-wahrnehmung-api-vor-pixeln.md) | Reihenfolge der Wahrnehmung: API, AT-SPI, Browser-DOM, Pixel | angenommen |
| [0006](0006-python-buendeln.md) | Python-Laufzeit wird mitgeliefert | angenommen |
| [0007](0007-lokales-standardmodell.md) | Lokales Standardmodell gemma4:26b (Benchmark: 100 %, vor qwen3.6 27b/35b und gemma4:e4b) | angenommen |
| [0008](0008-eval-suite.md) | Desktop-Eval-Suite als Abnahme (echter Zustand, abgeschottet, pass^k) | angenommen |
| [0009](0009-browser-spezialist.md) | Browser über Playwright-MCP als eigener Spezialist, Klick-Einstufung nach Ziel | angenommen |
| [0010](0010-programme-ueber-atspi.md) | Desktop-Programme über AT-SPI (System-Python-Helfer), Spezialist „apps“ | angenommen |
| [0011](0011-wayland-gnome-erweiterung.md) | Fenster unter GNOME Wayland über die eigene Shell-Erweiterung „Aura Bridge“ | angenommen |
