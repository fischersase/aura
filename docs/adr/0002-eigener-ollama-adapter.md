# 0002 Eigener OllamaLlm auf der nativen Ollama-API

## Kontext

ADK spricht Ollama über LiteLLM (`ollama_chat/…`) oder über `OpenAILlm` (OpenAI-kompatible `/v1`) an.

- LiteLLM hatte im März 2026 einen Lieferketten-Vorfall (1.82.7/1.82.8).
- Über `/v1` lässt sich `num_ctx` nicht setzen. Weicht `num_ctx` von dem ab, was Chat und Rambler in Aura nutzen, lädt Ollama das 18-GB-Modell neu, was rund 70 s dauert.
- gemma4 braucht auf dem OpenAI-Weg eine Sonderrolle `tool_responses`.

## Entscheidung

`aura_agent.models.ollama_llm.OllamaLlm(BaseLlm)` spricht direkt `/api/chat` an:

- setzt `num_ctx`, `keep_alive`, `think`, Bilder und Streaming,
- überlässt die Chat-Vorlage Ollama selbst,
- leitet jeden Werkzeugaufruf durch `aura_agent.models.repair`: Namen normalisieren und unscharf abgleichen, kaputtes JSON reparieren, Aufrufe aus dem Text ziehen, Typen ans Schema anpassen. Jede Reparatur wird gezählt.

## Belege (P0, `agent/spikes/`)

`tool_reliability.py` hat 10 typische Wünsche (Musik pausieren, App öffnen, Datei lesen, Lautstärke, Websuche …) mit 8, 12 und 20 Werkzeugen getestet, jeweils über den vollen ADK-Runner:

| Modell | 8 Werkzeuge | 12 Werkzeuge | 20 Werkzeuge | Median je Durchgang | Reparaturen |
|---|---|---|---|---|---|
| gemma4:26b | 10/10 | 10/10 | 10/10 | 0,5–0,8 s | 0 |
| qwen3.6:27b | 10/10 | 10/10 | 10/10 | 1,9–2,1 s | 0 |

`honesty.py` prüft abgelehnte, fehlgeschlagene und erfolgreiche Aktionen mit gemma4:26b:
- Alle 12 Antworten geben das Ergebnis wahrheitsgemäß wieder.
- Eine Antwort war **leer**. Die Hülle muss leere Endantworten abfangen (siehe 0003).
- Bilder kommen an: Das Albumcover aus MPRIS wurde korrekt beschrieben.

Weitere Befunde:
- Das Modell machte aus `~/notizen.txt` den Pfad `/home/user/notizen.txt`. Werkzeuge lösen `~` und relative Pfade deshalb selbst auf, und der Systemprompt nennt den echten Benutzerordner.

## Folgen

- Rund 300 Zeilen eigener Code statt einer Abhängigkeit, abgesichert durch Unit-Tests mit aufgezeichneten Antworten.
- Gemini läuft weiter über das native `Gemini`-Modell von ADK (nur auf Wunsch).
