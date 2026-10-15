"""Dynamische Subagenten-Architektur im Antigravity / Gemini 4 Stil (invoke_subagent, define_subagent).

Ermöglicht dem Root-Agenten:
1. Aufgaben an spezialisierte oder parallele Subagenten (research, computer, system, self) mit isoliertem Kontextfenster zu delegieren.
2. Eigene Subagenten für komplexe Spezialaufgaben zur Laufzeit mit define_subagent zu definieren.
3. Alle Sicherheitsgarantien (GuardPlugin, T0–T3 Policy, Taint-Tracking, Emergency-Stop) lückenlos in jedem Subagenten durchzusetzen.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from google.adk.agents import LlmAgent
from google.adk.memory.in_memory_memory_service import InMemoryMemoryService
from google.adk.models.base_llm import BaseLlm
from google.adk.runners import Runner
from google.adk.sessions.in_memory_session_service import InMemorySessionService
from google.adk.tools.agent_tool import AgentTool
from google.adk.tools.tool_context import ToolContext
from google.genai import types

from ..harness.tiers import Tier, aura_tool
from ..platform.base import IS_MACOS, IS_WINDOWS
from ..tools.apps import list_apps
from ..tools.desktop import launch_app, list_windows, open_target, window_action
from ..tools.files import edit_file, find_files, list_dir, move_path, read_file, trash, write_file
from ..tools.packages import install_software, network_status, search_software
from ..tools.pointer import click_at, clipboard, drag_mouse, move_mouse, press_keys, scroll_at, type_text
from ..tools.processes import manage_background_process, start_background_process
from ..tools.screen import screenshot
from ..tools.shell import run_command
from ..tools.system import dark_mode, media_control, media_status, settings, system_info, volume
from ..tools.ui import ui_act, ui_set_text, ui_snapshot
from ..tools.web import download_file, web_fetch, web_search

OS_LABEL = "Windows" if IS_WINDOWS else ("macOS" if IS_MACOS else "Linux")
SAFE_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{1,40}$")


@dataclass(frozen=True)
class CustomSubagentSpec:
    name: str
    description: str
    system_prompt: str
    enable_write_tools: bool = True


_CUSTOM_SUBAGENTS: dict[str, CustomSubagentSpec] = {}


RESEARCH_PROMPT = f"""Du bist der Research-Subagent von Aura auf einem {OS_LABEL}-System.
Deine Aufgabe ist gründliche, faktenbasierte Recherche im Web, in den Paketquellen und auf dem lokalen System.

Vorgehen:
1. Nutze web_search und web_fetch, um aktuelle Programme, kostenlose Dienste (z. B. VPN-Anbieter, Werkzeuge, Konfigurationen), Dokumentationen oder Lösungen zu finden.
2. Nutze search_software und list_apps, um zu prüfen, welche Programme bereits installiert oder direkt in den System-Paketquellen (Flatpak, APT, Snap, Winget, Homebrew) verfügbar sind.
3. Nutze network_status und system_info, um den aktuellen Zustand des Systems und Netzwerks zu prüfen.
4. Liefere dem Hauptagenten eine präzise, verifizierte Zusammenfassung mit konkreten Paket-IDs, Download-Links, Befehlen und Prüfkriterien."""


COMPUTER_PROMPT = f"""Du bist der Computer-Use-Subagent von Aura auf einem {OS_LABEL}-System.
Du steuerst jedes beliebige Desktop-Programm 100 % autonom über Barrierefreiheit (UI-Baum) sowie Vision, Maus, Tastatur und Zwischenablage.

Vorgehen:
1. Programm starten oder in den Vordergrund holen: launch_app, list_windows, window_action(action="focus").
2. Zuerst ui_snapshot prüfen: Wenn Bedienelemente sichtbar sind, nutze ui_act und ui_set_text (schnell und exakt).
3. Wenn das Programm keine Barrierefreiheits-Elemente liefert oder komplexe Grafik/Regler nutzt (z. B. Bildbearbeitung, Spiele, eigene Oberflächen, VPN-Karten):
   - Mache ein screenshot.
   - Nutze click_at, move_mouse, drag_mouse (z. B. für Schieberegler/Auswahlrahmen), scroll_at, clipboard(action="write") + press_keys("ctrl+v") oder type_text.
   - Prüfe nach jeder Aktion anhand des neuen Screenshots oder ui_snapshot, ob die Aktion gewirkt hat.
4. Melde am Ende präzise zurück, was du im Programm ausgeführt hast und welcher Zustand jetzt sichtbar ist."""


SYSTEM_PROMPT = f"""Du bist der System- & Software-Subagent von Aura auf einem {OS_LABEL}-System.
Du übernimmst Software-Installation, Datei-Downloads, Konfiguration, Hintergrundprozesse und Netzwerk-/VPN-Einrichtung.

Vorgehen:
1. Prüfe zuerst mit search_software oder list_apps, ob das gewünschte Paket bereits existiert oder in offiziellen Quellen liegt.
2. Installiere Pakete bevorzugt mit install_software (oder lade offizielle Pakete/Konfigurationen mit download_file herunter).
3. Für langlaufende Prozesse (z. B. OpenVPN/WireGuard-Tunnel, lokale Server) nutze start_background_process und prüfe die Ausgabe mit manage_background_process.
4. Verifiziere nach jeder Änderung das Ergebnis (z. B. mit network_status bei VPN-/Netzwerkaufgaben, sodass öffentliche IP und Land bewiesen sind)."""


READ_ONLY_TOOLS: list[Any] = [
    web_search,
    web_fetch,
    search_software,
    network_status,
    system_info,
    list_apps,
    list_windows,
    list_dir,
    find_files,
    read_file,
    ui_snapshot,
    screenshot,
]

COMPUTER_TOOLS: list[Any] = [
    launch_app,
    open_target,
    list_windows,
    window_action,
    ui_snapshot,
    ui_act,
    ui_set_text,
    screenshot,
    click_at,
    move_mouse,
    drag_mouse,
    scroll_at,
    type_text,
    press_keys,
    clipboard,
    media_status,
    media_control,
    volume,
    dark_mode,
    settings,
]

SYSTEM_TOOLS: list[Any] = [
    web_search,
    web_fetch,
    download_file,
    search_software,
    install_software,
    network_status,
    system_info,
    list_apps,
    list_dir,
    find_files,
    read_file,
    write_file,
    edit_file,
    move_path,
    trash,
    run_command,
    start_background_process,
    manage_background_process,
]


def _build_subagent(model: BaseLlm, subagent_type: str, role: str) -> LlmAgent | None:
    kind = subagent_type.strip().lower()
    safe_agent_name = re.sub(r"[^a-zA-Z0-9_]", "_", f"sub_{kind}")[:40]
    role_prefix = f"Deine Rolle für diesen Teilauftrag: {role}.\n\n" if role else ""

    if kind == "research":
        return LlmAgent(
            name=safe_agent_name,
            model=model,
            description="Research-Subagent für Web-, Software- und System-Recherche",
            instruction=role_prefix + RESEARCH_PROMPT,
            tools=list(READ_ONLY_TOOLS),
        )
    if kind in ("computer", "gui", "desktop"):
        return LlmAgent(
            name=safe_agent_name,
            model=model,
            description="Computer-Use-Subagent für Desktop-Programme (UI-Baum, Vision, Maus, Tastatur)",
            instruction=role_prefix + COMPUTER_PROMPT,
            tools=list(COMPUTER_TOOLS),
        )
    if kind in ("system", "installer", "network"):
        return LlmAgent(
            name=safe_agent_name,
            model=model,
            description="System-Subagent für Software-Installation, Downloads, Prozesse und Netzwerk/VPN",
            instruction=role_prefix + SYSTEM_PROMPT,
            tools=list(SYSTEM_TOOLS),
        )
    if kind == "self":
        combined: list[Any] = list(dict.fromkeys([*READ_ONLY_TOOLS, *COMPUTER_TOOLS, *SYSTEM_TOOLS]))
        return LlmAgent(
            name=safe_agent_name,
            model=model,
            description="Universeller Subagent mit Recherche-, System- und Computer-Use-Werkzeugen",
            instruction=role_prefix + RESEARCH_PROMPT + "\n\n" + COMPUTER_PROMPT + "\n\n" + SYSTEM_PROMPT,
            tools=combined,
        )
    custom = _CUSTOM_SUBAGENTS.get(kind) or _CUSTOM_SUBAGENTS.get(subagent_type.strip())
    if custom is not None:
        tools: list[Any] = (
            list(dict.fromkeys([*READ_ONLY_TOOLS, *COMPUTER_TOOLS, *SYSTEM_TOOLS]))
            if custom.enable_write_tools
            else list(READ_ONLY_TOOLS)
        )
        return LlmAgent(
            name=re.sub(r"[^a-zA-Z0-9_]", "_", custom.name)[:40],
            model=model,
            description=custom.description,
            instruction=role_prefix + custom.system_prompt,
            tools=tools,
        )
    return None


async def _run_single_subagent(
    model: BaseLlm,
    subagent_type: str,
    role: str,
    prompt: str,
    tool_context: ToolContext | None,
) -> dict[str, Any]:
    agent = _build_subagent(model, subagent_type, role)
    if agent is None:
        known = ["research", "computer", "system", "self", *_CUSTOM_SUBAGENTS.keys()]
        return {
            "type": subagent_type,
            "role": role,
            "error": f"Unbekannter Subagent-Typ {subagent_type!r}. Verfügbar: {', '.join(known)}",
        }
    if not prompt.strip():
        return {"type": subagent_type, "role": role, "error": "prompt darf nicht leer sein."}

    if tool_context is not None and getattr(tool_context, "_invocation_context", None) is not None:
        wrapped = AgentTool(agent=agent, include_plugins=True)
        out = await wrapped.run_async(args={"request": prompt}, tool_context=tool_context)
        return {"type": subagent_type, "role": role or subagent_type, "result": str(out or "").strip()}

    # Fallback for direct unit-test invocation without an active ADK ToolContext
    runner = Runner(
        app_name="aura_subagent",
        agent=agent,
        session_service=InMemorySessionService(),
        memory_service=InMemoryMemoryService(),
    )
    session = await runner.session_service.create_session(app_name="aura_subagent", user_id="local")
    texts: list[str] = []
    async for event in runner.run_async(
        user_id="local",
        session_id=session.id,
        new_message=types.Content(role="user", parts=[types.Part.from_text(text=prompt)]),
    ):
        if event.content and event.content.parts:
            for part in event.content.parts:
                if part.text:
                    texts.append(part.text)
    return {"type": subagent_type, "role": role or subagent_type, "result": "\n".join(texts).strip()}


def make_subagent_tools(model: BaseLlm) -> list[Callable[..., Any]]:
    """Erzeugt define_subagent und invoke_subagent gebunden an das aktuelle Sprachmodell."""

    @aura_tool(
        Tier.T0,
        label=lambda a: f"Subagent definieren: {a.get('name', '')} ({a.get('description', '')[:50]})",
    )
    def define_subagent(
        name: str,
        description: str,
        system_prompt: str,
        enable_write_tools: bool = True,
    ) -> dict[str, Any]:
        """Definiert einen neuen spezialisierten Subagenten-Typ für dieses Gespräch, der danach mit invoke_subagent aufgerufen werden kann.

        Args:
          name: Eindeutiger Name (nur Buchstaben, Ziffern, Unterstrich, z. B. "vpn_specialist" oder "photo_editor").
          description: Kurze Beschreibung, wann dieser Subagent eingesetzt wird.
          system_prompt: Detaillierte Systemanweisung für den Subagenten.
          enable_write_tools: True (Standard), wenn der Subagent auch Programme bedienen, Dateien schreiben und installieren darf; False für reine Recherche.
        """
        clean = name.strip()
        if not SAFE_NAME_RE.match(clean):
            return {
                "error": "Ungültiger Name: Bitte nur Buchstaben, Ziffern und '_' verwenden (beginnend mit einem Buchstaben)."
            }
        spec = CustomSubagentSpec(
            name=clean,
            description=description.strip() or clean,
            system_prompt=system_prompt.strip(),
            enable_write_tools=bool(enable_write_tools),
        )
        _CUSTOM_SUBAGENTS[clean.lower()] = spec
        return {
            "ok": True,
            "name": clean,
            "enable_write_tools": spec.enable_write_tools,
            "available_subagents": ["research", "computer", "system", "self", *_CUSTOM_SUBAGENTS.keys()],
        }

    @aura_tool(
        Tier.T0,
        label=lambda a: (
            f"Subagenten starten ({len(a.get('subagents') or [])})"
            if a.get("subagents")
            else f"Subagent [{a.get('subagent_type', 'research')}]: {str(a.get('role') or a.get('prompt', ''))[:70]}"
        ),
    )
    async def invoke_subagent(
        subagent_type: str = "research",
        prompt: str = "",
        role: str = "",
        subagents: list[dict[str, str]] | None = None,
        tool_context: ToolContext | None = None,
    ) -> dict[str, Any]:
        """Ruft einen oder mehrere spezialisierte Subagenten mit eigenem Kontextfenster auf (einzeln oder parallel).

        Eingebaute Typen (`subagent_type`):
        - "research": Sucht im Web (`web_search`, `web_fetch`), in Paketquellen (`search_software`) und prüft System/Netzwerk (`network_status`).
        - "computer": Öffnet und bedient Desktop-Programme über UI-Baum (`ui_snapshot`, `ui_act`) sowie Screenshot, Maus (`click_at`, `drag_mouse`, `scroll_at`), Tastatur und Zwischenablage.
        - "system": Lädt Dateien herunter (`download_file`), installiert Software (`install_software`), startet Hintergrundprozesse (`start_background_process`) und prüft Netzwerk/VPN (`network_status`).
        - "self": Universeller Subagent mit allen Recherche-, Computer-Use- und System-Werkzeugen.
        - Oder ein zuvor mit `define_subagent` angelegter Name.

        Args:
          subagent_type: Typ des Subagenten ("research", "computer", "system", "self" oder eigener Name).
          prompt: Klare, vollständige Aufgabenbeschreibung für den Subagenten.
          role: Kurzer Rollentitel (2–5 Wörter), z. B. "VPN Spain Researcher" oder "GIMP Photo Editor".
          subagents: Optional für parallele Ausführung mehrerer Subagenten gleichzeitig: Liste von Objekten mit {"type": "...", "role": "...", "prompt": "..."}.
        """
        if subagents and isinstance(subagents, list):
            coros = [
                _run_single_subagent(
                    model,
                    str(item.get("type") or item.get("subagent_type") or "research"),
                    str(item.get("role") or ""),
                    str(item.get("prompt") or ""),
                    tool_context,
                )
                for item in subagents
                if isinstance(item, dict)
            ]
            if not coros:
                return {"error": "Keine gültigen Einträge in subagents übergeben."}
            results = await asyncio.gather(*coros)
            return {"count": len(results), "results": list(results)}

        res = await _run_single_subagent(model, subagent_type, role, prompt, tool_context)
        return res

    return [define_subagent, invoke_subagent]
