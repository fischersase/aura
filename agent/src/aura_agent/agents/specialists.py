"""Spezialisten: eigene Agenten mit eigenem Kontext und wenigen Werkzeugen, vom Root-Agenten als Werkzeug gerufen.

Ein Modell für alle (nur eins passt in den Grafikspeicher); sie unterscheiden sich in Anweisung und Werkzeugen.
Große Zwischenstände (z. B. Webseiten) bleiben im Kontext des Spezialisten; zurück kommt nur das Ergebnis.
"""

from __future__ import annotations

from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.tools.agent_tool import AgentTool
from google.adk.tools.mcp_tool.mcp_toolset import McpToolset

from ..tools.browser import BROWSER_INSTRUCTION


def browser_agent(model: BaseLlm, toolset: McpToolset) -> AgentTool:
  agent = LlmAgent(
      name="browser",
      model=model,
      description=(
          "Bedient Webseiten in einem eigenen Chrome-Fenster: suchen, klicken, Formulare ausfüllen, Musik oder Videos "
          "auf Webseiten starten (z. B. YouTube Music), Informationen von Seiten lesen. Gib eine klare, vollständige "
          "Aufgabe als request mit, z. B. „Öffne YouTube Music, suche nach Bad Bunny und starte den ersten Song.“"
      ),
      instruction=BROWSER_INSTRUCTION,
      tools=[toolset],
  )
  return AgentTool(agent=agent)
