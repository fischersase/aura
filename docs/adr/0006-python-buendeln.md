# 0006 Python-Laufzeit wird mitgeliefert

## Kontext

Der Sidecar braucht Python 3.12 und die ADK-Abhängigkeiten. Nutzer sollen nichts installieren müssen, und Aura soll offline starten.

## Entscheidung

- Die CI holt python-build-standalone 3.12 (Variante `install_only_stripped`, sha256 festgeschrieben).
- Sie installiert die gesperrten Abhängigkeiten aus `agent/uv.lock` mit `--require-hashes` und das Wheel `aura_agent`.
- Testsuite, IDLE und tkinter werden entfernt.
- Das Ergebnis liegt in electron-builder `extraResources/python`.
- Der AT-SPI-Helfer läuft mit dem System-Python (`python3-gi`, `gir1.2-atspi-2.0`; im .deb als Abhängigkeit).

Verworfen wurde `uv sync` beim ersten Start: Es braucht Netz, ist langsam und kann auf Nutzerrechnern scheitern.

## Belege (P0)

- Python 3.12.13 standalone plus alle Abhängigkeiten: 171 MB entpackt, **35 MB** als tar.xz. Das .deb wächst von 104 MB auf etwa 140 MB.
- `site-packages` der Abhängigkeiten: 77 MB.

## Folgen

- Die CI prüft eine Größenobergrenze von 200 MB entpackt.
- Der Release-Job baut den Sidecar und führt `aura-agent --selftest` aus, bevor das Paket entsteht.
