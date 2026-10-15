"""Software-Suche, Paket-Installation und Netzwerk-/VPN-Prüfung (Linux, Windows, macOS).

Ermöglicht dem Agenten den kompletten Software-Lebenszyklus:
1. search_software (T0): Passende Programme in offiziellen Paketquellen (Flatpak, APT, Snap, Winget, Homebrew) finden.
2. install_software (T2): Geprüftes Paket ohne Shell-Injection installieren und die Installation verifizieren.
3. network_status (T0): Aktive Netzwerk-/VPN-Schnittstellen sowie öffentliche IP-Adresse und Standort (Land/Stadt/ISP) prüfen.
"""

from __future__ import annotations

import asyncio
import re
import shutil
from pathlib import Path
from typing import Any

import httpx

from ..harness.tiers import Tier, aura_tool
from ..platform.base import IS_MACOS, IS_WINDOWS
from ..platform.proc import kill_tree, spawn_kwargs
from ..runtime.context import current
from .apps import list_apps
from .paths import expand

SAFE_PKG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+@/-]{0,127}$")
VPN_IFACE_RE = re.compile(
    r"^(tun[\w.-]*|tap[\w.-]*|wg[\w.-]*|proton[\w.-]*|nordlynx[\w.-]*|mullvad[\w.-]*|windscribe[\w.-]*|tailscale[\w.-]*|utun\d*|ppp\d*)$",
    re.IGNORECASE,
)


async def _exec(cmd: list[str], timeout: float = 20.0) -> tuple[int, str, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **spawn_kwargs(),
        )
    except FileNotFoundError:
        return 127, "", f"{cmd[0]} nicht gefunden"
    except OSError as e:
        return 1, "", str(e)
    try:
        out_b, err_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        if proc.pid is not None:
            kill_tree(proc.pid)
        return 124, "", f"Zeitüberschreitung nach {timeout:.0f}s"
    return (
        proc.returncode or 0,
        out_b.decode("utf-8", "replace").strip(),
        err_b.decode("utf-8", "replace").strip(),
    )


def _available_managers() -> list[str]:
    if IS_WINDOWS:
        return [m for m in ("winget", "choco", "scoop") if shutil.which(m)]
    if IS_MACOS:
        return [m for m in ("brew",) if shutil.which(m)]
    return [m for m in ("flatpak", "apt-cache", "snap", "dnf", "pacman") if shutil.which(m)]


@aura_tool(Tier.T0, label=lambda a: f"Software suchen: {a.get('query', '')}")
async def search_software(query: str) -> dict[str, Any]:
    """Sucht in den Paketquellen des Systems (Flatpak, APT, Snap, Winget, Homebrew) nach einem Programm.

    Args:
      query: Suchbegriff, z. B. "vpn", "gimp", "vlc", "protonvpn", "wireguard".
    """
    q = query.strip()
    if not q or len(q) > 80:
        return {"error": "Bitte gib einen kurzen Suchbegriff (1–80 Zeichen) an."}

    matches: list[dict[str, str]] = []
    managers = _available_managers()

    if IS_WINDOWS and "winget" in managers:
        rc, out, _ = await _exec(
            ["winget", "search", "--accept-source-agreements", "-n", "15", q], timeout=20.0
        )
        if rc == 0 and out:
            for line in out.splitlines():
                if line.startswith(("-", "Name ")) or len(line.strip()) < 5:
                    continue
                parts = re.split(r"\s{2,}", line.strip())
                if len(parts) >= 2:
                    matches.append(
                        {
                            "manager": "winget",
                            "name": parts[0],
                            "id": parts[1],
                            "version": parts[2] if len(parts) > 2 else "",
                        }
                    )
    elif IS_MACOS and "brew" in managers:
        rc, out, _ = await _exec(["brew", "search", "--desc", q], timeout=20.0)
        if rc == 0 and out:
            for line in out.splitlines()[:20]:
                if ":" in line and not line.startswith("==>"):
                    pkg_id, desc = line.split(":", 1)
                    matches.append(
                        {
                            "manager": "brew",
                            "id": pkg_id.strip(),
                            "name": pkg_id.strip(),
                            "summary": desc.strip(),
                        }
                    )
    else:
        if "flatpak" in managers:
            rc, out, _ = await _exec(
                ["flatpak", "search", "--columns=name,application,version,description", q], timeout=15.0
            )
            if rc == 0 and out and "No matches" not in out:
                for line in out.splitlines()[:12]:
                    parts = line.split("\t")
                    if len(parts) >= 2:
                        matches.append(
                            {
                                "manager": "flatpak",
                                "name": parts[0].strip(),
                                "id": parts[1].strip(),
                                "version": parts[2].strip() if len(parts) > 2 else "",
                                "summary": parts[3].strip() if len(parts) > 3 else "",
                            }
                        )
        if "apt-cache" in managers:
            rc, out, _ = await _exec(["apt-cache", "search", "--names-only", q], timeout=10.0)
            if rc == 0 and not out:
                rc, out, _ = await _exec(["apt-cache", "search", q], timeout=10.0)
            if rc == 0 and out:
                for line in out.splitlines()[:15]:
                    if " - " in line:
                        pkg_id, desc = line.split(" - ", 1)
                        matches.append(
                            {
                                "manager": "apt",
                                "id": pkg_id.strip(),
                                "name": pkg_id.strip(),
                                "summary": desc.strip(),
                            }
                        )
        if "snap" in managers and len(matches) < 10:
            rc, out, _ = await _exec(["snap", "find", q], timeout=12.0)
            if rc == 0 and out:
                for line in out.splitlines()[1:10]:
                    parts = re.split(r"\s{2,}", line.strip())
                    if len(parts) >= 4:
                        matches.append(
                            {
                                "manager": "snap",
                                "id": parts[0],
                                "name": parts[0],
                                "version": parts[1],
                                "summary": parts[3],
                            }
                        )

    return {
        "query": q,
        "available_managers": managers,
        "count": len(matches),
        "packages": matches[:25],
    }


@aura_tool(
    Tier.T2,
    label=lambda a: f"Software installieren: {a.get('package', '')} ({a.get('manager', 'auto')})",
    effect=lambda a: (
        f"Installiert das Software-Paket „{a.get('package', '')}“ über {a.get('manager', 'auto')}"
    ),
)
async def install_software(package: str, manager: str = "auto") -> dict[str, Any]:
    """Installiert ein Programm oder Paket über den Paketmanager des Systems und prüft anschließend, ob es bereitsteht.

    Args:
      package: Paket-ID (z. B. "org.gimp.GIMP", "openvpn", "wireguard", "Proton.ProtonVPN") oder Pfad zu einer lokalen .deb/.msi-Datei.
      manager: "auto", "flatpak", "apt", "snap", "winget", "brew" oder "local".
    """
    pkg = package.strip()
    mgr = manager.strip().lower() or "auto"
    task = current()
    home = task.home if task else str(Path.home())

    if pkg.startswith(("~", "/", "./")) or pkg.endswith((".deb", ".rpm", ".msi", ".pkg")):
        local_path = expand(pkg, home)
        if not local_path.exists():
            return {"error": f"Installationsdatei nicht gefunden: {pkg}"}
        mgr = "local"
    elif not SAFE_PKG_RE.match(pkg):
        return {"error": f"Ungültige Paket-ID: {pkg!r}. Erlaubt sind nur Paketnamen ohne Sonderzeichen."}

    if mgr == "auto":
        if IS_WINDOWS:
            mgr = "winget"
        elif IS_MACOS:
            mgr = "brew"
        elif "." in pkg and pkg.count(".") >= 2 and shutil.which("flatpak"):
            mgr = "flatpak"
        elif shutil.which("apt-get"):
            mgr = "apt"
        elif shutil.which("flatpak"):
            mgr = "flatpak"
        elif shutil.which("dnf"):
            mgr = "dnf"
        else:
            return {"error": "Kein unterstützter Paketmanager gefunden."}

    if mgr == "flatpak":
        # Prefer --user first so no root password prompt is needed if user flathub is configured, else system.
        rc, out, err = await _exec(
            ["flatpak", "install", "--user", "-y", "--noninteractive", "flathub", pkg], timeout=180.0
        )
        if rc != 0:
            rc, out, err = await _exec(
                ["flatpak", "install", "-y", "--noninteractive", "flathub", pkg], timeout=180.0
            )
    elif mgr == "apt":
        sudo_rc, _, _ = await _exec(["sudo", "-n", "true"], timeout=3.0)
        prefix = (
            ["sudo", "-n"] if sudo_rc == 0 else (["pkexec"] if shutil.which("pkexec") else ["sudo", "-n"])
        )
        rc, out, err = await _exec(
            [*prefix, "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", pkg],
            timeout=180.0,
        )
    elif mgr == "snap":
        prefix = ["pkexec"] if shutil.which("pkexec") else ["sudo", "-n"]
        rc, out, err = await _exec([*prefix, "snap", "install", pkg], timeout=180.0)
    elif mgr == "dnf":
        prefix = ["pkexec"] if shutil.which("pkexec") else ["sudo", "-n"]
        rc, out, err = await _exec([*prefix, "dnf", "install", "-y", pkg], timeout=180.0)
    elif mgr == "winget":
        rc, out, err = await _exec(
            [
                "winget",
                "install",
                "--id",
                pkg,
                "-e",
                "--silent",
                "--accept-package-agreements",
                "--accept-source-agreements",
            ],
            timeout=240.0,
        )
    elif mgr == "brew":
        rc, out, err = await _exec(["brew", "install", pkg], timeout=240.0)
    elif mgr == "local":
        local_str = str(expand(pkg, home))
        if IS_WINDOWS:
            rc, out, err = await _exec(["msiexec.exe", "/i", local_str, "/qn", "/norestart"], timeout=180.0)
        elif IS_MACOS:
            rc, out, err = await _exec(["open", local_str], timeout=30.0)
        else:
            prefix = ["pkexec"] if shutil.which("pkexec") else ["sudo", "-n"]
            rc, out, err = await _exec(
                [*prefix, "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", local_str],
                timeout=180.0,
            )
    else:
        return {"error": f"Unbekannter Paketmanager: {mgr}"}

    if rc != 0:
        return {
            "error": f"Installation von {pkg} ({mgr}) fehlgeschlagen (Exit-Code {rc}): {(err or out)[-500:]}",
            "exit_code": rc,
        }

    # Verify installation
    bin_path = shutil.which(pkg.split(".")[-1].lower()) or shutil.which(pkg)
    raw_apps = list_apps(pkg.split(".")[-1]).get("apps")
    apps_found: list[dict[str, Any]] = (
        [x for x in raw_apps if isinstance(x, dict)] if isinstance(raw_apps, list) else []
    )
    verified = f"Installiert via {mgr}: {pkg}"
    if bin_path:
        verified += f" (Befehl: {bin_path})"
    elif apps_found:
        verified += f" (App: {apps_found[0].get('name')})"

    return {
        "ok": True,
        "package": pkg,
        "manager": mgr,
        "binary": bin_path,
        "apps": apps_found[:3],
        "output": out[-1000:],
        "verified": verified,
    }


@aura_tool(Tier.T0, label=lambda _a: "Netzwerk- und VPN-Status prüfen")
async def network_status() -> dict[str, Any]:
    """Prüft aktive Netzwerkschnittstellen, aktive VPN-Tunnel sowie die öffentliche IP-Adresse samt Land, Stadt und Provider.

    Unverzichtbar, um nach dem Verbinden eines VPNs oder einer Netzwerkänderung zu verifizieren, ob die Verbindung wirklich steht und in welchem Land die öffentliche IP liegt.
    """
    vpn_interfaces: list[str] = []
    active_connections: list[str] = []

    if IS_WINDOWS:
        rc, out, _ = await _exec(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object -ExpandProperty Name",
            ],
            timeout=8.0,
        )
        if rc == 0 and out:
            for name in (line.strip() for line in out.splitlines() if line.strip()):
                active_connections.append(name)
                if (
                    VPN_IFACE_RE.search(name)
                    or "vpn" in name.lower()
                    or "wireguard" in name.lower()
                    or "tap" in name.lower()
                ):
                    vpn_interfaces.append(name)
    elif IS_MACOS:
        rc, out, _ = await _exec(["ifconfig", "-l"], timeout=5.0)
        if rc == 0 and out:
            for iface in out.split():
                if iface.startswith(("utun", "ppp", "ipsec", "tun", "tap", "wg")):
                    vpn_interfaces.append(iface)
        rc2, out2, _ = await _exec(["scutil", "--nc", "list"], timeout=5.0)
        if rc2 == 0 and out2:
            for line in out2.splitlines():
                if "Connected" in line:
                    active_connections.append(line.strip())
                    vpn_interfaces.append(line.strip())
    else:
        rc, out, _ = await _exec(["ip", "-br", "addr", "show", "up"], timeout=5.0)
        if rc == 0 and out:
            for line in out.splitlines():
                parts = line.split()
                if parts:
                    iface = parts[0].split("@")[0]
                    if iface != "lo":
                        active_connections.append(f"{iface} ({' '.join(parts[2:])})")
                    if VPN_IFACE_RE.match(iface):
                        vpn_interfaces.append(iface)
        if shutil.which("nmcli"):
            rc2, out2, _ = await _exec(
                ["nmcli", "-t", "-f", "NAME,TYPE,DEVICE", "connection", "show", "--active"], timeout=5.0
            )
            if rc2 == 0 and out2:
                for line in out2.splitlines():
                    parts = line.split(":")
                    if len(parts) >= 2 and (
                        "vpn" in parts[1].lower()
                        or "wireguard" in parts[1].lower()
                        or "tun" in parts[1].lower()
                    ):
                        vpn_interfaces.append(f"{parts[0]} ({parts[1]})")

    geo: dict[str, Any] = {}
    headers = {"User-Agent": "curl/8.5.0", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=6.0, follow_redirects=True, headers=headers) as client:
        for endpoint in ("https://ipwho.is/", "https://ipapi.co/json/"):
            try:
                resp = await client.get(endpoint)
                if resp.status_code == 200:
                    data = resp.json()
                    if isinstance(data, dict) and data.get("ip"):
                        geo = {
                            "public_ip": str(data.get("ip", "")),
                            "country": str(data.get("country") or data.get("country_name") or ""),
                            "country_code": str(data.get("country_code") or ""),
                            "city": str(data.get("city") or ""),
                            "region": str(data.get("region") or ""),
                            "isp": str(
                                (data.get("connection") or {}).get("isp")
                                if isinstance(data.get("connection"), dict)
                                else data.get("org") or ""
                            ),
                        }
                        break
            except (httpx.HTTPError, ValueError):
                continue

    return {
        "vpn_active": len(vpn_interfaces) > 0,
        "vpn_interfaces": vpn_interfaces,
        "active_connections": active_connections,
        **geo,
    }
