"""Windows-Einstellungen: Dunkelmodus und Registry-Werte, mit Nachprüfung (Gegenstück zu settings/dark_mode in system.py).

Stufen wie unter Linux: lesen T0; eine kleine Liste harmloser Werte des Benutzers T1; alles andere T2;
Sicherheits- und Richtlinien-Schlüssel T3.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any

from ..harness.tiers import Tier, aura_tool
from ..platform import win_registry as reg

PERSONALIZE = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"
ADVANCED = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced"
NOTIFICATIONS = r"HKCU\Software\Microsoft\Windows\CurrentVersion\PushNotifications"

# (Schlüssel, Wert) in Kleinbuchstaben: ohne Rückfrage änderbar (umkehrbar, harmlos).
SETTINGS_T1 = {(k.lower(), n.lower()) for k, n in (
    (PERSONALIZE, "AppsUseLightTheme"), (PERSONALIZE, "SystemUsesLightTheme"), (PERSONALIZE, "EnableTransparency"),
    (PERSONALIZE, "ColorPrevalence"), (ADVANCED, "HideFileExt"), (ADVANCED, "Hidden"), (ADVANCED, "TaskbarAl"),
    (ADVANCED, "ShowSecondsInSystemClock"), (ADVANCED, "LaunchTo"), (NOTIFICATIONS, "ToastEnabled"),
)}
SETTINGS_T3 = re.compile(r"\\policies\\|\\policies$|\\lsa(\\|$)|windows defender|securityproviders|\\winlogon(\\|$)|enablelua|"
                         r"^hklm\\(sam|security)(\\|$)|\\terminal server(\\|$)|\\control\\securepipeservers", re.IGNORECASE)


def _key(a: dict[str, Any]) -> str:
  try:
    return reg.display(str(a.get("key", "")))
  except ValueError:
    return str(a.get("key", ""))


def _settings_tier(a: dict[str, Any]) -> tuple[Tier, str]:
  key = _key(a)
  if SETTINGS_T3.search(key):
    return Tier.T3, "Sicherheits- und Richtlinieneinstellungen"
  if a.get("value") is None:
    return Tier.T0, ""
  if (key.lower(), str(a.get("name", "")).lower()) in SETTINGS_T1:
    return Tier.T1, ""
  return Tier.T2, "Registry-Wert außerhalb der freigegebenen Liste"


@aura_tool(_settings_tier, label=lambda a: f"{_key(a)} {a.get('name', '')}" + (f" = {a['value']}" if a.get("value") is not None else ""))
async def settings(key: str, name: str, value: str | None = None) -> dict[str, Any]:
  """Liest oder ändert eine Windows-Einstellung in der Registry. Für hell/dunkel dark_mode nehmen.

  Beispiele: Dateiendungen anzeigen: key "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced",
  name "HideFileExt", value "0". Benachrichtigungen aus (nicht stören): key
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications", name "ToastEnabled", value "0".

  Args:
    key: Registry-Schlüssel, beginnt mit HKCU\\ (Benutzer) oder HKLM\\ (System).
    name: Name des Werts.
    value: Neuer Wert (Zahl oder Text). Ohne value wird nur gelesen.
  """
  try:
    shown = reg.display(key)
    before = await asyncio.to_thread(reg.read, key, name)
  except (ValueError, OSError) as e:
    return {"error": str(e)}
  if value is None:
    if before is None:
      return {"key": shown, "name": name, "error": "Wert gibt es nicht."}
    return {"key": shown, "name": name, "value": before[0]}
  try:
    await asyncio.to_thread(reg.write, key, name, str(value))
  except PermissionError:
    return {"error": "Keine Berechtigung (Systemschlüssel brauchen Administratorrechte)."}
  except (ValueError, OSError) as e:
    return {"error": str(e)}
  await asyncio.to_thread(reg.broadcast, "ImmersiveColorSet" if "personalize" in shown.lower() else None)
  after = await asyncio.to_thread(reg.read, key, name)
  ok = after is not None and str(after[0]).lower() == str(reg.coerce(value, after[1])).lower()
  out = {"key": shown, "name": name, "before": before[0] if before else None, "after": after[0] if after else None, "verified": ok}
  if not ok:
    out["error"] = "Wert wurde nicht übernommen."
  elif "explorer\\advanced" in shown.lower():
    out["note"] = "Explorer-Fenster zeigen die Änderung nach dem Aktualisieren (F5) oder Neuöffnen."
  return out


@aura_tool(Tier.T1, label=lambda a: "Dunkelmodus " + ("an" if a.get("on", True) else "aus"))
async def dark_mode(on: bool = True) -> dict[str, Any]:
  """Schaltet den Dunkelmodus von Windows (Apps und Taskleiste) ein oder aus, mit Nachprüfung.

  Args:
    on: true = dunkel, false = hell.
  """
  light = "0" if on else "1"
  try:
    for name in ("AppsUseLightTheme", "SystemUsesLightTheme"):
      await asyncio.to_thread(reg.write, PERSONALIZE, name, light)
  except OSError as e:
    return {"error": f"Konnte den Dunkelmodus nicht umstellen: {e}"}
  await asyncio.to_thread(reg.broadcast, "ImmersiveColorSet")
  apps = await asyncio.to_thread(reg.read, PERSONALIZE, "AppsUseLightTheme")
  system = await asyncio.to_thread(reg.read, PERSONALIZE, "SystemUsesLightTheme")
  values = {"AppsUseLightTheme": apps[0] if apps else None, "SystemUsesLightTheme": system[0] if system else None}
  is_dark = values["AppsUseLightTheme"] == 0
  ok = is_dark == on and values["SystemUsesLightTheme"] == int(light)
  return {"dark": is_dark, "settings": values, "verified": ok, **({} if ok else {"error": "Einstellung wurde nicht übernommen."})}
