# aura-agent

Der neue Aura-Agent (v2) auf Google ADK. Er läuft als eigener Python-Prozess neben der Electron-App und spricht über stdio JSON-RPC mit ihr (Protokoll: [protocol/aura-agent.schema.json](../protocol/aura-agent.schema.json)). Hintergrund und Entscheidungen stehen in [docs/adr](../docs/adr/README.md).

Stand: **Phase 1**, ein lauffähiges Gerüst.
- Root-Agent mit lesenden Werkzeugen (Dateien, Systeminfo, Medienstatus) und Shell.
- Ändernde Befehle fragen immer, Zugangsdaten und Zerstörerisches sind gesperrt.
- Sitzungen pro Chat, Audit-Kette, Not-Aus.

Der alte Agent bleibt Standard. v2 ist nur mit lokalen Modellen über Ollama nutzbar.

## Agent v2 in Aura einschalten

- **Zentrale:** Übersicht → Agent-Version → „v2“.
- **Für einen Start:** `AURA_AGENT_VERSION=v2 aura`.

Aura nutzt das Ollama-Modell und die Kontextlänge aus den Einstellungen.

Der Agent schreibt seine Daten nach `~/.config/Aura/agent/`:

| Datei | Inhalt |
|---|---|
| `sessions.db` | Chatverläufe |
| `audit/YYYY-MM.jsonl` | Protokoll jeder Aktion, mit Hash-Kette |
| `agent.log` | Log des Prozesses |

## Entwickeln

```bash
cd agent
uv sync                 # Python 3.12 + Abhängigkeiten aus uv.lock
uv run pytest           # Unit-, Hüllen-, Vertrags- und ADK-Kanarientests, ohne Modell
uv run ruff check src tests spikes
uv run python -m aura_agent --selftest
cd .. && npm test       # Brücke in Electron, inklusive Ende-zu-Ende gegen den echten Agenten
```

Paket mit gebündeltem Python bauen: `bash scripts/build-agent.sh` (läuft auch in `npm run dist:linux` und im Release).

## Spikes mit echtem Modell (Ollama muss laufen)

```bash
uv run python spikes/tool_reliability.py gemma4:26b qwen3.6:27b   # Werkzeugwahl bei 8/12/20 Werkzeugen
uv run python spikes/honesty.py gemma4:26b [bild.png]             # ehrliche Antworten nach Ablehnung/Fehlschlag
```

## Aufbau

| Pfad | Inhalt |
|---|---|
| `src/aura_agent/__main__.py` | Einstieg: stdio-Server, `--selftest`, `--version` |
| `src/aura_agent/rpc/peer.py` | JSON-RPC in beide Richtungen |
| `src/aura_agent/runtime/` | Server, Auftragssteuerung, Kontext je Auftrag, Einstellungen |
| `src/aura_agent/harness/` | Hülle um jedes Werkzeug (Stufen, Freigaben), Audit-Kette |
| `src/aura_agent/policy/shell_classifier.py` | Stufe eines Shell-Befehls (T0 lesen, T2 fragen, T3 gesperrt) |
| `src/aura_agent/tools/` | Werkzeuge |
| `src/aura_agent/agents/root.py` | Root-Agent und Systemanweisung |
| `src/aura_agent/models/` | `OllamaLlm` und Reparatur von Werkzeugaufrufen |
| `src/aura_agent/testing/` | Drehbuch-Modell und Host-Attrappe für Tests |
| `tests/` | `unit`, `harness` (ganze Aufträge), `contract` (Protokoll), `adk_canary` (ADK-Annahmen) |
