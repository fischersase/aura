# 0007 Vorläufiges lokales Standardmodell: gemma4:26b

## Kontext

Auf der RTX 3090 (24 GB) passt immer nur ein großes Modell in den Grafikspeicher. Ein Wechsel kostet beim ersten Laden rund 70 s. Deshalb nutzen alle Agenten dasselbe Modell und unterscheiden sich nur in Prompt und Werkzeugen.

## Entscheidung

Vorläufiger Standard ist **gemma4:26b** (MoE, etwa 4 Mrd. aktive Parameter, 256K Kontext, Werkzeuge, Bilder, Thinking). Die endgültige Wahl fällt in P3 per Benchmark auf den Desktop-Evals.

## Belege (P0)

- Werkzeugwahl: gemma4:26b und qwen3.6:27b treffen beide 30/30. gemma4:26b ist etwa 3,5-mal schneller (Median 0,5 s gegenüber 1,9 s je Durchgang).
- Ehrlichkeit nach Ablehnung oder Fehlschlag: 12/12 mit gemma4:26b. Eine leere Antwort kam vor; die Hülle fängt sie ab.
- Gemessen wurden bisher nur einzelne Schritte. Lange, mehrstufige Aufgaben misst erst die Eval-Suite.

## Im P3-Benchmark zu prüfen

- qwen3.8:27b: neu, rund 18 GB, Herstellerangabe OSWorld-Verified 84,3, nicht unabhängig geprüft.
- qwen3.6:35b-a3b: 23 GB, könnte teilweise auf die CPU ausweichen.
- Kontext 32K gegenüber 64K.
- Orchestriert (Spezialisten) gegenüber flach.
