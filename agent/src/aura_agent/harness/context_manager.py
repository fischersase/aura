"""Kontextverwaltung innerhalb eines Auftrags (ADR 0004).

ADKs Kompaktierung läuft erst nach einem Auftrag. Lange Aufträge (viele Schritte, Bildschirmfotos,
große Seiten) brauchen das schon währenddessen. Dieses Plugin verändert nur die Anfrage ans Modell,
nie die gespeicherte Sitzung:

1. Bilder: nur die letzten zwei bleiben, ältere werden durch einen Hinweis ersetzt.
2. Alte Werkzeugausgaben: alles außer den letzten sechs wird auf einen Auszug gekürzt.
3. Wird es trotzdem zu groß (über 60 % des Kontextfensters), fallen die ältesten Schritte heraus;
   ein Hinweis nennt, welche Werkzeuge dort liefen. Aufruf und Ergebnis fallen immer gemeinsam weg.
4. Angeheftet an jede Anfrage: die ursprüngliche Bitte und die aktuelle Aufgabenliste.
"""

from __future__ import annotations

import json
from typing import cast

from google.adk.agents.callback_context import CallbackContext
from google.adk.models.llm_request import LlmRequest
from google.adk.plugins.base_plugin import BasePlugin
from google.genai import types

KEEP_IMAGES = 2
KEEP_FULL_RESULTS = 6
OLD_RESULT_CHARS = 1500
CHARS_PER_TOKEN = 3.2  # vorsichtig für Deutsch und JSON
BUDGET_SHARE = 0.6


def _size(c: types.Content) -> int:
    n = 0
    for p in c.parts or []:
        if p.text:
            n += len(p.text)
        elif p.function_call:
            n += len(json.dumps(p.function_call.args or {}, default=str)) + 40
        elif p.function_response:
            n += len(json.dumps(p.function_response.response or {}, default=str)) + 40
        elif p.inline_data:
            n += 3000  # Bild: grob 1000 Tokens
    return n


def _has_call(c: types.Content) -> bool:
    return any(p.function_call for p in c.parts or [])


def _has_response(c: types.Content) -> bool:
    return any(p.function_response for p in c.parts or [])


def trim_images(contents: list[types.Content], keep: int = KEEP_IMAGES) -> int:
    seen = 0
    removed = 0
    for c in reversed(contents):
        new_parts: list[types.Part] = []
        for p in c.parts or []:
            is_image = p.inline_data is not None and (p.inline_data.mime_type or "").startswith("image/")
            if is_image:
                seen += 1
                if seen > keep:
                    removed += 1
                    new_parts.append(types.Part(text="[älteres Bildschirmfoto entfernt]"))
                    continue
            if p.function_response and p.function_response.parts:
                kept: list[types.FunctionResponsePart] = []
                for fp in p.function_response.parts:
                    if fp.inline_data is not None and (fp.inline_data.mime_type or "").startswith("image/"):
                        seen += 1
                        if seen > keep:
                            removed += 1
                            continue
                    kept.append(fp)
                p = p.model_copy(
                    update={"function_response": p.function_response.model_copy(update={"parts": kept})}
                )
            new_parts.append(p)
        c.parts = new_parts
    return removed


def shorten_old_results(
    contents: list[types.Content], keep_full: int = KEEP_FULL_RESULTS, limit: int = OLD_RESULT_CHARS
) -> int:
    responses = [
        (ci, pi) for ci, c in enumerate(contents) for pi, p in enumerate(c.parts or []) if p.function_response
    ]
    shortened = 0
    for ci, pi in responses[:-keep_full] if keep_full else responses:
        parts = contents[ci].parts
        response = parts[pi].function_response if parts else None
        if parts is None or response is None:
            continue
        text = json.dumps(response.response or {}, ensure_ascii=False, default=str)
        if len(text) > limit:
            short = {
                "gekürzt": text[: limit // 2]
                + f" … ({len(text) - limit // 2} Zeichen ausgelassen, älteres Ergebnis)"
            }
            parts[pi] = types.Part(function_response=response.model_copy(update={"response": short}))
            shortened += 1
    return shortened


def drop_oldest_steps(contents: list[types.Content], budget_chars: int) -> list[str]:
    """Entfernt die ältesten Werkzeug-Schritte (Aufruf + Ergebnis), bis der Inhalt ins Budget passt.

    Die erste Nachricht des Nutzers und die letzten vier Inhalte bleiben immer erhalten.
    """
    dropped: list[str] = []
    while sum(_size(c) for c in contents) > budget_chars:
        idx = next(
            (
                i
                for i in range(1, len(contents) - 5)
                if _has_call(contents[i])
                and contents[i].role == "model"
                and i + 1 < len(contents)
                and _has_response(contents[i + 1])
            ),
            None,
        )
        if idx is None:
            break
        dropped += [
            p.function_call.name
            for p in contents[idx].parts or []
            if p.function_call and p.function_call.name
        ]
        del contents[idx : idx + 2]
    if dropped:
        note = types.Content(
            role="user",
            parts=[
                types.Part(
                    text=(
                        f"[Hinweis der App: {len(dropped)} ältere Schritte wurden aus Platzgründen ausgeblendet "
                        f"({', '.join(sorted(set(dropped)))}). Ihre Ergebnisse stehen nicht mehr hier; prüfe bei Bedarf erneut.]"
                    )
                )
            ],
        )
        contents.insert(1, note)
    return dropped


def current_request(contents: list[types.Content]) -> str:
    """Die letzte echte Bitte des Nutzers (keine Werkzeugergebnisse, keine Hinweise der App)."""
    for c in reversed(contents):
        if c.role == "user" and not _has_response(c):
            text = " ".join(p.text for p in c.parts or [] if p.text)
            if text.strip() and not text.startswith("[Hinweis der App"):
                return text
    return ""


class ContextManagerPlugin(BasePlugin):
    def __init__(self, num_ctx: int) -> None:
        super().__init__(name="aura_context")
        self.budget_chars = int(num_ctx * BUDGET_SHARE * CHARS_PER_TOKEN)

    async def before_model_callback(
        self, *, callback_context: CallbackContext, llm_request: LlmRequest
    ) -> None:
        contents = llm_request.contents
        if not contents:
            return
        # Nur den Teil des laufenden Auftrags anfassen: ab der letzten echten Nutzernachricht.
        request_text = current_request(contents)
        trim_images(contents)
        shorten_old_results(contents)
        # system_instruction is a genai union containing partially unknown types; only its text length matters.
        instruction = cast("object", llm_request.config.system_instruction)  # pyright: ignore[reportUnknownMemberType]
        system_size = len(str(instruction or ""))
        drop_oldest_steps(contents, max(4000, self.budget_chars - system_size))
        pins: list[str] = []
        todos = callback_context.state.get("todos")
        if todos:
            pins.append(
                "Aktuelle Aufgabenliste:\n"
                + "\n".join(f"- [{t.get('status')}] {t.get('text')}" for t in todos)
            )
        if request_text and len(contents) > 8:
            pins.append("Ursprüngliche Bitte des Nutzers in diesem Auftrag: " + request_text[:1500])
        if pins:
            llm_request.append_instructions(
                ["## Stand des Auftrags (von der App angeheftet)\n" + "\n\n".join(pins)]
            )


def estimate_tokens(contents: list[types.Content]) -> int:
    return int(sum(_size(c) for c in contents) / CHARS_PER_TOKEN)
