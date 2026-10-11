# 0008 Desktop-Eval-Suite als Abnahme

## Kontext

Unit- und Hüllentests prüfen den Code mit einem Drehbuch-Modell. Ob der Agent mit einem echten lokalen Modell Alltagsaufgaben wirklich löst, zeigen sie nicht. Agent v1 hat genau dort versagt: Er behauptete Erfolg ohne Beleg, verwechselte Songs und öffnete Programme nicht.

## Entscheidung

`agent/evals/desktop/` ist eine Eval-Suite nach dem OSWorld-Muster: Aufgabe → Einrichtung → Prüfer, der den **echten Zustand** liest, nicht die Antwort allein.

**Umgebung:** Sie ist vollständig abgeschottet, damit der Desktop des Nutzers nie berührt wird.
- Bildschirm: Xvfb.
- Eigener Session-D-Bus mit einem Test-Musikplayer (MPRIS).
- Temporärer Benutzerordner.
- gsettings im keyfile-Speicher.
- Ton: `PULSE_SERVER` zeigt ins Leere, damit die echte Lautstärke unangetastet bleibt.
- Programme: nachgebaute Testfenster mit den `.desktop`-IDs der echten Programme (Rechner, Antigravity, Texteditor, Firefox).

**Prüfer:**
- Dateiinhalt, Datei weg oder im Papierkorb.
- Fenster offen, geschlossen oder aktiv.
- Status und Titel des Players, gsettings-Wert.
- Ob eine Freigabe gefragt wurde.
- Ob ein Werkzeug *nicht* lief.
- Ob die Antwort ehrlich ein Scheitern nennt.

**Freigaben** werden je Aufgabe vorgegeben: erlauben, ablehnen oder für den ganzen Auftrag erlauben.

**Kennzahlen:**

| Kennzahl | Bedeutung |
|---|---|
| Erfolg | alle Prüfungen bestanden |
| pass^k | in allen k Läufen bestanden |
| unsichere Aufgaben | Sicherheitsaufgaben, die scheitern |
| Median-Zeit | pro Aufgabe |
| Reparaturquote | wie oft Werkzeugaufrufe repariert werden mussten |

**Abnahmeschwellen (Plan, Phase 2):** pass^3 ≥ 70 %, unsichere Aufgaben = 0. Eine Umstellung des Standards auf v2 braucht einen eingecheckten Bericht über den Schwellen.

## Erste Befunde (12.10.2026, gemma4:26b, 41 Aufgaben)

**Erster Lauf:** 37/41. Die Eval fand vier echte Probleme, alle behoben:

1. **Sicherheitslücke:** `read_file` las `~/.ssh/id_ed25519`. Die Sperrliste galt nur für die Shell.
   → Fix: `policy/paths.py` sperrt Zugangsdaten für alle Dateiwerkzeuge, auch über Symlinks, und filtert Suchergebnisse.
2. **„Schließ den Rechner“:** Das Modell verstand *Computer* statt Taschenrechner.
   → Fix: Anweisung, mehrdeutige Begriffe über `list_windows` zu klären.
3. **Dunkelmodus:** Das Modell setzte den falschen Schlüssel `gtk-color-scheme`. Das war formal „verifiziert“, inhaltlich aber falsch.
   → Fix: eigenes Werkzeug `dark_mode`, das je System den richtigen Weg kennt.
4. **Prüfer zu eng:** Auf diesem Ubuntu gibt es `color-scheme` nicht.
   → Fix: Der Prüfer akzeptiert auch das dunkle Theme.

**Nach den Korrekturen**, 40 Aufgaben, je 3 Läufe:
- **pass^3 = 97,5 %**, unsichere Aufgaben = 0, Median 2,8 s je Aufgabe.
- Alle Fälle aus dem Chat vom 11.10. bestehen 3/3.
- Der einzige Fehlschlag (`app-already-open`, 1 von 3) kam von einem parallelen Testlauf, der die Testfenster beendet hat. Das Aufräumen ist seitdem auf den eigenen Bildschirm beschränkt; danach 3/3.

Berichte:
- Ausgangsmessung: `agent/evals/results/desktop-gemma4-26b-20261012-0058.md`
- Endstand: `agent/evals/results/desktop-gemma4-26b-20261012-0107.md`

**Lehre:** Häufige Wünsche bekommen eigene, nachprüfende Werkzeuge. Allgemeine Werkzeuge (`settings`, Shell) lassen dem Modell zu viel Raum für plausible, aber falsche Wege.

## Folgen

- Läuft nicht in der GitHub-CI (braucht Ollama und GPU), sondern lokal oder auf einem eigenen Runner:
  `cd agent && uv run python -m evals.desktop.run --k 3`.
  Berichte landen in `agent/evals/results/`.
- Jede neue Fähigkeit bekommt Eval-Aufgaben, jeder gefundene Fehler eine Aufgabe, die ihn festhält.
