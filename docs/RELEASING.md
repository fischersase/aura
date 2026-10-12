# Releases

## Ablauf

1. Änderungen per Pull Request nach `main` (geschützt: alle Prüfungen grün, Squash-Merge).
2. Für eine neue Version `version` in `package.json` erhöhen (Semantic Versioning).
3. Der Merge startet `.github/workflows/release.yml`:
   - **Tests:** `ci.yml` läuft, also Linux, Windows und JavaScript.
   - **Windows-Installer** `Aura-Setup.exe` wird gebaut, mit gebündeltem Python und Selbsttest.
   - **AppImage und `.deb`** werden gebaut.
   - **Release `v<version>`:** Er bekommt automatisch erzeugte Notizen, `SHA256SUMS` und eine Build-Attestation.
   - **apt-Paketquelle** auf GitHub Pages wird aktualisiert: `https://fischersase.github.io/aura/apt`, signiert.

Feste Download-Links (immer die neueste Version):
`releases/latest/download/Aura-Setup.exe`, `…/aura_amd64.deb`, `…/Aura-x86_64.AppImage`, `…/SHA256SUMS`.

## apt-Paketquelle und Signierschlüssel

- **Geheime Schlüssel:** nur als Secrets, ohne Passphrase und ohne Kopie auf einem Rechner.
  - `APT_SIGNING_KEY` (Repository-Secret, alter Schlüssel `2D1C 8196 491F 9E92 A004  F4AE 102E AFB1 7FC8 5F90`).
  - `APT_SIGNING_KEY_NEXT` (Secret der Umgebung `github-pages`, also nur für Deploy-Jobs von `main` lesbar; neuer Schlüssel `868F 8CD6 AA8A 4427 E924  3587 21C1 6696 774D 4865`).
  - Beide Ed25519, gültig bis Oktober 2031.
- **Öffentlicher Teil:** `packaging/linux/aura-archive-keyring.asc` ist die einzige Quelle. Das `.deb` installiert die Datei als `/usr/share/keyrings/aura-archive-keyring.asc`; dieselbe Datei liegt auf Pages.
- **Ersteinrichtung des Pakets:** Das `.deb` trägt bei der Installation `/etc/apt/sources.list.d/aura.sources` ein (`packaging/linux/after-install.sh`), `apt remove` entfernt den Eintrag wieder.
  - Das geschieht nur, wenn die Quelle erreichbar ist; jedes spätere Update versucht es erneut.
  - Abschalten: `echo AURA_APT_REPO=no | sudo tee /etc/default/aura`.
- **Signieren (`scripts/build-apt-repo.sh`):**
  - Vorher wird das `.deb` gegen `SHA256SUMS` des Releases und seine Build-Attestation geprüft.
  - Signiert wird mit jedem vorhandenen Schlüssel; Clients, die nur einen davon kennen, akzeptieren die Quelle.
  - Abbruch, wenn ein Schlüssel nicht im öffentlichen Keyring steht.
  - `Release` trägt `Valid-Until` (30 Tage) gegen Freeze-Angriffe. `apt-repo.yml` signiert deshalb jeden Montag neu.
- **Laufende Schlüsselrotation (AURA-22):** Seit 0.11.1 signieren beide Schlüssel, und jedes Paket bringt beide mit.
  Ab dem übernächsten Release (sobald die meisten Installationen 0.11.1 oder neuer haben):
  1. Repository-Secret `APT_SIGNING_KEY` löschen. In den Workflows `APT_SIGNING_KEY: ${{ secrets.APT_SIGNING_KEY_NEXT }}` übergeben und die Zeile `APT_SIGNING_KEY_NEXT` entfernen (Secrets sind nicht lesbar, deshalb kein Umkopieren).
  2. Den alten Schlüssel aus `aura-archive-keyring.asc` entfernen, README anpassen, Release erstellen.
- **Künftige Rotationen:** neuen Schlüssel erzeugen, öffentlich zusätzlich in den Keyring, geheim als Umgebungs-Secret; ein Release mit Doppelsignatur; danach den alten entfernen.
  Ist ein Schlüssel kompromittiert: sofort aus Keyring und Secrets entfernen und einen Release erstellen. Nutzer, deren Keyring nur den kompromittierten Schlüssel kennt, installieren einmal das neue `.deb` von der Release-Seite.
- **Platz und Datenverkehr:** GitHub Pages erlaubt 1 GB pro Seite und rund 100 GB Datenverkehr im Monat. Die Quelle enthält nur das neueste Paket (ca. 150 MB).

## Windows

- **Signierung:** Der Installer ist noch unsigniert, deshalb warnt SmartScreen. Eine Code-Signatur (z. B. Azure Trusted Signing) wäre der nächste Schritt.
- **Updates:** den neuen Installer ausführen.

## Repository-Regeln

`.github/rulesets/main.json` beschreibt den Schutz von `main`. Einspielen bzw. aktualisieren:

```bash
gh api -X POST repos/fischersase/aura/rulesets --input .github/rulesets/main.json
```
