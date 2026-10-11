# Gemini Overlay für Windows

Gemini, Gemini Live und Rambler im Stil des Googlebooks: leuchtender Bildschirmrand in den Google-Farben, kleines abgerundetes Gemini-Fenster unten rechts, Live-Gespräch mit Bildschirmfreigabe und "Hier klicken"-Hinweisen, sowie Rambler-Diktat in jedem Textfeld.

## Starten

**Am einfachsten:** Ordner entpacken und `Einrichten.bat` doppelklicken. Das installiert bei Bedarf Node.js (über winget), baut die App auf deinem PC, legt sie unter `%LOCALAPPDATA%\GeminiOverlay` ab und startet sie. Beim ersten Mal dauert das ein paar Minuten.

**Variante A, fertige exe:** `GeminiOverlay-0.1.0-portable.exe` doppelklicken. Windows SmartScreen warnt beim ersten Start, weil die Datei nicht signiert ist: "Weitere Informationen" und dann "Trotzdem ausführen".

**Variante B, aus dem Quellcode:** [Node.js LTS](https://nodejs.org) installieren, im Ordner `windows-gemini` eine Eingabeaufforderung öffnen und

```
npm install
npm start
```

Eine eigene .exe baust du mit `npm run dist` (landet in `dist/`).

Beim ersten Start öffnen sich die Einstellungen. Dort den Gemini API-Key eintragen, "Testen", "Speichern". Die App sitzt danach als Gemini-Symbol im Infobereich der Taskleiste.

## API-Key und Abo

1. Key anlegen: <https://aistudio.google.com/apikey>
2. Mit Google AI Pro gibt es monatlich 10 $ Google-Cloud-Guthaben für die Gemini API. Aktivieren unter <https://developers.google.com/program/my-benefits> und dem Cloud-Projekt des Keys zuordnen.

Der Key wird mit Windows-Verschlüsselung (DPAPI) unter `%APPDATA%\Gemini Overlay\settings.json` gespeichert.

## Tastenkürzel (in den Einstellungen änderbar)

| Kürzel | Funktion |
| --- | --- |
| Strg+Alt+Leertaste | Gemini öffnen / schließen (Glow + Fenster). Esc oder Klick daneben schließt. |
| Strg+Alt+L | Gemini Live mit Bildschirm starten / beenden |
| Strg+Alt+D | Rambler: im Textfeld diktieren, nochmal drücken = fertig. Ist Text markiert, sagst du, wie er umgeschrieben werden soll. |

Die Standardkürzel kollidieren nicht mit Windows (Win+G = Xbox Game Bar, Alt+D = Browser-Adressleiste, Alt+Leertaste = Fenstermenü bzw. die offizielle Gemini-App).

## Funktionen

- **Gemini-Fenster:** öffnet sich als Kreis, federt zur Pille und wächst mit der Unterhaltung. Jedes Öffnen startet einen neuen Chat. "Bildschirm" schickt bei jeder Frage einen Screenshot mit. Antworten nutzen Google-Suche.
- **Gemini Live:** Sprachgespräch über die Live API. Gemini sieht etwa 1 Bild pro Sekunde vom Bildschirm, auf dem das Fenster offen ist, und zeigt mit einem leuchtenden Ring, wo du klicken sollst. Die App klickt nie selbst. Knöpfe: Bildschirm an/aus, Stummschalten, Beenden.
- **Rambler:** Leiste unten mittig, entfernt Füllwörter, setzt Satzzeichen, macht Listen. Danach "Rückgängig" oder "Volltranskript" (wörtlicher Text). Text wird über die Zwischenablage eingefügt; deren vorheriger Inhalt wird wiederhergestellt.
- Die eigenen Fenster der App sind von Bildschirmaufnahmen ausgeschlossen, Gemini sieht also nicht den Glow.

## Feinabstimmung

Glow-Werte (Breite, Tempo, Dauer der Ein-/Ausblendung) stehen oben in `src/renderer/overlay.js` im Block `TUNING`. Modelle, Stimme, Sprache, Bildrate und Fensterposition sind in den Einstellungen.

## Aufbau

| Datei | Inhalt |
| --- | --- |
| `src/main.js` | Fenster, Kürzel, Tray, Autostart, Rambler-Ablauf, Screenshots |
| `src/gemini.js` | Gemini REST-API: Chat (Streaming) und Rambler |
| `src/keys.js` | Strg+C/V/Z an das aktive Fenster (PowerShell-Hilfsprozess) |
| `src/store.js` | Einstellungen, verschlüsselter Key |
| `src/renderer/overlay.*` | Bildschirmrand-Glow (WebGL-Shader) und Klick-Hinweise |
| `src/renderer/panel.*`, `live.js`, `audio.js` | Gemini-Fenster, Chat, Live-Client |
| `src/renderer/rambler.*` | Rambler-Leiste und Aufnahme |
| `src/renderer/settings.*` | Einstellungen |

## Sicherheit

Der API-Key wird nur lokal und verschlüsselt gespeichert und gehört nie ins Repository. `.gitignore` schließt `settings.json` und `.env` aus, und jeder Push wird per GitHub Action mit [gitleaks](https://github.com/gitleaks/gitleaks) auf Zugangsdaten geprüft.
