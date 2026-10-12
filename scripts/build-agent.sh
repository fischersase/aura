#!/usr/bin/env bash
# Baut die mitgelieferte Python-Laufzeit für Agent v2 nach build/agent-python (docs/adr/0006).
# python-build-standalone 3.12 (über uv) + gesperrte Abhängigkeiten aus agent/uv.lock (mit Hashes)
# + das Paket aura_agent. Danach Ausdünnen, Größenprüfung und Selbsttest im fertigen Bündel.
# Aufruf: bash scripts/build-agent.sh   (braucht uv: https://docs.astral.sh/uv/)
# Läuft unter Linux und unter Windows (Git Bash, z. B. auf dem windows-latest-Runner).
set -euo pipefail
umask 022 # keine gruppen-schreibbaren Dateien im Paket (lintian, reproduzierbare Rechte)

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build"
OUT="$BUILD/agent-python"
PY_VERSION="3.12"
MAX_MB=230
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) WINDOWS=1 ;;
  *) WINDOWS=0 ;;
esac

rm -rf "$OUT" "$BUILD/agent-dl" "$BUILD/agent-wheel"
mkdir -p "$BUILD"

uv python install "$PY_VERSION" --install-dir "$BUILD/agent-dl" --no-bin
if [ "$WINDOWS" = 1 ]; then
  SRC="$(ls -d "$BUILD"/agent-dl/cpython-"$PY_VERSION".*-windows-x86_64-none | head -1)"
  cp -a "$SRC" "$OUT"
  PY="$OUT/python.exe"
  LIB="$OUT/Lib"
else
  SRC="$(ls -d "$BUILD"/agent-dl/cpython-"$PY_VERSION".*-linux-x86_64-gnu | head -1)"
  cp -a "$SRC" "$OUT"
  PY="$OUT/bin/python3"
  LIB="$OUT/lib/python$PY_VERSION"
fi

cd "$ROOT/agent"
uv export --frozen --no-dev --no-emit-project --format requirements-txt > "$BUILD/agent-requirements.txt"
uv pip install --python "$PY" --break-system-packages --require-hashes --no-deps -r "$BUILD/agent-requirements.txt"
uv build --wheel --out-dir "$BUILD/agent-wheel"
uv pip install --python "$PY" --break-system-packages --no-deps "$BUILD"/agent-wheel/*.whl

if [ "$WINDOWS" = 1 ]; then
  # UI-Automation-Schnittstellen einmal erzeugen (comtypes schreibt sie nach comtypes/gen); sonst beim ersten Start.
  "$PY" -I -c "import comtypes.client; comtypes.client.GetModule('UIAutomationCore.dll')"
fi

# Ausdünnen: Testsuite, IDLE, Tk, Header und Doku braucht der Agent nicht.
rm -rf "$LIB"/{test,idlelib,tkinter,turtledemo,ensurepip,lib2to3} "$OUT"/include "$OUT"/share
rm -rf "$LIB"/site-packages/pip "$LIB"/site-packages/pip-*.dist-info "$OUT"/bin/pip* "$OUT"/Scripts/pip*
if [ "$WINDOWS" = 1 ]; then
  rm -rf "$OUT"/tcl "$OUT"/libs "$OUT"/DLLs/_tkinter.pyd "$OUT"/DLLs/tcl*.dll "$OUT"/DLLs/tk*.dll
  # Startskripte der Pakete (adk.exe, uvicorn.exe …) braucht Aura nicht; es startet nur "python -m aura_agent".
  rm -rf "$OUT"/Scripts
else
  rm -rf "$OUT"/lib/libtcl* "$OUT"/lib/libtk* "$OUT"/lib/tcl* "$OUT"/lib/tk* "$OUT"/lib/itcl* "$OUT"/lib/thread* \
    "$LIB"/lib-dynload/_tkinter.* "$LIB"/config-"$PY_VERSION"-*  # config-*: nur zum Kompilieren von C-Erweiterungen
  # Nur der Interpreter bleibt. Die Startskripte der Pakete (adk, uvicorn …) enthalten den absoluten Pfad dieses
  # Build-Ordners als Interpreter und werden nicht gebraucht; IDLE, pydoc, 2to3, *-config ebenso.
  find "$OUT/bin" -mindepth 1 ! -name 'python3.12' ! -name 'python3' ! -name 'python' -exec rm -rf {} +
fi
find "$OUT" -name __pycache__ -type d -prune -exec rm -rf {} +
# Kein strip: python-build-standalone ist schon schlank (strip spart ~1 MB), und strip auf der Programmdatei
# python3.12 beschädigt sie ("symbol lookup error"). Gemessen am 12.10.2026 (AURA-21).
"$PY" -m compileall -q -j 0 "$LIB" >/dev/null || true

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
