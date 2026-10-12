#!/usr/bin/env bash
# Builds the apt repository for GitHub Pages: the latest Aura package, signed (InRelease, Release.gpg), plus the
# public keyring and the landing page (packaging/site).
#
# Usage: APT_SIGNING_KEY=… [APT_SIGNING_KEY_NEXT=…] bash scripts/build-apt-repo.sh <aura_amd64.deb> <version> <out-dir>
#
# - Every provided signing key must be in packaging/linux/aura-archive-keyring.asc (the keyring shipped in the
#   package); the Release file is signed with all of them, so clients that know only one of the keys still verify
#   it (key rotation, docs/RELEASING.md).
# - Release has Valid-Until (VALID_DAYS, default 30) against freeze attacks; apt-repo.yml re-signs weekly.
set -euo pipefail

deb="$1"; version="$2"; out="$3"
root="$(cd "$(dirname "$0")/.." && pwd)"
keyring="$root/packaging/linux/aura-archive-keyring.asc"
valid_days="${VALID_DAYS:-30}"
: "${APT_SIGNING_KEY:?signing key missing (secret APT_SIGNING_KEY)}"

rm -rf "$out"
mkdir -p "$out/apt/pool/main" "$out/apt/dists/stable/main/binary-amd64"
cp "$root/packaging/site/index.html" "$out/index.html"
cp "$keyring" "$out/aura-archive-keyring.asc"
touch "$out/.nojekyll"
cp "$deb" "$out/apt/pool/main/aura-desktop_${version}_amd64.deb"

cd "$out/apt"
dpkg-scanpackages --arch amd64 pool/ > dists/stable/main/binary-amd64/Packages
gzip -9 -k dists/stable/main/binary-amd64/Packages
valid_until="$(date -u -d "+${valid_days} days" '+%a, %d %b %Y %H:%M:%S UTC')"
# Write to a temporary file first: redirecting straight into dists/stable/Release made apt-ftparchive hash its own
# half-written output.
release_tmp="$(mktemp)"
apt-ftparchive \
  -o APT::FTPArchive::Release::Origin=Aura -o APT::FTPArchive::Release::Label=Aura \
  -o APT::FTPArchive::Release::Suite=stable -o APT::FTPArchive::Release::Codename=stable \
  -o APT::FTPArchive::Release::Architectures=amd64 -o APT::FTPArchive::Release::Components=main \
  -o "APT::FTPArchive::Release::Description=Aura desktop assistant" \
  release dists/stable > "$release_tmp"
{ head -n1 "$release_tmp"; echo "Valid-Until: $valid_until"; tail -n +2 "$release_tmp"; } > dists/stable/Release
rm -f "$release_tmp"

GNUPGHOME="$(mktemp -d)"; export GNUPGHOME
trap 'rm -rf "$GNUPGHOME"' EXIT
gpg --batch --quiet --import "$keyring"
shipped="$(gpg --with-colons --list-keys | awk -F: '/^fpr/{print $10}')"
signers=()
for secret in "${APT_SIGNING_KEY}" "${APT_SIGNING_KEY_NEXT:-}"; do
  [ -n "$secret" ] || continue
  before="$(gpg --with-colons --list-secret-keys | awk -F: '/^fpr/{print $10}' | sort)"
  printf '%s\n' "$secret" | gpg --batch --quiet --import
  key="$(comm -13 <(echo "$before") <(gpg --with-colons --list-secret-keys | awk -F: '/^fpr/{print $10}' | sort) | head -1)"
  if ! grep -qx "$key" <<<"$shipped"; then
    echo "Signing key $key is not in packaging/linux/aura-archive-keyring.asc" >&2
    exit 1
  fi
  signers+=(--local-user "$key")
done
gpg --batch --yes --pinentry-mode loopback "${signers[@]}" --clearsign -o dists/stable/InRelease dists/stable/Release
gpg --batch --yes --pinentry-mode loopback "${signers[@]}" -abs -o dists/stable/Release.gpg dists/stable/Release
echo "apt repository ready: Aura $version, signed by $(( ${#signers[@]} / 2 )) key(s), valid until $valid_until"
