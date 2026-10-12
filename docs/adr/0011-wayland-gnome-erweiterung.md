# 0011 Fenster unter GNOME Wayland über eine eigene Shell-Erweiterung

## Kontext

Unter Wayland sieht kein Programm fremde Fenster und kann sie nicht steuern. GNOMEs eigene Schnittstelle `org.gnome.Shell.Introspect` ist ohne „unsafe mode“ gesperrt. xdotool und EWMH sehen unter Wayland nur Xwayland-Fenster.

## Entscheidung

- **Erweiterung:** `gnome-extension/aura-bridge@aura` (GNOME 45–49, ESM).
  - Bietet auf dem Session-D-Bus genau fünf Funktionen: `ListWindows`, `Activate`, `Minimize`, `Maximize`, `Close`.
  - Kein Lesen von Fensterinhalten, keine Eingaben.
- **Agent:** `platform/gnome_wayland.py` nutzt die Erweiterung, wenn `XDG_SESSION_TYPE=wayland`.
  - Die Werkzeuge `list_windows`, `window_action` und `launch_app` (Fensterprüfung) laufen über eine gemeinsame Fensterschicht für X11 und Wayland.
  - Wayland-Fenster-IDs beginnen mit `w`.
- **Installation:** Das Linux-Paket liefert die Erweiterung mit. Die Zentrale-Systemprüfung bietet unter Wayland „Installieren“ an: Sie kopiert die Erweiterung nach `~/.local/share/gnome-shell/extensions` und schaltet sie mit `gnome-extensions enable` ein. Danach einmal ab- und anmelden.
- **Weitere Wege unter Wayland:**
  - Bildschirmfotos: über die Bildschirmfreigabe von Electron.
  - Programme: über AT-SPI, das unter Wayland funktioniert (Aktionen statt Koordinaten).
  - Maus und Tastatur (Notlösung): über die v1-Eingabe mit ydotool.

## Belege

**Test:** `agent/tests/wayland/` startet eine unsichtbare, abgeschottete GNOME-Shell 46 (`gnome-shell --headless --wayland`, eigener D-Bus, eigene Einstellungen) mit der Erweiterung und einem nativen Wayland-GTK-Fenster. Die echten Agent-Werkzeuge listen, minimieren, fokussieren, maximieren und schließen das Fenster, jeweils nachgeprüft.

**Lauf:** Lokal grün. In der GitHub-CI übersprungen, weil dort keine GNOME-Shell installiert ist.

**Fallstrick:** In einem Terminal aus dem VS-Code-Snap stehen veraltete GNOME-Schemata vor den echten (`XDG_DATA_DIRS`, `GSETTINGS_SCHEMA_DIR`). Das ließ die GNOME-Shell abstürzen und erklärte das scheinbar fehlende `color-scheme`. Der Test startet deshalb mit leerer Umgebung (`env -i`).

## Offen

- Maus und Tastatur unter GNOME Wayland laufen über ydotool; das RemoteDesktop-Portal mit gespeicherter Einwilligung wäre sauberer.
- Auf dem echten Wayland-Desktop des Nutzers noch nicht ausprobiert (seine Arbeitssitzung ist X11 über Chrome Remote Desktop).
