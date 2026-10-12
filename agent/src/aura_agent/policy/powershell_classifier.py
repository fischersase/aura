"""Stufe eines PowerShell-Befehls (Windows), Gegenstück zu shell_classifier.classify_bash.

Grundsatz wie unter Linux: nur Befehle aus einer festen Liste lesender Cmdlets und Programme laufen ohne
Rückfrage (T0); alles Unbekannte, Verkettete oder Zusammengesetzte fragt (T2); Zugangsdaten, Sicherheits-
einstellungen und Zerstörerisches sind gesperrt (T3).

PowerShell ist mächtiger als bash: Methodenaufrufe (.Delete()), .NET-Aufrufe ([IO.File]::…), Ausdrücke in
Klammern und Skriptblöcke können überall etwas ausführen. Deshalb gilt:
- Texte in Anführungszeichen werden vor der Prüfung entfernt; "$(…)" in Texten fragt.
- Außerhalb von Texten fragen ; & ` # < > = ( ) [ ] :: $( @( @{ und Methodenaufrufe.
- Skriptblöcke { … } (z. B. bei Where-Object) dürfen nur Vergleiche über $_ enthalten.
"""

from __future__ import annotations

import re

from ..harness.tiers import Tier

READONLY = {
    # Cmdlets
    "get-childitem", "get-content", "get-item", "get-itemproperty", "get-itempropertyvalue", "get-location",
    "get-process", "get-service", "get-date", "get-command", "get-help", "get-host", "get-psdrive", "get-volume",
    "get-disk", "get-partition", "get-physicaldisk", "get-netadapter", "get-netipaddress", "get-netipconfiguration",
    "get-netroute", "get-nettcpconnection", "get-netconnectionprofile", "get-dnsclientserveraddress",
    "get-netfirewallprofile", "get-computerinfo", "get-ciminstance", "get-wmiobject", "get-hotfix", "get-uptime",
    "get-filehash", "get-acl", "get-appxpackage", "get-package", "get-startapps", "get-printer", "get-printjob",
    "get-timezone", "get-culture", "get-uiculture", "get-history", "get-member", "get-eventlog", "get-winevent",
    "get-scheduledtask", "get-scheduledtaskinfo", "get-localuser", "get-localgroup", "get-localgroupmember",
    "get-pnpdevice", "get-module", "get-executionpolicy", "get-mpcomputerstatus", "get-clipboard", "get-counter",
    "get-random", "get-unique", "get-verb", "get-alias", "get-psprovider", "get-smbshare", "get-winsystemlocale",
    "get-computerrestorepoint", "get-bitlockervolume", "get-windowsoptionalfeature",
    "test-path", "test-connection", "test-netconnection", "resolve-path", "split-path", "join-path", "convert-path",
    "select-object", "where-object", "sort-object", "measure-object", "group-object", "format-table", "format-list",
    "format-wide", "format-custom", "out-string", "out-host", "out-default", "convertto-json", "convertto-csv",
    "convertto-xml", "convertfrom-json", "convertfrom-csv", "select-string", "select-xml", "write-output",
    "write-host", "compare-object", "foreach-object", "start-sleep",
    # Aliase (Windows PowerShell 5.1 und PowerShell 7)
    "ls", "dir", "gci", "cat", "type", "gc", "gi", "gp", "gl", "pwd", "ps", "gps", "gsv", "gcm", "help", "echo",
    "write", "select", "where", "?", "sort", "measure", "group", "fl", "ft", "fw", "%", "foreach", "sls", "gdr",
    "gwmi", "gcim", "gu", "h", "history", "sleep", "diff", "rvpa",
    # Programme
    "whoami", "hostname", "ipconfig", "systeminfo", "tasklist", "where.exe", "nvidia-smi", "findstr", "tree",
    "driverquery", "getmac", "nslookup", "ping", "tracert", "pathping", "netstat", "route", "arp", "query", "quser",
    "qwinsta", "reg", "sc", "sc.exe", "schtasks", "powercfg", "ollama", "git", "python", "py", "node", "pwsh",
    "winget", "choco", "wsl", "certutil", "ver",
}

# Programme, die nur mit diesen ersten Argumenten lesen ("" = ohne Argumente).
SUBCOMMANDS = {
    "ipconfig": {"", "/all", "/displaydns", "-all"},
    "route": {"print"},
    "arp": {"-a", "/a", "-g"},
    "reg": {"query"},
    "sc": {"query", "queryex", "qc", "qdescription", "getdisplayname", "getkeyname", "enumdepend"},
    "sc.exe": {"query", "queryex", "qc", "qdescription", "getdisplayname", "getkeyname", "enumdepend"},
    "schtasks": {"/query"},
    "powercfg": {"/list", "/l", "/query", "/q", "/getactivescheme", "/a", "/availablesleepstates"},
    "query": {"user", "session", "process"},
    "ollama": {"list", "ps", "show", "--version", "-v"},
    "git": {"status", "log", "diff", "show", "branch", "remote", "rev-parse", "describe", "tag", "ls-files", "blame"},
    "python": {"--version", "-v"},
    "py": {"--version", "-v", "--list", "-0"},
    "node": {"--version", "-v"},
    "pwsh": {"--version", "-v", "-version"},
    "winget": {"list", "search", "show", "--version", "-v"},
    "choco": {"list", "search", "info", "--version", "-v"},
    "wsl": {"-l", "--list", "--status", "-v", "--version"},
    "certutil": {"-hashfile"},
}

# Schalter, mit denen sonst lesende Cmdlets andere Rechner erreichen.
REMOTE = re.compile(r"(^|\s)-(computername|cn|session|cimsession)\b", re.IGNORECASE)

_I = re.IGNORECASE
FORBIDDEN = [
    (re.compile(r"\bget-credential\b|\bcmdkey\b|\bvaultcmd\b|convertfrom-securestring|\bmimikatz\b|sekurlsa|\blsass\b", _I),
     "Zugangsdaten"),
    (re.compile(r"(^|[\s\\/~'\"])\.(ssh|gnupg|password-store)([\\/\s'\"]|$)", _I), "SSH-/GPG-Schlüssel oder Passwortspeicher"),
    (re.compile(r"microsoft[\\/](credentials|protect|vault)\b", _I), "Windows-Anmeldedaten"),
    (re.compile(r"login data|\bcookies\b|local state|logins\.json|key4\.db|cookies\.sqlite", _I), "Browser-Passwörter oder Cookies"),
    (re.compile(r"\breg(\.exe)?\s+(save|export)\s+hklm|system32[\\/]config[\\/](sam|security|system)\b", _I), "Systempasswörter"),
    (re.compile(r"aura[\\/]secrets|\.aura[\\/]secrets", _I), "Aura-Schlüssel"),
    (re.compile(r"(set|add|remove)-mppreference|\bnetsh(\.exe)?\s+(advfirewall|firewall)|set-netfirewallprofile|disable-netfirewall|"
                r"new-netfirewallrule|set-executionpolicy|\bbcdedit\b|enablelua|[\\/]policies[\\/]|disable-computerrestore|"
                r"\bvssadmin\b.*\bdelete\b|\bwbadmin\b.*\bdelete\b|clear-eventlog|\bwevtutil(\.exe)?\s+(cl|clear-log)\b|"
                r"set-mpcomputerstatus|uninstall-windowsfeature.*defender", _I), "Sicherheitseinstellungen"),
    (re.compile(r"\bformat(\.com)?\s+[a-z]:|\bdiskpart\b|\b(clear-disk|initialize-disk|format-volume|remove-partition)\b|"
                r"\bcipher(\.exe)?\s+/w", _I), "Formatieren oder Überschreiben von Laufwerken"),
    # Nicht rückgängig zu machen: Laufwerk, Windows, Programme oder ganzer Benutzerordner.
    (re.compile(r"\b(remove-item|rm|del|erase|rd|rmdir|ri)\b[^|;]*\s(['\"]?)([a-z]:\\?|~|\$home|\$env:userprofile|"
                r"\$env:systemroot|\$env:windir|[a-z]:\\windows|[a-z]:\\users(\\[^\\\s'\"]+)?|[a-z]:\\program files( \(x86\))?)"
                r"\2\\?(\*)?(\s|$)", _I), "Löschen von System- oder Benutzerordner"),
    (re.compile(r"\s-(e|ec|en|enc|enco|encod|encode|encoded|encodedcommand)\s+[a-z0-9+/=]{16,}", _I), "verschleierter Befehl"),
]

ELEVATION = re.compile(r"-verb\s+['\"]?runas|\brunas(\.exe)?\b|^\s*sudo\b|\bgsudo\b", _I)
OPEN_URL = re.compile(r"^\s*(start-process|start|saps)\s+(?:-filepath\s+)?(['\"]?)(https?://[^\s'\"]+)\2\s*$", _I)
TYPOGRAPHIC_QUOTES = re.compile(r"[‘’‚‛“”„]")
# Außerhalb von Texten und Skriptblöcken: alles, womit PowerShell weitere Befehle oder .NET ausführen kann.
CONTROL = re.compile(r"[;&`\n\r#<>=()\[\]]|\$\(|@\(|@\{|\$\{|::|\.\w+\s*\(")
HARMLESS_REDIRECTS = re.compile(r"\s(2|\*)>\s*\$null\b|\s2>&1\b", _I)

# Erlaubte Bausteine in Skriptblöcken: $_-Eigenschaften, Vergleiche, Zahlen, Texte, Klammern.
_BLOCK_TOKENS = [re.compile(p, _I) for p in (
    r"\s+", r"\$(_|psitem|true|false|null)(?![\w:])", r"\.[a-z_]\w*(?!\s*\()",
    r"-(c|i)?(eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin|is|isnot)\b",
    r"-(and|or|not|xor)\b", r"\d+(\.\d+)?(kb|mb|gb|tb|pb)?\b", r"''", r"[()!,+*/%]", r"-(?=[\s\d])",
)]


def _strip_strings(c: str) -> tuple[str, str]:
  """Ersetzt Texte in Anführungszeichen durch ''. Zweiter Wert: Grund, falls die Prüfung abbrechen muss."""
  out: list[str] = []
  i, n = 0, len(c)
  while i < n:
    ch = c[i]
    if ch in "'\"":
      j = i + 1
      while j < n:
        if ch == '"' and c[j] == "`":
          j += 2
          continue
        if c[j] == ch and j + 1 < n and c[j + 1] == ch:
          j += 2
          continue
        if c[j] == ch:
          break
        j += 1
      if j >= n:
        return "", "Anführungszeichen nicht geschlossen"
      inner = c[i + 1:j]
      if ch == '"' and ("$(" in inner or "${" in inner):
        return "", "Befehl in einem Text"
      out.append("''")
      i = j + 1
    else:
      out.append(ch)
      i += 1
  return "".join(out), ""


def _block_safe(body: str) -> bool:
  pos = 0
  while pos < len(body):
    for tok in _BLOCK_TOKENS:
      m = tok.match(body, pos)
      if m and m.end() > pos:
        pos = m.end()
        break
    else:
      return False
  return True


def _strip_blocks(s: str) -> tuple[str, str]:
  """Prüft Skriptblöcke { … } und ersetzt sie durch {}. Verschachtelte Blöcke fragen."""
  out: list[str] = []
  i = 0
  while i < len(s):
    if s[i] == "}":
      return "", "Skriptblock nicht eindeutig"
    if s[i] != "{":
      out.append(s[i])
      i += 1
      continue
    j = s.find("}", i + 1)
    if j < 0 or "{" in s[i + 1:j]:
      return "", "Skriptblock nicht eindeutig"
    if not _block_safe(s[i + 1:j]):
      return "", "Skriptblock kann etwas ausführen"
    out.append("{}")
    i = j + 1
  return "".join(out), ""


def _t1(words: list[str]) -> bool:
  """Ordner anlegen ist lokal und umkehrbar."""
  name = words[0]
  rest = [w.lower() for w in words[1:]]
  if name in ("mkdir", "md"):
    return all(w in ("-force",) or not w.startswith("-") for w in rest)
  if name in ("new-item", "ni"):
    for flag in ("-itemtype", "-type"):
      if flag in rest:
        k = rest.index(flag)
        return k + 1 < len(rest) and rest[k + 1].strip("'\"") in ("directory", "dir", "d") and "-value" not in rest
  return False


def classify_powershell(command: str) -> tuple[Tier, str]:
  c = (command or "").strip()
  if not c:
    return Tier.T2, "leerer Befehl"
  for pattern, what in FORBIDDEN:
    if pattern.search(c):
      return Tier.T3, what
  if ELEVATION.search(c):
    return Tier.T2, "Administratorrechte"
  if OPEN_URL.match(c):
    return Tier.T1, "öffnet eine Webseite"
  if TYPOGRAPHIC_QUOTES.search(c) or "@'" in c or '@"' in c:
    return Tier.T2, "nicht eindeutig zerlegbar"
  s, why = _strip_strings(c)
  if why:
    return Tier.T2, why
  s, why = _strip_blocks(s)
  if why:
    return Tier.T2, why
  s = HARMLESS_REDIRECTS.sub(" ", s)
  if CONTROL.search(s):
    return Tier.T2, "verkettete, umgeleitete oder zusammengesetzte Befehle"
  segments = s.split("|")
  if len(segments) == 1:
    words = s.split()
    if words and _t1([words[0].lower(), *words[1:]]):
      return Tier.T1, "legt nur etwas Neues an"
  for segment in segments:
    words = segment.split()
    if not words:
      return Tier.T2, "leeres Segment"
    if "\\" in words[0] or "/" in words[0]:
      return Tier.T2, "startet ein Programm über einen Pfad"
    name = words[0].lower()
    if name not in READONLY:
      name = name.removesuffix(".exe")
    if name not in READONLY:
      return Tier.T2, f"„{words[0]}“ kann etwas verändern"
    subs = SUBCOMMANDS.get(name)
    if subs is not None:
      first = words[1].lower() if len(words) > 1 else ""
      if first not in subs:
        return Tier.T2, f"„{name} {first}“ kann etwas verändern"
    if REMOTE.search(segment):
      return Tier.T2, "greift auf einen anderen Rechner zu"
  return Tier.T0, "nur lesend"
