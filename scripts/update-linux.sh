#!/usr/bin/env bash
# Lädt das neueste Aura-.deb aus den GitHub-Releases und installiert es (Ubuntu/Debian).
# Aufruf: make update   (oder: bash scripts/update-linux.sh; FORCE=1 installiert auch bei gleicher oder älterer Version)
#         make local    (--local: den Stand dieses Checkouts bauen und installieren, z. B. einen Branch vor dem Release)
# Ohne Checkout geht es mit der Paketquelle: sudo apt update && sudo apt upgrade (siehe README).
set -euo pipefail

REPO="fischersase/aura"
ASSET="aura_amd64.deb"
PKG="aura-desktop"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
deb="$tmp/$ASSET"

installed="$(dpkg-query -W -f='${Version}' "$PKG" 2>/dev/null || true)"
echo "Installiert: ${installed:-keine}"

install_and_restart() {
  # Prüfen, dass wirklich ein .deb angekommen ist (und keine Fehlerseite)
  dpkg-deb --info "$1" >/dev/null
  # --reinstall: gleiche Versionsnummer, aber neuer Stand (Testbau); --allow-downgrades nur, wenn ausdrücklich gewollt
  sudo apt install -y --reinstall ${FORCE:+--allow-downgrades} "$1"
  # Laufendes Aura beenden und neu starten
  pkill -f /opt/Aura/aura 2>/dev/null || true
  sleep 1
  if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    nohup setsid aura >/dev/null 2>&1 &
    echo "Aura neu gestartet."
  fi
  echo "Jetzt installiert: $(dpkg-query -W -f='${Version}' "$PKG")"
}

if [ "${1:-}" = "--local" ]; then
  root="$(cd "$(dirname "$0")/.." && pwd)"
  version="$(node -p "require('$root/package.json').version")"
  echo "Baue Aura $version aus $(git -C "$root" rev-parse --abbrev-ref HEAD) ($(git -C "$root" rev-parse --short HEAD)) … (einige Minuten)"
  (cd "$root" && npm run dist:linux)
  FORCE=1 install_and_restart "$root/dist/Aura-$version-amd64.deb"
  exit 0
fi

# Mit eingetragener Aura-Paketquelle ist apt der normale Weg.
if [ -z "${FORCE:-}" ] && [ -e /etc/apt/sources.list.d/aura.sources ]; then
  sudo apt update -q && sudo apt install -y --only-upgrade "$PKG"
  echo "Jetzt installiert: $(dpkg-query -W -f='${Version}' "$PKG")"
  exit 0
fi

up_to_date() {
  local latest="${1#v}"
  [ -z "$installed" ] || [ -n "${FORCE:-}" ] && return 0
  if [ "$latest" = "$installed" ]; then
    echo "Aura $installed ist schon die neueste Version. (FORCE=1 make update installiert trotzdem neu.)"
    exit 0
  fi
  if dpkg --compare-versions "$installed" gt "$latest"; then
    echo "Installiert ist $installed, also neuer als das neueste Release $latest (ein Testbau, z. B. mit make local)."
    echo "Nichts zu tun. Zurück auf das Release: FORCE=1 make update"
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
elif curl -fsSL -o "$deb" "https://github.com/$REPO/releases/latest/download/$ASSET"; then
  echo "Neueste Version heruntergeladen."
else
  echo "Download nicht möglich (keine Verbindung zu GitHub?)." >&2
  exit 1
fi

install_and_restart "$deb"
