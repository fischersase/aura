# 0001 Python-ADK als Sidecar, stdio JSON-RPC zu Electron

## Kontext

Der Agent wird mit Google ADK neu gebaut und soll zuerst mit lokalen Modellen über Ollama laufen. ADK gibt es für Python, TypeScript, Go und Java. Aura ist eine Electron-App (CommonJS, Node).

## Entscheidung

- Der Agent läuft als eigener Python-Prozess `aura-agent` mit `google-adk==2.11.0`, festgeschrieben in `agent/uv.lock`.
- Electron startet ihn und spricht über stdin/stdout JSON-RPC 2.0 (eine JSON-Zeile pro Nachricht) mit ihm, in beide Richtungen. Es gibt keinen offenen Port.
- Rückfragen des Agenten an Electron (Freigabe, ask_user, Bildschirmfoto, Zwischenablage) sind Anfragen in Gegenrichtung.
- Die Betriebssystem-Werkzeuge leben im Python-Prozess. Electron liefert nur, was nur Electron kann: Bildschirmaufnahme (auch der Wayland-Stream), Zwischenablage, Hinweise.

## Gründe

- **TypeScript-ADK reicht nicht.** Es hat kein Ollama- oder OpenAI-kompatibles Modell (Issue google/adk-js#533 offen), keine Evaluation (`adk eval` gibt es nur in Python), Live nur experimentell und kein persistentes lokales Gedächtnis.
- **stdio statt HTTP.** Ein Prozess, der Shell-Befehle ausführt, soll keinen Port öffnen; damit entfallen Token, DNS-Rebinding und fremde lokale Prozesse. Der Sidecar endet, wenn Electron endet (EOF).
- **Werkzeuge im Sidecar.** Regeln, Stufen, Nachprüfung und Audit sitzen im selben Prozess wie das Werkzeug. Tests und Evals laufen ohne Electron, mit einem Fake-Host.

## Belege (P0)

- Start des Sidecars mit allen ADK-Importen: 1,1 s, 73 MB RSS.
- Kanarientests `agent/tests/adk_canary/` (7 grün): Plugins wirken auch in AgentTool-Unteragenten, `abort_signal` stoppt ein laufendes Werkzeug in unter 2 s, SQLite-Sitzungen überleben einen Neustart, `SqliteMemoryService` findet frühere Sitzungen.

## Folgen

- Zwei Sprachen im Repo. Die Schnittstelle wird über JSON-Schemas in `protocol/` und Vertragstests auf beiden Seiten abgesichert.
- Python muss mitgeliefert werden (siehe 0006).
