# 0009 Browser über Playwright-MCP als Spezialist

## Kontext

Agent v1 bediente YouTube Music über Bildschirmfotos und geschätzte Klicks. Webseiten haben aber eine Struktur (Barrierefreiheitsbaum), die sich lesen und gezielt bedienen lässt. Webseiten sind außerdem groß und würden den Kontext des Hauptagenten füllen.

## Entscheidung

- **Werkzeuge:** Playwright-MCP (`@playwright/mcp@0.0.80`) als ADK-`McpToolset`.
  - Ein eigenes Chrome mit eigenem Profil `~/.aura/browser-profile`.
  - 13 Werkzeuge per `tool_filter` (navigieren, Seite lesen, suchen, klicken, tippen, Formulare, Tabs, Dialoge, Bildschirmfoto).
  - Gesperrt sind beliebiges JavaScript (`browser_evaluate`, `browser_run_code_unsafe`) und Datei-Uploads.
- **Spezialist:** Die Werkzeuge gehören einem eigenen Agenten `browser` (ADK `AgentTool`). Der Hauptagent ruft ihn mit einer klaren Aufgabe auf und bekommt nur das Ergebnis zurück. Die Seiteninhalte bleiben im Kontext des Spezialisten.
- **Stufen:**
  - Lesen ist T0.
  - Navigieren, Klicken und Tippen sind T1.
  - T2 gilt, wenn das Ziel nach Kaufen, Senden, Absenden, Löschen, Kündigen, Bestätigen o. Ä. klingt, außerdem bei `file:`-URLs und beim Bestätigen von Seitendialogen.
  - Klicks und Eingaben ohne Beschreibung des Ziels (`element`) weist die Hülle zurück, damit die Einstufung nicht umgangen werden kann.
- **Netz:** Chrome startet mit `--disable-quic`. Im Netz des Nutzers scheitert QUIC (`ERR_QUIC_PROTOCOL_ERROR`), ähnlich dem IPv6-Problem bei Ollama.
- **Auslieferung:** Das Linux-Paket enthält das Playwright-MCP (19 MB). Aura startet es mit Electron als Node (`ELECTRON_RUN_AS_NODE=1`), daher braucht es weder Node.js noch Internet beim ersten Start. In der Entwicklung läuft es über `npx`. Chrome muss installiert sein.
- **Ehrlichkeit:** Der Spezialist gibt nur wieder, was in Seitenergebnissen steht, und meldet Fehlerseiten. Im Test hatte das Modell bei einer Fehlerseite den Inhalt einer bekannten Seite aus dem Gedächtnis „vorgelesen“.

## Belege

**Browser-Evals** mit lokalem Testserver, der jede Anfrage mitschreibt:

| Aufgabe | Was geprüft wird |
|---|---|
| Lesen | Inhalt der Seite wird korrekt wiedergegeben |
| Suchen | Suchanfrage kommt beim Server an, erster Treffer wird genannt |
| Formular | Daten kommen an, vor dem Absenden wird gefragt |
| Kauf abgelehnt | Freigabe wird gefragt, nach dem Ablehnen kommt keine Bestellung beim Server an |
| 404-Seite | wird ehrlich gemeldet |
| Versteckte Prompt-Injection | weder Datenabfluss noch Löschen |

**Gesamtlauf** mit 47 Aufgaben, je 3 Läufe: pass^3 97,9 %. Der einzige Fehlschlag war ein Prüferfehler (das Wort „blockiert“ fehlte in der Ehrlichkeitsprüfung). Seitdem trennt die Eval Sicherheits- von Qualitätsprüfungen, und die Aufgabe besteht 3/3.

**Praxistest** „Spiel Bad Bunny auf YouTube Music“: Cookie-Banner abgelehnt, gesucht, „Play Chambea - Bad Bunny“ geklickt, ohne Pixel-Klick.

## Offen

- „Mein Chrome benutzen“ (eingeloggte Konten) über chrome-devtools-mcp `--autoConnect`, nur auf ausdrücklichen Wunsch.
- Inhalte von Webseiten als „untrusted“ markieren und folgenreiche Aktionen nach dem Lesen fremder Inhalte strenger prüfen (P5).
