#!/usr/bin/env bash
# Baut die apt-Paketquelle für GitHub Pages: nur das neueste Aura-Paket, signiert (InRelease, Release.gpg),
# dazu den öffentlichen Schlüssel und die Startseite (packaging/site).
# Aufruf: APT_SIGNING_KEY="$(cat geheim.asc)" bash scripts/build-apt-repo.sh <aura_amd64.deb> <version> <ausgabeordner>
set -euo pipefail

deb="$1"; version="$2"; out="$3"
root="$(cd "$(dirname "$0")/.." && pwd)"
: "${APT_SIGNING_KEY:?Signierschlüssel fehlt (Secret APT_SIGNING_KEY)}"

rm -rf "$out"
mkdir -p "$out/apt/pool/main" "$out/apt/dists/stable/main/binary-amd64"
cp "$root/packaging/site/index.html" "$out/index.html"
cp "$root/packaging/linux/aura-archive-keyring.asc" "$out/aura-archive-keyring.asc"
touch "$out/.nojekyll"
cp "$deb" "$out/apt/pool/main/aura-desktop_${version}_amd64.deb"

cd "$out/apt"
dpkg-scanpackages --arch amd64 pool/ > dists/stable/main/binary-amd64/Packages
gzip -9 -k dists/stable/main/binary-amd64/Packages
apt-ftparchive \
  -o APT::FTPArchive::Release::Origin=Aura -o APT::FTPArchive::Release::Label=Aura \
  -o APT::FTPArchive::Release::Suite=stable -o APT::FTPArchive::Release::Codename=stable \
  -o APT::FTPArchive::Release::Architectures=amd64 -o APT::FTPArchive::Release::Components=main \
  -o "APT::FTPArchive::Release::Description=Aura desktop assistant" \
  release dists/stable > dists/stable/Release

GNUPGHOME="$(mktemp -d)"; export GNUPGHOME
trap 'rm -rf "$GNUPGHOME"' EXIT
printf '%s\n' "$APT_SIGNING_KEY" | gpg --batch --quiet --import
key="$(gpg --list-secret-keys --with-colons | awk -F: '/^fpr/{print $10; exit}')"
# Nur mit dem Schlüssel signieren, der auch im Paket steckt.
gpg --batch --quiet --import "$root/packaging/linux/aura-archive-keyring.asc"
if ! gpg --with-colons --import-options show-only --import "$root/packaging/linux/aura-archive-keyring.asc" | grep -q "$key"; then
  echo "APT_SIGNING_KEY passt nicht zu packaging/linux/aura-archive-keyring.asc" >&2
  exit 1
fi
gpg --batch --yes --pinentry-mode loopback --local-user "$key" --clearsign -o dists/stable/InRelease dists/stable/Release
gpg --batch --yes --pinentry-mode loopback --local-user "$key" -abs -o dists/stable/Release.gpg dists/stable/Release
echo "Paketquelle fertig: $(du -sh "$out" | cut -f1), Aura $version, Schlüssel $key"
