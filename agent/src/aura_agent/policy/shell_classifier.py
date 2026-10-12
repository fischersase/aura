"""Stufe eines Shell-Befehls bestimmen: bash unter Linux, PowerShell unter Windows (powershell_classifier.py).

Liste lesender Befehle und riskanter Schalter (übernommen aus src/agent/tools.js),
Sperrliste für Zugangsdaten. Alles Unbekannte ist T2 und fragt.
"""

from __future__ import annotations

import re
import shlex

from ..harness.tiers import Tier
from ..platform.base import IS_WINDOWS

READONLY = {
    "ls", "pwd", "whoami", "hostname", "date", "uname", "uptime", "df", "du", "free", "cat", "head", "tail",
    "wc", "which", "file", "stat", "find", "fd", "fdfind", "locate", "plocate", "grep", "rg", "sort", "uniq",
    "echo", "ps", "pgrep", "lsblk", "lscpu", "lsusb", "lspci", "nvidia-smi", "ip", "tree", "env", "printenv",
    "id", "groups", "lsb_release", "hostnamectl", "sensors", "xdg-user-dir", "pactl", "wpctl", "playerctl",
    "wmctrl", "xprop", "xdotool", "gsettings", "busctl", "systemctl", "journalctl", "dpkg", "apt", "snap",
    "flatpak", "ollama", "git", "python3", "node", "cut", "tr", "awk", "basename", "dirname", "realpath",
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
    "python3": {"--version", "-V"},
    "node": {"--version", "-v"},
    "ip": {"a", "addr", "address", "r", "route", "link", "-br", "-c", "neigh"},
}

RISKY_ARGS = {
    "find": re.compile(r"(^|\s)-(delete|exec|execdir|ok|okdir|fprint\w*|fls)(\s|$)", re.IGNORECASE),
    "sort": re.compile(r"(^|\s)(-o|--output)"),
    "tree": re.compile(r"(^|\s)-o(\s|$)"),
    "fd": re.compile(r"(^|\s)(-x|-X|--exec\S*)(\s|$)"),
    "fdfind": re.compile(r"(^|\s)(-x|-X|--exec\S*)(\s|$)"),
    "date": re.compile(r"(^|\s)(-s|--set)"),
    "journalctl": re.compile(r"(^|\s)--(vacuum|rotate|flush|setup-keys)"),
    "less": re.compile(r"."),  # interaktiv, nie sinnvoll
    "more": re.compile(r"."),
}

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
  return Tier.T0, "nur lesend"
