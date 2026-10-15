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
from .shell_classifier import RISKY_ARGS as BASH_RISKY_ARGS
from .shell_classifier import git_reason, protect_enforcement

READONLY = {
    # Cmdlets
    "get-childitem",
    "get-content",
    "get-item",
    "get-itemproperty",
    "get-itempropertyvalue",
    "get-location",
    "get-process",
    "get-service",
    "get-date",
    "get-command",
    "get-help",
    "get-host",
    "get-psdrive",
    "get-volume",
    "get-disk",
    "get-partition",
    "get-physicaldisk",
    "get-netadapter",
    "get-netipaddress",
    "get-netipconfiguration",
    "get-netroute",
    "get-nettcpconnection",
    "get-netconnectionprofile",
    "get-dnsclientserveraddress",
    "get-netfirewallprofile",
    "get-computerinfo",
    "get-ciminstance",
    "get-wmiobject",
    "get-hotfix",
    "get-uptime",
    "get-filehash",
    "get-acl",
    "get-appxpackage",
    "get-package",
    "get-startapps",
    "get-printer",
    "get-printjob",
    "get-timezone",
    "get-culture",
    "get-uiculture",
    "get-history",
    "get-member",
    "get-eventlog",
    "get-winevent",
    "get-scheduledtask",
    "get-scheduledtaskinfo",
    "get-localuser",
    "get-localgroup",
    "get-localgroupmember",
    "get-pnpdevice",
    "get-module",
    "get-executionpolicy",
    "get-mpcomputerstatus",
    "get-clipboard",
    "get-counter",
    "get-random",
    "get-unique",
    "get-verb",
    "get-alias",
    "get-psprovider",
    "get-smbshare",
    "get-winsystemlocale",
    "get-computerrestorepoint",
    "get-bitlockervolume",
    "get-windowsoptionalfeature",
    "test-path",
    "test-connection",
    "test-netconnection",
    "resolve-path",
    "split-path",
    "join-path",
    "convert-path",
    "select-object",
    "where-object",
    "sort-object",
    "measure-object",
    "group-object",
    "format-table",
    "format-list",
    "format-wide",
    "format-custom",
    "out-string",
    "out-host",
    "out-default",
    "convertto-json",
    "convertto-csv",
    "convertto-xml",
    "convertfrom-json",
    "convertfrom-csv",
    "select-string",
    "select-xml",
    "write-output",
    "write-host",
    "compare-object",
    "foreach-object",
    "start-sleep",
    # Aliase (Windows PowerShell 5.1 und PowerShell 7)
    "ls",
    "dir",
    "gci",
    "cat",
    "type",
    "gc",
    "gi",
    "gp",
    "gl",
    "pwd",
    "ps",
    "gps",
    "gsv",
    "gcm",
    "help",
    "echo",
    "write",
    "select",
    "where",
    "?",
    "sort",
    "measure",
    "group",
    "fl",
    "ft",
    "fw",
    "%",
    "foreach",
    "sls",
    "gdr",
    "gwmi",
    "gcim",
    "gu",
    "h",
    "history",
    "sleep",
    "diff",
    "rvpa",
    # Programme
    "whoami",
    "hostname",
    "ipconfig",
    "systeminfo",
    "tasklist",
    "where.exe",
    "nvidia-smi",
    "findstr",
    "tree",
    "driverquery",
    "getmac",
    "nslookup",
    "ping",
    "tracert",
    "pathping",
    "netstat",
    "route",
    "arp",
    "query",
    "quser",
    "qwinsta",
    "reg",
    "sc",
    "sc.exe",
    "schtasks",
    "powercfg",
    "ollama",
    "git",
    "python",
    "py",
    "node",
    "pwsh",
    "winget",
    "choco",
    "wsl",
    "certutil",
    "ver",
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
    "git": {
        "status",
        "log",
        "diff",
        "show",
        "branch",
        "remote",
        "rev-parse",
        "describe",
        "tag",
        "ls-files",
        "blame",
    },
    "winget": {"list", "search", "show", "--version", "-v"},
    "choco": {"list", "search", "info", "--version", "-v"},
    "certutil": {"-hashfile"},
}

# Programme, bei denen *jedes* Argument aus dieser Liste stammen muss; weitere Argumente könnten Code ausführen
# ("wsl -l -e …", "node -v -e …", "python --version -c …"). Vergleich in Kleinbuchstaben.
ALL_ARGS_IN = {
    "python": {"--version", "-v"},
    "py": {"--version", "-v", "--list", "-0", "-0p", "--list-paths"},
    "node": {"--version", "-v"},
    "pwsh": {"--version", "-v", "-version"},
    "wsl": {
        "-l",
        "--list",
        "-v",
        "--verbose",
        "--status",
        "--version",
        "-q",
        "--quiet",
        "--running",
        "--all",
        "-o",
        "--online",
    },
}
# Weitere Schalter, die sonst lesende Programme verändernd machen.
NATIVE_RISKY = {
    "arp": re.compile(r"(^|\s)[-/](d|s)(\s|$)", re.IGNORECASE),
    "git": BASH_RISKY_ARGS["git"],
    "nvidia-smi": BASH_RISKY_ARGS["nvidia-smi"],
    "tree": BASH_RISKY_ARGS["tree"],
}

# Umgebungsvariablen ohne Geheimnisse; $env:GEMINI_API_KEY und Co. fragen (AURA-13).
SAFE_ENV_VARS = {
    "userprofile",
    "home",
    "homedrive",
    "homepath",
    "appdata",
    "localappdata",
    "programdata",
    "temp",
    "tmp",
    "username",
    "userdomain",
    "computername",
    "programfiles",
    "programw6432",
    "systemroot",
    "windir",
    "systemdrive",
    "public",
    "onedrive",
    "os",
    "processor_architecture",
    "number_of_processors",
    "path",
    "pathext",
}
ENV_DRIVE = re.compile(r"(^|[\s('\"\[,])env:", re.IGNORECASE)
ENV_REGISTRY = re.compile(
    r"win32_environment|hkcu:\\environment|hkey_current_user\\environment|"
    r"session manager\\environment",
    re.IGNORECASE,
)


def _env_reason(c: str) -> str:
    for m in re.finditer(r"\$env:([A-Za-z_][A-Za-z0-9_]*)", c, re.IGNORECASE):
        if m.group(1).lower() not in SAFE_ENV_VARS:
            return f"liest die Umgebungsvariable $env:{m.group(1)} (kann Schlüssel enthalten)"
    rest = re.sub(r"\$env:[A-Za-z_][A-Za-z0-9_]*", " ", c, flags=re.IGNORECASE)
    if ENV_DRIVE.search(rest) or ENV_REGISTRY.search(rest):
        return "liest Umgebungsvariablen (können Schlüssel enthalten)"
    return ""


# Schalter, mit denen sonst lesende Cmdlets andere Rechner erreichen.
REMOTE = re.compile(r"(^|\s)-(computername|cn|session|cimsession)\b", re.IGNORECASE)

_I = re.IGNORECASE
FORBIDDEN = [
    (
        re.compile(
            r"\bget-credential\b|\bcmdkey\b|\bvaultcmd\b|convertfrom-securestring|\bmimikatz\b|sekurlsa|\blsass\b",
            _I,
        ),
        "Zugangsdaten",
    ),
    (
        re.compile(r"(^|[\s\\/~'\"])\.(ssh|gnupg|password-store)([\\/\s'\"]|$)", _I),
        "SSH-/GPG-Schlüssel oder Passwortspeicher",
    ),
    (re.compile(r"microsoft[\\/](credentials|protect|vault)\b", _I), "Windows-Anmeldedaten"),
    (
        re.compile(r"login data|\bcookies\b|local state|logins\.json|key4\.db|cookies\.sqlite", _I),
        "Browser-Passwörter oder Cookies",
    ),
    (
        re.compile(
            r"\breg(\.exe)?\s+(save|export)\s+hklm|system32[\\/]config[\\/](sam|security|system)\b", _I
        ),
        "Systempasswörter",
    ),
    (re.compile(r"aura[\\/]secrets|\.aura[\\/]secrets", _I), "Aura-Schlüssel"),
    (re.compile(r"aura[\\/]agent[\\/](audit|sessions\.db)", _I), "Protokoll und Gedächtnis von Aura"),
    # AURA-16: Cloud-CLIs, Entwicklerwerkzeuge, .env-Dateien
    (
        re.compile(
            r"\.(netrc|pgpass|git-credentials|npmrc|pypirc|vault-token)\b|\.aws([\\/\s'\"]|$)|"
            r"\.docker[\\/]config\.json|\.kube([\\/\s'\"]|$)|gcloud[\\/]|(^|[\s\\/~])\.azure([\\/]|\s|$)|"
            r"github cli['\"]?([\\/\s]|$)|\.config[\\/]gh([\\/\s'\"]|$)|\.cargo[\\/]credentials|npm[\\/]etc[\\/]npmrc",
            _I,
        ),
        "Zugangsdaten",
    ),
    (
        re.compile(r"(^|[\s\\/~'\"])\.env(rc|\.[\w.-]+)?(\s|$|['\"])", _I),
        "Umgebungsdatei mit Zugangsdaten (.env)",
    ),
    (
        re.compile(
            r"(set|add|remove)-mppreference|\bnetsh(\.exe)?\s+(advfirewall|firewall)|set-netfirewallprofile|disable-netfirewall|"
            r"new-netfirewallrule|set-executionpolicy|\bbcdedit\b|enablelua|[\\/]policies[\\/]|disable-computerrestore|"
            r"\bvssadmin\b.*\bdelete\b|\bwbadmin\b.*\bdelete\b|clear-eventlog|\bwevtutil(\.exe)?\s+(cl|clear-log)\b|"
            r"set-mpcomputerstatus|uninstall-windowsfeature.*defender",
            _I,
        ),
        "Sicherheitseinstellungen",
    ),
    (
        re.compile(
            r"\bformat(\.com)?\s+[a-z]:|\bdiskpart\b|\b(clear-disk|initialize-disk|format-volume|remove-partition)\b|"
            r"\bcipher(\.exe)?\s+/w",
            _I,
        ),
        "Formatieren oder Überschreiben von Laufwerken",
    ),
    # Nicht rückgängig zu machen: Laufwerk, Windows, Programme oder ganzer Benutzerordner.
    (
        re.compile(
            r"\b(remove-item|rm|del|erase|rd|rmdir|ri)\b[^|;]*\s(['\"]?)([a-z]:\\?|~|\$home|\$env:userprofile|"
            r"\$env:systemroot|\$env:windir|[a-z]:\\windows|[a-z]:\\users(\\[^\\\s'\"]+)?|[a-z]:\\program files( \(x86\))?)"
            r"\2\\?(\*)?(\s|$)",
            _I,
        ),
        "Löschen von System- oder Benutzerordner",
    ),
    (
        re.compile(r"\s-(e|ec|en|enc|enco|encod|encode|encoded|encodedcommand)\s+[a-z0-9+/=]{16,}", _I),
        "verschleierter Befehl",
    ),
]

ELEVATION = re.compile(r"-verb\s+['\"]?runas|\brunas(\.exe)?\b|^\s*sudo\b|\bgsudo\b", _I)
OPEN_URL = re.compile(
    r"^\s*(start-process|start|saps)\s+(?:-filepath\s+)?(['\"]?)(https?://[^\s'\"]+)\2\s*$", _I
)
TYPOGRAPHIC_QUOTES = re.compile(r"[‘’‚‛“”„]")
# Außerhalb von Texten und Skriptblöcken: alles, womit PowerShell weitere Befehle oder .NET ausführen kann.
CONTROL = re.compile(r"[;&`\n\r#<>=()\[\]]|\$\(|@\(|@\{|\$\{|::|\.\w+\s*\(")
HARMLESS_REDIRECTS = re.compile(r"\s(2|\*)>\s*\$null\b|\s2>&1\b", _I)
_PLACEHOLDER = re.compile(r"'\x00(\d+)\x00'")

# Erlaubte Bausteine in Skriptblöcken: $_-Eigenschaften, Vergleiche, Zahlen, Texte, Klammern.
_BLOCK_TOKENS = [
    re.compile(p, _I)
    for p in (
        r"\s+",
        r"\$(_|psitem|true|false|null)(?![\w:])",
        r"\.[a-z_]\w*(?!\s*\()",
        r"-(c|i)?(eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin|is|isnot)\b",
        r"-(and|or|not|xor)\b",
        r"\d+(\.\d+)?(kb|mb|gb|tb|pb)?\b",
        r"'(?:\x00\d+\x00)?'",
        r"[()!,+*/%]",
        r"-(?=[\s\d])",
    )
]


def _strip_strings(c: str, literals: list[str] | None = None) -> tuple[str, str]:
    """Ersetzt Texte in Anführungszeichen durch Platzhalter. Zweiter Wert: Grund, falls die Prüfung abbrechen muss."""
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
            inner = c[i + 1 : j]
            if ch == '"' and ("$(" in inner or "${" in inner):
                return "", "Befehl in einem Text"
            if literals is not None:
                idx = len(literals)
                literals.append(inner)
                out.append(f"'\x00{idx}\x00'")
            else:
                out.append("''")
            i = j + 1
        else:
            out.append(ch)
            i += 1
    return "".join(out), ""


def _restore_word(word: str, literals: list[str]) -> str:
    return _PLACEHOLDER.sub(lambda m: literals[int(m.group(1))], word)


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
        if j < 0 or "{" in s[i + 1 : j]:
            return "", "Skriptblock nicht eindeutig"
        if not _block_safe(s[i + 1 : j]):
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
                return (
                    k + 1 < len(rest)
                    and rest[k + 1].strip("'\"") in ("directory", "dir", "d")
                    and "-value" not in rest
                )
    return False


def classify_powershell(command: str) -> tuple[Tier, str]:
    tier, reason = _classify_powershell(command)
    return protect_enforcement(command, tier, reason)


def _classify_powershell(command: str) -> tuple[Tier, str]:
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
    env = _env_reason(c)
    if env:
        return Tier.T2, env
    literals: list[str] = []
    s, why = _strip_strings(c, literals)
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
        raw_words = [_restore_word(w, literals) for w in s.split()]
        if raw_words and not s.split()[0].startswith("'") and _t1([raw_words[0].lower(), *raw_words[1:]]):
            return Tier.T1, "legt nur etwas Neues an"
    for segment in segments:
        raw_tokens = segment.split()
        if not raw_tokens:
            return Tier.T2, "leeres Segment"
        if raw_tokens[0].startswith("'"):
            return Tier.T2, "startet ein Programm über einen Text"
        words = [_restore_word(w, literals) for w in raw_tokens]
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
        allowed = ALL_ARGS_IN.get(name)
        if allowed is not None and (len(words) < 2 or any(w.lower() not in allowed for w in words[1:])):
            return Tier.T2, f"„{name}“ mit weiteren Argumenten kann Code ausführen"
        risky = NATIVE_RISKY.get(name)
        if risky and risky.search(" ".join(words[1:])):
            return Tier.T2, f"„{name}“ mit verändernden Schaltern"
        if name == "git":
            reason = git_reason(words)
            if reason:
                return Tier.T2, reason
        if name == "certutil" and len(words) > 4:
            return Tier.T2, "„certutil“ mit weiteren Argumenten"
        if REMOTE.search(" ".join(words)):
            return Tier.T2, "greift auf einen anderen Rechner zu"
    return Tier.T0, "nur lesend"
