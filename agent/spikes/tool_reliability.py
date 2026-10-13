"""P0-Spike: Wählt ein lokales Modell über ADK + OllamaLlm das richtige Werkzeug?

Misst je Modell und Werkzeuganzahl (8/12/20): Trefferquote beim ersten
Werkzeugaufruf, richtige Argumente, Reparaturen und Latenz. Die Werkzeuge sind
Attrappen; es geht nur um die Auswahl.

Aufruf: uv run python spikes/tool_reliability.py gemma4:26b [qwen3.6:27b …]
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

from google.adk.agents import LlmAgent
from google.adk.runners import InMemoryRunner
from google.genai import types

from aura_agent.models import repair
from aura_agent.models.ollama_llm import OllamaLlm

# ---------- Attrappen-Werkzeuge ----------

def media_control(action: str) -> dict:
  """Steuert die laufende Medienwiedergabe (Musik, Videos). action: play, pause, toggle, next, previous."""
  return {"ok": True, "status": "Paused" if action == "pause" else "Playing"}


def media_status() -> dict:
  """Zeigt, was gerade abgespielt wird (Titel, Künstler, Player, Status)."""
  return {"player": "chrome", "title": "Me Porto Bonito", "artist": "Bad Bunny", "status": "Playing"}


def launch_app(name: str) -> dict:
  """Startet ein installiertes Programm per Name, z. B. "Firefox" oder "Antigravity", und wartet auf sein Fenster."""
  return {"ok": True, "window": f"{name} – Fenster"}


def list_windows() -> dict:
  """Listet alle offenen Fenster mit Titel, Programm und ID."""
  return {"windows": [{"id": "0x1", "app": "google-chrome", "title": "YouTube Music"}]}


def read_file(path: str) -> dict:
  """Liest eine Textdatei oder PDF."""
  return {"path": path, "content": "Einkaufsliste: Milch, Brot"}


def find_files(pattern: str, folder: str = "~") -> dict:
  """Sucht Dateien nach Namen oder Muster (z. B. *.pdf) in einem Ordner."""
  return {"results": [f"{folder}/rechnung.pdf"]}


def volume(level: int) -> dict:
  """Setzt die Systemlautstärke in Prozent (0–100)."""
  return {"ok": True, "level": level}


def web_search(query: str) -> dict:
  """Sucht im Internet und liefert Treffer mit Titel, Link und Auszug."""
  return {"results": [{"title": "Wetter Berlin", "snippet": "Morgen 14 °C, Regen"}]}


def write_file(path: str, content: str) -> dict:
  """Schreibt Text in eine Datei (legt sie an oder ersetzt sie)."""
  return {"ok": True}


def shell(command: str) -> dict:
  """Führt einen bash-Befehl aus und gibt die Ausgabe zurück."""
  return {"exit_code": 0, "output": ""}


def settings_set(key: str, value: str) -> dict:
  """Ändert eine Systemeinstellung (gsettings), z. B. Dunkelmodus oder Nachtlicht."""
  return {"ok": True}


def clipboard_write(text: str) -> dict:
  """Legt Text in die Zwischenablage."""
  return {"ok": True}


def window_action(window_id: str, action: str) -> dict:
  """Fokussiert, minimiert, maximiert oder schließt ein Fenster. action: focus, minimize, maximize, close."""
  return {"ok": True}


def list_dir(path: str) -> dict:
  """Listet den Inhalt eines Ordners."""
  return {"items": []}


def web_fetch(url: str) -> dict:
  """Lädt eine Webseite und gibt ihren Text zurück."""
  return {"text": ""}


def settings_get(key: str) -> dict:
  """Liest eine Systemeinstellung (gsettings)."""
  return {"value": ""}


def clipboard_read() -> dict:
  """Liest den Text aus der Zwischenablage."""
  return {"text": ""}


def notify(title: str, body: str) -> dict:
  """Zeigt eine Desktop-Benachrichtigung."""
  return {"ok": True}


def system_info() -> dict:
  """Systeminfos: CPU, Arbeitsspeicher, freier Speicherplatz, Akku, Betriebssystem."""
  return {"disk_free_gb": 562}


def todo_write(items: list[str]) -> dict:
  """Legt die Aufgabenliste für den aktuellen Auftrag an oder aktualisiert sie."""
  return {"ok": True}


CORE = [media_control, media_status, launch_app, list_windows, read_file, find_files, volume, web_search]
MID = [*CORE, write_file, shell, settings_set, clipboard_write]
FULL = [*MID, window_action, list_dir, web_fetch, settings_get, clipboard_read, notify, system_info, todo_write]

# (Bitte, erwartetes Werkzeug, Prüfung der Argumente)
CASES = [
    ("Pausiere bitte die Musik", "media_control", lambda a: a.get("action") in ("pause", "toggle")),
    ("nächster song", "media_control", lambda a: a.get("action") == "next"),
    ("Was läuft gerade für ein Lied?", "media_status", lambda a: True),
    ("öffne antigravity", "launch_app", lambda a: "antigravity" in str(a.get("name", "")).lower()),
    ("Starte Firefox", "launch_app", lambda a: "firefox" in str(a.get("name", "")).lower()),
    ("Welche Fenster sind gerade offen?", "list_windows", lambda a: True),
    ("Lies mir ~/notizen.txt vor", "read_file", lambda a: "notizen" in str(a.get("path", ""))),
    ("Finde alle PDFs in meinem Downloads-Ordner", "find_files", lambda a: "pdf" in json.dumps(a).lower()),
    ("Mach die Lautstärke auf 30 Prozent", "volume", lambda a: str(a.get("level")) == "30"),
    ("Wie wird das Wetter morgen in Berlin?", "web_search", lambda a: "berlin" in str(a.get("query", "")).lower()),
]

INSTRUCTION = (
    "Du bist Aura, ein Assistent auf dem Linux-PC des Nutzers. Erledige Wünsche selbst mit deinen Werkzeugen, "
    "statt Anleitungen zu schreiben. Antworte kurz auf Deutsch."
)


async def run_case(model: str, tools: list, prompt: str) -> dict:
  llm = OllamaLlm(model=f"ollama/{model}", num_ctx=32768, think=False)
  agent = LlmAgent(name="aura", model=llm, instruction=INSTRUCTION, tools=tools)
  runner = InMemoryRunner(agent=agent, app_name="spike")
  session = await runner.session_service.create_session(app_name="spike", user_id="u")
  calls: list[tuple[str, dict]] = []
  answer = ""
  t0 = time.monotonic()
  first_call_s = None
  async for event in runner.run_async(
      user_id="u", session_id=session.id, new_message=types.Content(role="user", parts=[types.Part(text=prompt)])
  ):
    for fc in event.get_function_calls():
      calls.append((fc.name, dict(fc.args or {})))
      first_call_s = first_call_s or time.monotonic() - t0
    if event.is_final_response() and event.content and event.content.parts:
      answer = "".join(p.text or "" for p in event.content.parts if not p.thought)
    if event.error_message:
      answer = f"FEHLER {event.error_code}: {event.error_message}"
  return {"calls": calls, "answer": answer, "total_s": time.monotonic() - t0, "first_call_s": first_call_s}


async def main(models: list[str]) -> None:
  results = []
  for model in models:
    await run_case(model, CORE, "Hallo")  # Modell laden, nicht mitzählen
    for label, tools in (("8", CORE), ("12", MID), ("20", FULL)):
      repair.STATS.clear()
      hits = args_ok = 0
      times = []
      rows = []
      for prompt, want, check in CASES:
        r = await run_case(model, tools, prompt)
        first = r["calls"][0] if r["calls"] else (None, {})
        hit = first[0] == want
        ok = hit and check(first[1])
        hits += hit
        args_ok += ok
        times.append(r["total_s"])
        rows.append({"prompt": prompt, "want": want, "got": first[0], "args": first[1], "ok": ok, "answer": r["answer"][:160], "s": round(r["total_s"], 2)})
      res = {
          "model": model, "tools": label, "tool_hit": f"{hits}/{len(CASES)}", "args_ok": f"{args_ok}/{len(CASES)}",
          "median_s": round(sorted(times)[len(times) // 2], 2), "repairs": dict(repair.STATS), "rows": rows,
      }
      results.append(res)
      print(f"{model:18} tools={label:2}  Werkzeug {res['tool_hit']}  Argumente {res['args_ok']}  Median {res['median_s']} s  Reparaturen {res['repairs']}", flush=True)
      for row in rows:
        if not row["ok"]:
          print(f"   ✗ {row['prompt']!r}: wollte {row['want']}, bekam {row['got']} {row['args']} | {row['answer']!r}", flush=True)
  out = Path(__file__).parent / "results" / "tool_reliability.json"
  out.parent.mkdir(exist_ok=True)
  out.write_text(json.dumps(results, ensure_ascii=False, indent=1))


if __name__ == "__main__":
  asyncio.run(main(sys.argv[1:] or ["gemma4:26b"]))
