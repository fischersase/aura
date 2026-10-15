#!/usr/bin/env bash
# Vollautomatisches Produktiv-Release:
# Aufruf: make prod-release [BUMP=patch|minor|major] [VERSION=0.14.0]
# 1. Ermittelt Zielversion
# 2. Klont sauberen Stand in temporären Ordner (isoliert von offenen Änderungen)
# 3. Erzeugt Release-Branch, setzt Version, öffnet PR
# 4. Wartet automatisch auf CI und mergt per Squash
# 5. Der GitHub Release-Workflow baut das Release (.deb, .AppImage, .exe)
set -euo pipefail

REPO="fischersase/aura"
root="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v gh >/dev/null 2>&1; then
  echo "Fehler: gh CLI ist nicht installiert." >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "Fehler: gh CLI ist nicht angemeldet. Bitte 'gh auth login' ausführen." >&2
  exit 1
fi

BUMP="${1:-}"
EXPLICIT_VERSION="${2:-}"

git -C "$root" fetch origin main

current_version="$(node -p "require('$root/package.json').version")"
echo "Aktuelle Version: $current_version"

if [ -n "$EXPLICIT_VERSION" ]; then
  target_version="$EXPLICIT_VERSION"
elif [ -n "$BUMP" ] && [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  target_version="$BUMP"
else
  bump_kind="${BUMP:-patch}"
  target_version="$(python3 -c "
v = '$current_version'.split('.')
major, minor, patch = int(v[0]), int(v[1]), int(v[2])
kind = '$bump_kind'
if kind == 'minor':
    print(f'{major}.{minor+1}.0')
elif kind == 'major':
    print(f'{major+1}.0.0')
else:
    print(f'{major}.{minor}.{patch+1}')
")"
fi

tag="v$target_version"
echo "Release wird vorbereitet: $target_version ($tag)"

if gh api "repos/$REPO/git/ref/tags/$tag" >/dev/null 2>&1; then
  echo "Fehler: Tag $tag existiert bereits auf GitHub!" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
echo "Klone sauberen Stand..."
git clone --branch main "$root" "$tmp_dir"
git -C "$tmp_dir" remote set-url origin "git@github.com:$REPO.git"
git -C "$tmp_dir" fetch origin main
git -C "$tmp_dir" reset --hard origin/main

branch="release-$target_version"
git -C "$tmp_dir" checkout -b "$branch"

echo "Aktualisiere package.json auf $target_version..."
(cd "$tmp_dir" && npm version "$target_version" --no-git-tag-version)

git -C "$tmp_dir" commit -am "chore(release): $target_version"
echo "Pushe Release-Branch $branch..."
git -C "$tmp_dir" push -u origin "$branch"

echo "Erstelle Release-PR..."
pr_url="$(gh pr create -R "$REPO" \
  --base main \
  --head "$branch" \
  --title "chore(release): $target_version" \
  --body "Release $target_version triggered via make prod-release ($(date +'%Y-%m-%d')).")"

echo "PR erstellt: $pr_url"
pr_num="$(echo "$pr_url" | grep -oE '[0-9]+$')"

echo "Warte auf CI-Checks..."
gh pr checks "$pr_num" -R "$REPO" --watch

echo "Checks erfolgreich! Merge nach main..."
gh pr merge "$pr_num" -R "$REPO" --squash --delete-branch

echo ""
echo "🎉 Version $target_version wurde erfolgreich nach main gemergt!"
echo "GitHub Actions baut jetzt das offizielle Release (.deb, .AppImage, .exe)."
echo "Status verfolgen: gh run list --workflow=Release"
