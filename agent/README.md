# aura-agent

Der neue Aura-Agent (v2) auf Google ADK. Er läuft als eigener Python-Prozess neben der Electron-App und spricht über stdio JSON-RPC mit ihr. Hintergrund und Entscheidungen stehen in [docs/adr](../docs/adr/README.md).

Stand: **Phase 0** (Spikes). Die Electron-App nutzt weiterhin den alten Agenten.

## Entwickeln

```bash
cd agent
uv sync                 # Python 3.12 + Abhängigkeiten aus uv.lock
uv run pytest           # Unit- und ADK-Kanarientests, ohne Modell
uv run ruff check src tests spikes
```

## Spikes mit echtem Modell (Ollama muss laufen)

```bash
uv run python spikes/tool_reliability.py gemma4:26b qwen3.6:27b   # Werkzeugwahl bei 8/12/20 Werkzeugen
uv run python spikes/honesty.py gemma4:26b [bild.png]             # ehrliche Antworten nach Ablehnung/Fehlschlag
```

Ergebnisse landen in `spikes/results/`.

## Aufbau

| Pfad | Inhalt |
|---|---|
| `src/aura_agent/models/ollama_llm.py` | ADK-Modell für Ollama über die native `/api/chat` |
| `src/aura_agent/models/repair.py` | Reparatur von Werkzeugaufrufen lokaler Modelle |
| `src/aura_agent/testing/scripted_llm.py` | Modell mit festem Drehbuch für Tests |
| `tests/adk_canary/` | Prüft die ADK-Annahmen der Architektur; muss vor jedem ADK-Update grün sein |
| `tests/unit/` | Unit-Tests |
