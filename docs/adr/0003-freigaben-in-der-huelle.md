# 0003 Freigaben und Regeln an der Werkzeuggrenze

## Kontext

ADK bietet `FunctionTool(require_confirmation=…)` und `tool_context.request_confirmation()`. Beides ist als experimentell markiert und laut Doku nicht mit `DatabaseSessionService` nutzbar. Außerdem braucht es Resume-Logik über die ADK-API.

## Entscheidung

- Jede Werkzeugausführung läuft durch die Hülle `GuardedTool`, eingehängt als ADK-Plugin (`before_tool_callback`, `after_tool_callback`, `on_tool_error_callback`). Das gilt auch für MCP-Werkzeuge.
- Ablauf: Argumente prüfen → Stufe T0 bis T3 und genaue Wirkung bestimmen → Regel auswerten (Verbot vor Rückfrage vor Erlauben) → bei Bedarf Freigabe per RPC an Electron → ausführen → Nachbedingung prüfen → Taint markieren → Audit.
- Eine Ablehnung wird dem Modell als Werkzeugergebnis `{"error": "Der Nutzer hat diese Aktion abgelehnt."}` gemeldet.
- Unbekannte Werkzeugnamen beantwortet die Hülle mit einer Fehlermeldung und der Liste verfügbarer Werkzeuge.
- Ausnahmen in Werkzeugen werden über `on_tool_error_callback` zu Fehlerergebnissen.
- Leere Endantworten weist der TaskController einmal zurück.

## Belege (Kanarientests)

- `test_plugin_sees_and_blocks_tools_inside_agent_tool`: Das Plugin sieht und blockiert Aufrufe auch im Spezialisten (AgentTool erbt Plugins); das innere Modell sieht die Ablehnung.
- `test_plugin_can_answer_unknown_tool_names`: Erfundene Namen führen nicht zum Absturz.
- `test_tool_exception_reaches_on_tool_error_callback`: Fehler kommen als Ergebnis zurück.

## Folgen

- Freigaben warten als awaited RPC. Stirbt der Prozess, gelten offene Freigaben als abgelehnt; das ist der sichere Standard.
- Die Kanarientests müssen vor jedem ADK-Update grün sein.
