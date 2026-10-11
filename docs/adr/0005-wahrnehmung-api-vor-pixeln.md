# 0005 Wahrnehmung: API vor AT-SPI vor Browser-DOM vor Pixeln

## Kontext

Agent v1 hat YouTube Music über geschätzte Pixel-Klicks bedient: 8 Klicks in 50 s, falscher Song, beim Pausieren der nächste Song. Lokale Modelle erkennen Bildschirminhalte schlechter als Gemini.

## Entscheidung

Werkzeuge nutzen immer den verlässlichsten verfügbaren Weg:

1. **Programmschnittstellen:** Shell, D-Bus, MPRIS für Medien, gsettings, Dateisystem.
2. **Barrierefreiheitsbaum (AT-SPI)** für Desktop-Programme. Bevorzugt werden Aktionen (`doAction`, Text setzen), nicht Koordinaten. Unter Wayland sind AT-SPI-Koordinaten unzuverlässig.
3. **Browser über das DevTools-Protokoll:** Playwright-MCP mit eigenem Profil; „Mein Chrome benutzen“ als Opt-in über chrome-devtools-mcp.
4. **Bildschirmfoto mit Pixel-Eingabe** nur als Notlösung.

## Belege (P0, auf dem Rechner des Nutzers, X11-Sitzung :20)

- **MPRIS:** Chrome meldet YouTube Music als `org.mpris.MediaPlayer2.chromium.instance…` mit Titel „un x100to“, Künstler „Grupo Frontera und Bad Bunny“, Status `Paused`. Pausieren und Weiterschalten gehen damit ohne Klick und lassen sich nachprüfen.
- **AT-SPI:** 24 Programme sichtbar (Nautilus, Texteditor, VS Code, Aura, Chrome …), obwohl `toolkit-accessibility` aus ist.
- **Chrome über AT-SPI:** nur 4 leere Knoten, weil die Barrierefreiheit im Browser nicht aktiv ist. Webseiten laufen deshalb über das DevTools-Protokoll, nicht über AT-SPI.

## Folgen

- In P2 kommen die Werkzeuge `media_status`/`media_control` (MPRIS), Fenster über EWMH (X11) und `launch_app` mit Fensterprüfung.
- In P3 kommen AT-SPI-Schnappschuss und -Aktionen, der Browser-Spezialist und die Wayland-Wege (GNOME-Erweiterung, RemoteDesktop-Portal).
- Wayland-Portal und GNOME-Erweiterung konnten in P0 nicht getestet werden, weil die Arbeitssitzung X11 über Chrome Remote Desktop ist. Das ist ein Risiko für P3.
