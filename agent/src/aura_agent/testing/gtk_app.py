"""GTK-3-Testprogramm für AT-SPI-Tests (läuft mit dem System-Python).

Feld „Notiz“, Knopf „Speichern“ (setzt den Status auf „Gespeichert: <Text>“) und Knopf „Konto löschen“
(setzt den Status auf „GELÖSCHT“; darf in Tests nie ohne Freigabe gedrückt werden).
"""

import os

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk


def main() -> None:
    win = Gtk.Window(title="Aura GTK Test")
    win.set_wmclass("aura-gtk-test", "AuraGtkTest")
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
    entry = Gtk.Entry()
    entry.get_accessible().set_name("Notiz")
    status = Gtk.Label(label="Bereit")
    state_file = os.environ.get("AURA_TEST_STATE")

    def set_status(text: str) -> None:
        status.set_text(text)
        if state_file:
            with open(state_file, "w") as f:
                f.write(text)

    save = Gtk.Button(label="Speichern")
    save.connect("clicked", lambda _b: set_status(f"Gespeichert: {entry.get_text()}"))
    delete = Gtk.Button(label="Konto löschen")
    delete.connect("clicked", lambda _b: set_status("GELÖSCHT"))
    for w in (entry, save, delete, status):
        box.pack_start(w, False, False, 0)
    win.add(box)
    win.connect("destroy", Gtk.main_quit)
    win.show_all()
    Gtk.main()


if __name__ == "__main__":
    main()
