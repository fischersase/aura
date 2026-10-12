# 0004 Kontextverwaltung innerhalb eines Auftrags

## Kontext

`EventsCompactionConfig` von ADK fasst Ereignisse erst **nach** einem abgeschlossenen Auftrag zusammen (Auslöser `compaction_interval` oder `token_threshold` „post-invocation“). Ein langer Auftrag mit 40 und mehr Schritten und Bildschirmfotos kann das Kontextfenster also mitten im Auftrag sprengen, besonders bei `num_ctx` 32K.

## Entscheidung

- **Zwischen Aufträgen:** ADK-Kompaktierung mit `LlmEventSummarizer` auf demselben lokalen Modell.
- **Innerhalb eines Auftrags:** eigener `ContextManager` im `before_model_callback`. Er verändert nur die Anfrage, nie die gespeicherten Ereignisse.
  - Nur die letzten 2 Bilder bleiben drin.
  - Werkzeugausgaben über 4.000 Zeichen werden in der Mitte gekürzt; die volle Ausgabe liegt als Artefakt bereit.
  - Ab 60 % von `num_ctx` werden ältere Schritte zu einer Zusammenfassung verdichtet.
  - Bei jeder Anfrage neu angeheftet: Originalbitte, Aufgabenliste, AGENTS.md, MEMORY.md-Index, Stufenregeln.

## Folgen

- Tests mit `ScriptedLlm` prüfen, dass angehefteter Kontext jede Verdichtung übersteht und Bilder begrenzt bleiben.
