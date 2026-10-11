#!/usr/bin/env bash
# Lädt das neueste Aura-.deb aus den GitHub-Releases und installiert es (Ubuntu/Debian).
# Aufruf: make update   (oder: bash scripts/update-linux.sh; FORCE=1 installiert auch bei gleicher Version)
# Das Repository ist privat: Download über die GitHub-CLI (gh auth login) oder ein Token in GITHUB_TOKEN.
set -euo pipefail

REPO="fischersase/aura"
ASSET="aura_amd64.deb"
PKG="aura-desktop"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
deb="$tmp/$ASSET"

installed="$(dpkg-query -W -f='${Version}' "$PKG" 2>/dev/null || true)"
echo "Installiert: ${installed:-keine}"

up_to_date() {
  if [ -n "$installed" ] && [ "${1#v}" = "$installed" ] && [ -z "${FORCE:-}" ]; then
    echo "Aura $installed ist schon die neueste Version. (FORCE=1 make update installiert trotzdem neu.)"
    exit 0
  fi
}

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  tag="$(gh release view -R "$REPO" --json tagName -q .tagName)"
  echo "Neueste Version: $tag"
  up_to_date "$tag"
  gh release download "$tag" -R "$REPO" -p "$ASSET" -D "$tmp"
elif [ -n "${GITHUB_TOKEN:-}" ]; then
  auth=(-H "Authorization: Bearer $GITHUB_TOKEN" -H "X-GitHub-Api-Version: 2022-11-28")
  json="$(curl -fsSL "${auth[@]}" "https://api.github.com/repos/$REPO/releases/latest")"
  tag="$(printf '%s' "$json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')"
  url="$(printf '%s' "$json" | python3 -c 'import json,sys; print(next(a["url"] for a in json.load(sys.stdin)["assets"] if a["name"]==sys.argv[1]))' "$ASSET")"
  echo "Neueste Version: $tag"
  up_to_date "$tag"
  curl -fL --progress-bar "${auth[@]}" -H "Accept: application/octet-stream" -o "$deb" "$url"
elif curl -fsSL -o "$deb" "https://github.com/$REPO/releases/latest/download/$ASSET" 2>/dev/null; then
  echo "Neueste Version heruntergeladen."
else
  cat >&2 <<'MSG'
Download nicht möglich: Das Repository ist privat.
Einmalig die GitHub-CLI einrichten und dann erneut "make update" ausführen:
  sudo apt install gh
  gh auth login
MSG
  exit 1
fi

# Prüfen, dass wirklich ein .deb angekommen ist (und keine Fehlerseite)
dpkg-deb --info "$deb" >/dev/null

sudo apt install -y "$deb"

# Laufendes Aura beenden und neu starten
pkill -f /opt/Aura/aura 2>/dev/null || true
sleep 1
if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  nohup setsid aura >/dev/null 2>&1 &
  echo "Aura neu gestartet."
fi
echo "Jetzt installiert: $(dpkg-query -W -f='${Version}' "$PKG")"
