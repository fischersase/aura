# 0010 Desktop-Programme über AT-SPI, Spezialist „apps“

## Kontext

Programme wie Texteditor, Dateien, Rechner oder Einstellungsdialoge haben einen Barrierefreiheitsbaum (AT-SPI): Knöpfe, Felder und Texte mit Namen und ausführbaren Aktionen. Ihn zu bedienen ist verlässlicher als Pixel-Klicks, besonders mit lokalen Modellen, die Bildschirminhalte schwächer erkennen.

## Entscheidung

- **Helfer:** `platform/atspi_helper.py` läuft als eigener Prozess mit dem **System-Python** (python3-gi, gir1.2-atspi-2.0). Das gebündelte Python hat kein PyGObject.
  - Kommunikation über JSON-Zeilen.
  - Jeder Aufruf hat ein Zeitlimit von 8 s. Hängt ein Programm, wird der Helfer beendet und beim nächsten Aufruf neu gestartet.
- **Werkzeuge:**
  - `ui_snapshot` (T0): Bedienelemente mit Index; Programme werden über Namen oder Fenstertitel gefunden.
  - `ui_act` (T1, T2 bei Löschen, Senden, Kaufen …).
  - `ui_set_text` (T1; Passwortfelder T3).
- **Schutz vor Umgehung:** Folgenreiche Elemente müssen in `element` ehrlich beschrieben sein. Heißt das echte Element „Konto löschen“, die Beschreibung aber „Knopf unten“, wird nicht geklickt, damit die Einstufung nicht umgangen wird.
- **Spezialist `apps`:** besitzt diese Werkzeuge plus Programme öffnen und Fenster. Mehrstufige Bedienung (lesen → handeln → prüfen) bleibt in seinem Kontext.
- **`launch_app`:** Findet es keinen Programmeintrag, holt es ein offenes Fenster mit passendem Titel nach vorne.
- **API-Fallstrick:** In neueren PyGObject-Versionen sind die Objekte aus `get_text_iface()` das Element selbst, und dessen gleichnamige Methoden sind veraltet und tun etwas anderes. Deshalb ruft der Helfer die Schnittstellen über die Klassenfunktionen auf (`Atspi.Text.get_text(acc, …)`, `Atspi.EditableText.set_text_contents(acc, …)`).

## Belege

**Tests:** GTK-3-Testprogramm in Xvfb mit eigenem D-Bus und AT-SPI-Bus. Geprüft werden: Text setzen, Speichern klicken, Ergebnis lesen; der Löschen-Knopf mit unehrlicher Beschreibung wird abgewiesen; veraltete Indizes werden abgewiesen. Die Tests laufen auch in der CI.

**Evals mit gemma4:26b:** Notiz eintragen und speichern, Löschen abgelehnt, Status ablesen – pass^3 100 %, 0 unsichere Aktionen.

**Auf dem Desktop des Nutzers:** Texteditor, Dateien, VS Code, Chrome und Aura melden sich über AT-SPI. Chrome und Electron liefern ihre Inhalte nur mit eingeschalteter Barrierefreiheit; Webseiten laufen deshalb über den Browser-Spezialisten (ADR 0009).

## Folgen

- Das .deb empfiehlt python3-gi und gir1.2-atspi-2.0. Fehlen sie, ist `apps` nicht verfügbar, und der Agent sagt das.
- Unter Wayland bleiben AT-SPI-Aktionen nutzbar; Koordinaten nicht (Phase 3, Wayland).
