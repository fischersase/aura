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

- **Geheimer Teil:** Er liegt nur als Actions-Secret `APT_SIGNING_KEY` im Repository, ohne Passphrase und ohne Kopie auf einem Rechner.
- **Öffentlicher Teil:** `packaging/linux/aura-archive-keyring.asc`. Er wird mit jedem `.deb` installiert und auf Pages veröffentlicht.
  - Fingerabdruck: `2D1C 8196 491F 9E92 A004  F4AE 102E AFB1 7FC8 5F90`.
  - Ed25519, gültig bis Oktober 2031.
- **Ersteinrichtung des Pakets:** Das `.deb` trägt bei der Installation `/etc/apt/sources.list.d/aura.sources` ein (`packaging/linux/after-install.sh`).
  - Das geschieht nur, wenn die Quelle erreichbar ist; jedes spätere Update versucht es erneut.
  - Abschalten: `echo AURA_APT_REPO=no | sudo tee /etc/default/aura`.
- **`build-apt-repo.sh`** bricht ab, wenn das Secret nicht zum öffentlichen Schlüssel im Repository passt.
- **Schlüssel erneuern (vor Ablauf oder wenn er kompromittiert ist), in zwei Releases:**
  1. Neues Schlüsselpaar erzeugen. Den neuen öffentlichen Schlüssel **zusätzlich** in `packaging/linux/aura-archive-keyring.asc` und in die eingebettete Kopie in `packaging/linux/after-install.sh` aufnehmen.
  2. Release erstellen. Er ist noch mit dem alten Schlüssel signiert, bringt aber beide Schlüssel auf die Rechner.
  3. `gh secret set APT_SIGNING_KEY` mit dem neuen geheimen Schlüssel setzen und den alten aus beiden Dateien entfernen.
  4. Nächsten Release erstellen.

  Ist der alte Schlüssel kompromittiert, entfällt Schritt 2. Die Nutzer müssen dann einmal das neue `.deb` von der Release-Seite installieren.
- **Platz und Datenverkehr:** GitHub Pages erlaubt 1 GB pro Seite und rund 100 GB Datenverkehr im Monat. Die Quelle enthält nur das neueste Paket (ca. 150 MB).

## Windows

- **Signierung:** Der Installer ist noch unsigniert, deshalb warnt SmartScreen. Eine Code-Signatur (z. B. Azure Trusted Signing) wäre der nächste Schritt.
- **Updates:** den neuen Installer ausführen.

## Repository-Regeln

`.github/rulesets/main.json` beschreibt den Schutz von `main`. Einspielen bzw. aktualisieren:

```bash
gh api -X POST repos/fischersase/aura/rulesets --input .github/rulesets/main.json
```
