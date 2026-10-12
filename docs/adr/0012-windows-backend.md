# 0012 Windows-Backend: dieselben Werkzeuge, eigene Plattform-Schicht, Installer statt portabler .exe

## Kontext

Phase 7 bringt Agent v2 auf Windows. Die Werkzeuge, Stufen, Prüfungen und Evals sollen dieselben bleiben wie unter Linux. Nur die Plattform-Schicht wird getauscht. Unter Windows fehlt alles, worauf das Linux-Backend aufsetzt: X11/EWMH, D-Bus (MPRIS), AT-SPI, gsettings, gio und bash.

## Entscheidung

- **Werkzeuge bleiben gleich.** Name, Stufen-Logik und Nachprüfung jedes Werkzeugs bleiben unverändert. Innerhalb des Werkzeugs entscheidet `platform.base.IS_WINDOWS`. Nur `settings` und `dark_mode` sind eigene Funktionen (`tools/win_settings.py`), weil ihre Argumente andere sind (Registry statt gsettings).

| Bereich | Linux | Windows |
|---|---|---|
| Fenster | X11 EWMH (`platform/x11.py`), Wayland-Erweiterung | user32 über ctypes (`platform/win32.py`): Fenster wie in der Taskleiste; UWP-Apps über das Kindfenster ihres ApplicationFrameHost |
| Programme | `.desktop`-Dateien | Startmenü: `Get-StartApps` (auch Store-Apps) und Verknüpfungen (`platform/win_apps.py`); Start über die Verknüpfung oder `shell:AppsFolder\<AppID>` |
| Bedienelemente | AT-SPI-Helfer mit System-Python | UI-Automation-Helfer mit dem Agent-Python (`platform/uia_helper.py`, comtypes) |
| Medien | MPRIS (D-Bus) | System Media Transport Controls (`platform/win_media.py`, pywinrt) |
| Lautstärke | pactl | Core Audio (`platform/win_audio.py`, pycaw) |
| Einstellungen | gsettings | Registry des Benutzers (`platform/win_registry.py`) |
| Papierkorb | `gio trash` | `SHFileOperationW` mit `FOF_ALLOWUNDO`, nur auf festen Laufwerken (`platform/win_shell.py`) |
| Shell | bash, `classify_bash` | PowerShell 5.1, `classify_powershell` |
| Prozesse | Prozessgruppe, `killpg` | eigene Prozessgruppe ohne Konsolenfenster, `taskkill /T` (`platform/proc.py`) |

- **Bedienelemente** laufen über einen Helfer mit demselben Zeilenprotokoll und denselben Rollennamen wie AT-SPI („push button“, „entry“, „password text“ …). Dadurch arbeiten `ui_snapshot`, `ui_act` und `ui_set_text` mit ihren Stufen (folgenreiche Knöpfe T2, Passwortfelder T3) auf beiden Systemen gleich.
  - Der Helfer läuft als eigener Prozess, damit ein hängendes Programm nur ihn blockiert.
  - `Invoke` kann blockieren, bis ein modaler Dialog geschlossen ist. Deshalb läuft es in einem Thread mit 3 s Frist. Danach gilt die Aktion als ausgelöst.
- **PowerShell-Einstufung** folgt demselben Grundsatz wie unter bash: Lesend ist nur, was auf einer festen Liste steht. PowerShell kann aber auch außerhalb von Befehlsnamen etwas ausführen. Deshalb gilt zusätzlich:
  - Texte in Anführungszeichen werden vor der Prüfung entfernt; `"$(…)"` fragt.
  - Außerhalb von Texten fragen `; & \` # < > = ( ) [ ] :: $( @( @{` und Methodenaufrufe.
  - Skriptblöcke dürfen nur Vergleiche über `$_` enthalten.
  - `-EncodedCommand`, Defender, Firewall, ExecutionPolicy, Anmeldedaten und das Löschen von Laufwerk, Windows oder Benutzerordner sind T3.
  - Aura selbst startet Befehle als `-EncodedCommand` und mit UTF-8-Ausgabe. Eingestuft wird dabei der Befehl selbst.
- **stdin** wird in einem eigenen Thread gelesen, auf beiden Systemen. Grund: `loop.connect_read_pipe` ist unter Windows mit der von Electron geerbten Pipe nicht verlässlich.
- **Auslieferung:** NSIS-Installer pro Benutzer (`Aura-Setup.exe`), ohne Administratorrechte. Python und der Browser-Server werden wie unter Linux mitgeliefert (`scripts/build-agent.sh` läuft auch in Git Bash).
  - Die portable .exe entfällt, weil sie bei jedem Start rund 200 MB Python entpacken müsste.
  - Updates: neuen Installer ausführen. Einstellungen in `%APPDATA%\Aura` bleiben erhalten.
- **Browser:** Chrome an den Standardorten, sonst Edge (`--browser msedge`), der unter Windows immer vorhanden ist.

## Belege

- **Windows-Tests:** `agent/tests/windows/` laufen in der CI auf `windows-latest` gegen echte Fenster: ein Win32-Testprogramm (`testing/win_app.py`) und eine echte Startmenü-Verknüpfung. Geprüft werden:
  - Fenster auflisten, minimieren, fokussieren und schließen.
  - Programm aus dem Startmenü starten, mit Fensterprüfung.
  - UI Automation: Feld füllen und Knopf drücken, nachgeprüft; ein folgenreicher Knopf braucht eine ehrliche Beschreibung.
  - PowerShell mit Umlauten und Zeitlimit samt Prozessbaum.
  - Papierkorb, Dunkelmodus und Registry.
  - Selbsttest des ganzen Agenten.
- **Übrige Tests:** Die übrige Suite (Hülle, Regeln, Kontext, Protokoll) läuft dort ebenfalls.
- **Klassifizierer:** `tests/unit/test_powershell_classifier.py` deckt rund 120 Fälle ab: lesend, fragend, gesperrt.
- **Installer:** Der Workflow `windows-build.yml` baut ihn auf dem Branch und prüft dabei Bündelgröße und Selbsttest im fertigen Bündel.

## Offen

- **Evals unter Windows:** Die Eval-Suite (0008) hat nur eine Linux-Umgebung (Xvfb, D-Bus). Eine Windows-Umgebung braucht einen Windows-Rechner mit GPU für Ollama, also deinen. Bis dahin sichern die Windows-Vertragstests das Backend ab, die Modellqualität ist dort nicht gemessen.
- **Nicht in der CI geprüft:** Mediensteuerung (SMTC) und Lautstärke. Der Runner hat weder Player noch Audiogerät; dort ist nur geprüft, dass nichts abstürzt.
- **Signierung:** Der Installer ist unsigniert, SmartScreen warnt beim ersten Start.
