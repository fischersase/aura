#!/usr/bin/env bash
# Baut die mitgelieferte Python-Laufzeit für Agent v2 nach build/agent-python (docs/adr/0006).
# python-build-standalone 3.12 (über uv) + gesperrte Abhängigkeiten aus agent/uv.lock (mit Hashes)
# + das Paket aura_agent. Danach Ausdünnen, Größenprüfung und Selbsttest im fertigen Bündel.
# Aufruf: bash scripts/build-agent.sh   (braucht uv: https://docs.astral.sh/uv/)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build"
OUT="$BUILD/agent-python"
PY_VERSION="3.12"
MAX_MB=200

rm -rf "$OUT" "$BUILD/agent-dl" "$BUILD/agent-wheel"
mkdir -p "$BUILD"

uv python install "$PY_VERSION" --install-dir "$BUILD/agent-dl" --no-bin
SRC="$(ls -d "$BUILD"/agent-dl/cpython-"$PY_VERSION".*-linux-x86_64-gnu | head -1)"
cp -a "$SRC" "$OUT"
PY="$OUT/bin/python3"

cd "$ROOT/agent"
uv export --frozen --no-dev --no-emit-project --format requirements-txt > "$BUILD/agent-requirements.txt"
uv pip install --python "$PY" --break-system-packages --require-hashes --no-deps -r "$BUILD/agent-requirements.txt"
uv build --wheel --out-dir "$BUILD/agent-wheel"
uv pip install --python "$PY" --break-system-packages --no-deps "$BUILD"/agent-wheel/*.whl

# Ausdünnen: Testsuite, IDLE, Tk, Header und Doku braucht der Agent nicht.
rm -rf "$OUT"/lib/python"$PY_VERSION"/{test,idlelib,tkinter,turtledemo,ensurepip,lib2to3} \
  "$OUT"/lib/libtcl* "$OUT"/lib/libtk* "$OUT"/lib/tcl* "$OUT"/lib/tk* "$OUT"/lib/itcl* "$OUT"/lib/thread* \
  "$OUT"/include "$OUT"/share
rm -rf "$OUT"/lib/python"$PY_VERSION"/site-packages/pip "$OUT"/lib/python"$PY_VERSION"/site-packages/pip-*.dist-info "$OUT"/bin/pip*
find "$OUT" -name __pycache__ -type d -prune -exec rm -rf {} +
# Debug-Symbole entfernen (libpython allein hat sonst ~30 MB).
if command -v strip >/dev/null; then
  find "$OUT" -name '*.so*' -type f -exec strip --strip-unneeded {} + 2>/dev/null || true
fi
"$PY" -m compileall -q -j 0 "$OUT/lib/python$PY_VERSION" >/dev/null || true

SIZE="$(du -sm "$OUT" | cut -f1)"
echo "Agent-Python: ${SIZE} MB"
if [ "$SIZE" -gt "$MAX_MB" ]; then
  echo "Zu groß: ${SIZE} MB > ${MAX_MB} MB (docs/adr/0006)" >&2
  exit 1
fi

# Browser-Server (Playwright-MCP) mitliefern; Aura startet ihn mit Electron als Node (ELECTRON_RUN_AS_NODE=1).
PLAYWRIGHT_MCP="$(grep -oP 'PLAYWRIGHT_MCP = "\K[^"]+' "$ROOT/agent/src/aura_agent/tools/browser.py")"
rm -rf "$BUILD/browser-mcp" && mkdir -p "$BUILD/browser-mcp"
npm install --prefix "$BUILD/browser-mcp" --omit=dev --no-audit --no-fund --no-save "$PLAYWRIGHT_MCP" >/dev/null
test -f "$BUILD/browser-mcp/node_modules/@playwright/mcp/cli.js"
echo "Browser-Server: $PLAYWRIGHT_MCP ($(du -sm "$BUILD/browser-mcp" | cut -f1) MB)"

# Selbsttest im fertigen Bündel, isoliert von allem außerhalb (-I).
"$PY" -I -m aura_agent --selftest
echo "Agent-Python fertig: $OUT"
