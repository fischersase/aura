#!/usr/bin/env bash
# Startet eine abgeschottete, unsichtbare GNOME-Shell (Wayland) mit der Erweiterung aura-bridge, ein GTK-Testfenster
# und führt dann den übergebenen Befehl aus. Mit leerer Umgebung aufrufen (env -i), damit fremde Schema-Pfade
# (z. B. aus einem Snap-Terminal) die GNOME-Shell nicht stören.
set -u
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
T=$(mktemp -d)
mkdir -p "$T/config" "$T/data/gnome-shell/extensions" "$T/runtime"
chmod 700 "$T/runtime"
cp -r "$REPO/gnome-extension/aura-bridge@aura" "$T/data/gnome-shell/extensions/"
export XDG_DATA_DIRS=/usr/local/share:/usr/share XDG_CONFIG_HOME="$T/config" XDG_DATA_HOME="$T/data" XDG_RUNTIME_DIR="$T/runtime" GSETTINGS_BACKEND=keyfile
export AURA_TEST_CMD="$*" REPO
dbus-run-session -- bash -c '
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions "[\"aura-bridge@aura\"]"
gnome-shell --headless --wayland --virtual-monitor 1280x800 >/dev/null 2>&1 &
SHELL_PID=$!
for i in $(seq 1 60); do gdbus introspect --session --dest org.aura.Bridge --object-path /org/aura/Bridge >/dev/null 2>&1 && break; sleep 0.5; done
WAYLAND_DISPLAY=wayland-0 GDK_BACKEND=wayland /usr/bin/python3 "$REPO/agent/src/aura_agent/testing/gtk_app.py" 2>/dev/null &
APP=$!
sleep 2
XDG_SESSION_TYPE=wayland bash -c "$AURA_TEST_CMD"
STATUS=$?
kill $APP $SHELL_PID 2>/dev/null
exit $STATUS'
STATUS=$?
rm -rf "$T"
exit $STATUS
