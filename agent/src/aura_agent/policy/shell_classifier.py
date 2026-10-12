"""Stufe eines Shell-Befehls bestimmen: bash unter Linux, PowerShell unter Windows (powershell_classifier.py).

Liste lesender Befehle und riskanter Schalter (übernommen aus src/agent/tools.js),
Sperrliste für Zugangsdaten. Alles Unbekannte ist T2 und fragt.

Grundsatz (AURA-13): Was andere Programme startet, Code ausführt oder Eingaben simuliert, ist nie
„nur lesend“, auch wenn es meist zum Lesen benutzt wird (env, awk, xargs, xdotool … exec, ip netns exec).
Umgebungsvariablen können Schlüssel enthalten; sie auszugeben fragt ebenfalls.
"""

from __future__ import annotations

import re
import shlex

from ..harness.tiers import Tier
from ..platform.base import IS_WINDOWS
from .paths import ENFORCEMENT_IN_COMMAND

READONLY = {
    "ls", "pwd", "whoami", "hostname", "date", "uname", "uptime", "df", "du", "free", "cat", "head", "tail",
    "wc", "which", "file", "stat", "find", "fd", "fdfind", "locate", "plocate", "grep", "rg", "sort", "uniq",
    "echo", "ps", "pgrep", "lsblk", "lscpu", "lsusb", "lspci", "nvidia-smi", "ip", "tree",
    "id", "groups", "lsb_release", "hostnamectl", "sensors", "xdg-user-dir", "pactl", "wpctl", "playerctl",
    "wmctrl", "xprop", "xdotool", "gsettings", "busctl", "systemctl", "journalctl", "dpkg", "apt", "snap",
    "flatpak", "ollama", "git", "python3", "node", "cut", "tr", "basename", "dirname", "realpath",
    "readlink", "md5sum", "sha256sum", "diff", "cmp", "column", "jq", "less", "more", "nproc", "lsof", "ss",
    "loginctl", "timedatectl", "localectl", "xrandr", "lsmod", "dmesg", "last", "w", "who",
}

# Unterbefehle, die bei sonst lesenden Programmen nur lesen.
READONLY_SUBCOMMANDS = {
    "pactl": {"list", "info", "get-sink-volume", "get-sink-mute", "get-default-sink", "get-default-source"},
    "wpctl": {"status", "get-volume", "inspect"},
    "playerctl": {"status", "metadata", "-l", "--list-all", "position", "volume", "shuffle", "loop"},
    "wmctrl": {"-l", "-d", "-m", "-lp", "-lx", "-lG"},
    "xdotool": {"getactivewindow", "getwindowname", "getwindowfocus", "search", "getmouselocation", "getwindowgeometry", "getdisplaygeometry"},
    "gsettings": {"get", "list-keys", "list-schemas", "list-recursively", "range", "describe"},
    "busctl": {"list", "status", "tree", "introspect", "get-property", "--user"},
    "systemctl": {"status", "is-active", "is-enabled", "list-units", "list-unit-files", "show", "--user", "list-timers"},
    "journalctl": {"*"},
    "dpkg": {"-l", "-L", "-s", "--list", "--status", "-S", "--search", "--get-selections", "-W"},
    "apt": {"list", "show", "search", "policy"},
    "snap": {"list", "info", "find", "version"},
    "flatpak": {"list", "info", "search", "--version"},
    "ollama": {"list", "ps", "show", "--version", "-v"},
    "git": {"status", "log", "diff", "show", "branch", "remote", "rev-parse", "describe", "tag", "ls-files", "blame"},
    "ip": {"a", "addr", "address", "r", "route", "link", "-br", "-c", "neigh"},
    # "" = ohne Argumente
    "hostname": {"", "-f", "--fqdn", "-s", "--short", "-i", "--ip-address", "-I", "--all-ip-addresses", "-d", "--domain",
                 "-A", "--all-fqdns"},
    "hostnamectl": {"", "status"},
    "loginctl": {"", "list-sessions", "list-users", "list-seats", "show-session", "show-user", "show-seat", "session-status",
                 "user-status", "seat-status"},
    "timedatectl": {"", "status", "show", "list-timezones", "timesync-status", "show-timesync"},
    "localectl": {"", "status", "list-locales", "list-keymaps", "list-x11-keymap-models", "list-x11-keymap-layouts",
                  "list-x11-keymap-variants", "list-x11-keymap-options"},
}

# Programme, bei denen *jedes* Argument aus dieser Liste stammen muss (sonst könnten weitere Argumente Code ausführen,
# z. B. "python3 --version -c …" oder "xrandr --output X --off").
ALL_ARGS_IN = {
    "python3": {"--version", "-V"},
    "node": {"--version", "-v"},
    "xrandr": {"-q", "--query", "--listmonitors", "--listactivemonitors", "--verbose", "--current", "--prop", "--props"},
}

RISKY_ARGS = {
    "find": re.compile(r"(^|\s)-(delete|exec|execdir|ok|okdir|fprint\w*|fls)(\s|$)", re.IGNORECASE),
    "sort": re.compile(r"(^|\s)(-o|--output|--compress-program)"),
    "tree": re.compile(r"(^|\s)-o(\s|$)"),
    "fd": re.compile(r"(^|\s)(-x|-X|--exec\S*)(\s|$)"),
    "fdfind": re.compile(r"(^|\s)(-x|-X|--exec\S*)(\s|$)"),
    "date": re.compile(r"(^|\s)(-s|--set)"),
    "journalctl": re.compile(r"(^|\s)--(vacuum\S*|rotate|flush|sync|setup-keys|relinquish-var|smart-relinquish-var)"),
    "less": re.compile(r"."),  # interaktiv, nie sinnvoll
    "more": re.compile(r"."),
    # Schalter, die andere Programme starten, Dateien schreiben oder das System verändern
    "rg": re.compile(r"(^|\s)--pre(=|\s|$)"),
    "file": re.compile(r"(^|\s)(-C|--compile)(\s|$)"),
    "ip": re.compile(r"(^|\s)(add|del|delete|change|chg|replace|set|flush|append|prepend|save|restore|exec|netns|monitor|"
                     r"-b|-batch|--batch|-force|--force)(\s|$)"),
    "nvidia-smi": re.compile(r"(^|\s)(-pm|-pl|-e|-c|-r|-ac|-rac|-lgc|-rgc|-lmc|-rmc|-am|-caa|-mig|--persistence-mode\S*|"
                             r"--power-limit\S*|--ecc-config\S*|--compute-mode\S*|--gpu-reset|--applications-clocks\S*|"
                             r"--reset-applications-clocks|--lock-gpu-clocks\S*|--reset-gpu-clocks|--lock-memory-clocks\S*|"
                             r"--reset-memory-clocks|--auto-boost\S*|--multi-instance-gpu\S*)(\s|$)"),
    # xdotool verkettet Befehle: "search … exec rm …" oder "… key ctrl+alt+t" dürfen nicht als lesend durchgehen.
    "xdotool": re.compile(r"(^|\s)(key|keydown|keyup|type|mousemove|mousemove_relative|click|mousedown|mouseup|windowactivate|"
                          r"windowfocus|windowmap|windowunmap|windowminimize|windowraise|windowsize|windowmove|windowkill|"
                          r"windowclose|windowquit|windowstate|set_window|set_desktop|set_desktop_for_window|"
                          r"set_desktop_viewport|set_num_desktops|exec|behave|behave_screen_edge|sleep)(\s|$)"),
    "xprop": re.compile(r"(^|\s)-(set|remove)(\s|$)"),
    "sensors": re.compile(r"(^|\s)(-s|--set)(\s|$)"),
    "dmesg": re.compile(r"(^|\s)(-C|-c|--clear|--read-clear|-D|-E|--console-off|--console-on|-n|--console-level)(\s|=|$)"),
    "ss": re.compile(r"(^|\s)(-K|--kill)(\s|$)"),
    "apt": re.compile(r"(^|\s)(-o|--option|-c|--config-file)(\s|=|$)"),
    "git": re.compile(r"(^|\s)(--output|--ext-diff|--textconv|-c|--exec-path|--upload-pack|--open-files-in-pager|-O)(\s|=|$)"),
}

# Umgebungsvariablen, die keine Geheimnisse enthalten. Alles andere ($GEMINI_API_KEY …) fragt.
SAFE_ENV_VARS = {
    "HOME", "USER", "LOGNAME", "PWD", "OLDPWD", "SHELL", "LANG", "LANGUAGE", "LC_ALL", "TERM", "PATH", "HOSTNAME",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE",
    "XDG_CURRENT_DESKTOP", "XDG_DESKTOP_DIR", "XDG_DOWNLOAD_DIR", "XDG_DOCUMENTS_DIR", "DISPLAY", "WAYLAND_DISPLAY",
}

# git: Unterbefehle, die mit Argumenten etwas anlegen, löschen oder umbenennen.
GIT_WRITE_FLAGS = {
    "branch": {"-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy", "-f", "--force", "-u",
               "--set-upstream-to", "--unset-upstream", "--edit-description", "-t", "--track", "--no-track"},
    "tag": {"-d", "--delete", "-a", "--annotate", "-s", "--sign", "-u", "--local-user", "-f", "--force", "-m", "--message",
            "-F", "--file", "-e", "--edit"},
}
GIT_LIST_FLAGS = {"-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"}
GIT_REMOTE_READ = {"", "-v", "--verbose", "show", "get-url"}


def _git_reason(words: list[str]) -> str:
  """Grund, warum ein git-Aufruf nicht nur liest, sonst ""."""
  args = words[1:]
  sub = next((w for w in args if not w.startswith("-")), "")
  rest = args[args.index(sub) + 1:] if sub else []
  if sub in GIT_WRITE_FLAGS:
    if any(w.split("=")[0] in GIT_WRITE_FLAGS[sub] for w in rest):
      return f"„git {sub}“ mit verändernden Schaltern"
    if any(not w.startswith("-") for w in rest) and not any(w.split("=")[0] in GIT_LIST_FLAGS for w in rest):
      return f"„git {sub} <Name>“ legt etwas an"
  if sub == "remote":
    action = next((w for w in rest if not w.startswith("-")), "")
    if action not in GIT_REMOTE_READ:
      return f"„git remote {action}“ verändert die Gegenstellen"
  return ""


def _segment_reason(name: str, words: list[str]) -> str:
  """Zusätzliche Prüfungen je Programm; "" = nur lesend."""
  args = words[1:]
  allowed = ALL_ARGS_IN.get(name)
  if allowed is not None:
    if name == "xrandr":
      if any(a not in allowed for a in args):
        return "„xrandr“ verändert die Bildschirme"
    elif not args or any(a not in allowed for a in args):
      return f"„{name}“ mit weiteren Argumenten kann Code ausführen"
  if name == "git":
    return _git_reason(words)
  if name == "uniq" and sum(1 for a in args if not a.startswith("-")) >= 2:
    return "„uniq“ mit Ausgabedatei schreibt"
  # ps im BSD-Stil mit "e" zeigt die Umgebung aller Prozesse (kann Schlüssel enthalten)
  if name == "ps" and args and not args[0].startswith("-") and re.fullmatch(r"[A-Za-z]+", args[0]) and "e" in args[0]:
    return "„ps e“ zeigt Umgebungsvariablen"
  return ""


def _env_reason(c: str) -> str:
  """Lesen von Umgebungsvariablen, die Schlüssel enthalten können."""
  for m in re.finditer(r"\$([A-Za-z_][A-Za-z0-9_]*)", c):
    if m.group(1) not in SAFE_ENV_VARS:
      return f"liest die Umgebungsvariable ${m.group(1)} (kann Schlüssel enthalten)"
  if re.search(r"/proc/[^\s/]+/environ", c):
    return "liest die Umgebung eines Prozesses (kann Schlüssel enthalten)"
  return ""

# Zugangsdaten und Sicherheit: nie, egal wie gefragt wird.
FORBIDDEN = [
    (re.compile(r"(^|[\s/~])\.(ssh|gnupg|password-store)(/|\s|$)"), "SSH-/GPG-Schlüssel oder Passwortspeicher"),
    (re.compile(r"\.local/share/keyrings|login\.keyring"), "Schlüsselbund"),
    (re.compile(r"Login Data|Cookies|\.mozilla/firefox/[^/\s]+/(logins\.json|key4\.db|cookies\.sqlite)"), "Browser-Passwörter oder Cookies"),
    (re.compile(r"(^|\s)secret-tool(\s|$)"), "Schlüsselbund"),
    (re.compile(r"\.aura/secrets|Aura/secrets\.json"), "Aura-Schlüssel"),
    (re.compile(r"/etc/shadow|/etc/sudoers"), "Systempasswörter"),
    (re.compile(r"org\.gnome\.desktop\.(lockdown|privacy|screensaver)\s+\S+\s+\S"), "Sicherheitseinstellungen"),
    # Nicht rückgängig zu machen: ganzes System oder ganzer Benutzerordner.
    (re.compile(r"\brm\s+(-\w*\s+)*(/|~|\$HOME|/home|/home/\w+)/?(\*)?(\s|$)"), "Löschen von System- oder Benutzerordner"),
    (re.compile(r"\b(mkfs(\.\w+)?|wipefs|shred)\b|\bdd\b.*\bof=/dev/"), "Formatieren oder Überschreiben von Laufwerken"),
    (re.compile(r":\(\)\s*\{\s*:\|:&\s*\};:"), "Fork-Bombe"),
    (re.compile(r"\bchmod\s+(-\w+\s+)*[0-7]*777\s+/(\s|$)|\bchown\s+-R\s+\S+\s+/(\s|$)"), "Rechte des ganzen Systems ändern"),
]

# Lokal und umkehrbar: läuft ohne Rückfrage (T1).
T1_COMMANDS = {"mkdir", "notify-send"}

_CONTROL = re.compile(r"[;&`\n\r]|\$\(|\$\{|>|<\(")


def classify(command: str) -> tuple[Tier, str]:
  """Stufe für die Shell dieses Systems."""
  if IS_WINDOWS:
    from .powershell_classifier import classify_powershell

    return classify_powershell(command)
  return classify_bash(command)


def classify_bash(command: str) -> tuple[Tier, str]:
  tier, reason = _classify_bash(command)
  return _protect_enforcement(command, tier, reason)


def _protect_enforcement(command: str, tier: Tier, reason: str) -> tuple[Tier, str]:
  """Nicht nur lesende Befehle, die Hooks, Regeln oder MCP-Server von Aura berühren, sind T3 (AURA-60)."""
  if tier != Tier.T0 and tier != Tier.T3 and ENFORCEMENT_IN_COMMAND.search(command or ""):
    return Tier.T3, "Hooks, Regeln und MCP-Server von Aura ändert nur der Nutzer selbst (Zentrale)"
  return tier, reason


def _classify_bash(command: str) -> tuple[Tier, str]:
  c = (command or "").strip()
  if not c:
    return Tier.T2, "leerer Befehl"
  for pattern, what in FORBIDDEN:
    if pattern.search(c):
      return Tier.T3, what
  if re.search(r"(^|\s|;|&&|\|)(sudo|pkexec|su)\s", c + " "):
    return Tier.T2, "Administratorrechte"
  if _CONTROL.search(c):
    return Tier.T2, "verkettete oder umgeleitete Befehle"
  env = _env_reason(c)
  if env:
    return Tier.T2, env
  try:
    first_words = shlex.split(c)
  except ValueError:
    first_words = []
  if "|" not in c and first_words and first_words[0] in T1_COMMANDS and not any(w in ("-m", "--mode") for w in first_words):
    return Tier.T1, "legt nur etwas Neues an"
  if len(first_words) == 2 and first_words[0] == "xdg-open" and re.match(r"https?://", first_words[1]):
    return Tier.T1, "öffnet eine Webseite"
  for segment in c.split("|"):
    try:
      words = shlex.split(segment)
    except ValueError:
      return Tier.T2, "nicht eindeutig zerlegbar"
    if not words:
      return Tier.T2, "leeres Segment"
    name = words[0].rsplit("/", 1)[-1].lower()
    if name not in READONLY:
      return Tier.T2, f"„{name}“ kann etwas verändern"
    subs = READONLY_SUBCOMMANDS.get(name)
    if subs and "*" not in subs:
      first = next((w for w in words[1:] if w not in ("--user",)), "")
      if first not in subs:
        return Tier.T2, f"„{name} {first}“ kann etwas verändern"
    risky = RISKY_ARGS.get(name)
    if risky and risky.search(" ".join(words[1:])):
      return Tier.T2, f"„{name}“ mit verändernden Schaltern"
    reason = _segment_reason(name, words)
    if reason:
      return Tier.T2, reason
  return Tier.T0, "nur lesend"
