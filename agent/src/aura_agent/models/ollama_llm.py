"""Ollama als ADK-Modell, über die native /api/chat.

Warum kein LiteLLM: Die native API kann num_ctx, keep_alive, think und Bilder
setzen und wendet die Chat-Vorlage des Modells selbst an (gemma4, qwen). Über
die OpenAI-kompatible API ginge num_ctx nicht, und ein abweichendes num_ctx
lässt Ollama das Modell jedes Mal neu laden (~70 s bei 18 GB).
"""

from __future__ import annotations

import base64
import contextlib
import json
import logging
import uuid
from collections.abc import AsyncGenerator
from typing import Any

import httpx
from google.adk.models._capabilities import LlmCapabilities
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from pydantic import Field

from . import repair

log = logging.getLogger(__name__)
MAX_EMPTY_RETRIES = 2


def schema_to_json(schema: Any) -> dict[str, Any]:
    """types.Schema (oder dict) als JSON Schema mit kleingeschriebenen Typen."""
    if schema is None:
        return {"type": "object", "properties": {}}
    d = (
        schema.model_dump(by_alias=True, exclude_none=True)
        if isinstance(schema, types.Schema)
        else dict(schema)
    )
    return _lower_types(d)


def _lower_types(d: Any) -> Any:
    if isinstance(d, list):
        return [_lower_types(x) for x in d]
    if not isinstance(d, dict):
        return d
    out = {}
    for k, v in d.items():
        if k == "type":
            if isinstance(v, list):
                v = [str(getattr(x, "value", x)).lower() for x in v]
            else:
                v = str(getattr(v, "value", v)).lower()
        elif k in ("properties", "$defs", "definitions") and isinstance(v, dict):
            v = {pk: _lower_types(pv) for pk, pv in v.items()}
        elif isinstance(v, (dict, list)):
            v = _lower_types(v)
        out[k] = v
    return out


def tool_specs(req: LlmRequest) -> list[dict[str, Any]]:
    specs = []
    for tool in (req.config.tools or []) if req.config else []:
        for fd in getattr(tool, "function_declarations", None) or []:
            if fd.parameters_json_schema:
                params = _lower_types(dict(fd.parameters_json_schema))
            else:
                params = schema_to_json(fd.parameters)
            params.setdefault("type", "object")
            params.setdefault("properties", {})
            specs.append(
                {
                    "type": "function",
                    "function": {"name": fd.name, "description": fd.description or "", "parameters": params},
                }
            )
    return specs


def _system_text(instr: Any) -> str:
    if not instr:
        return ""
    if isinstance(instr, str):
        return instr
    if isinstance(instr, types.Content):
        return "\n".join(p.text for p in instr.parts or [] if p.text)
    if isinstance(instr, list):
        return "\n".join(_system_text(x) for x in instr)
    return str(instr)


def _b64(data: bytes | str) -> str:
    return data if isinstance(data, str) else base64.b64encode(data).decode()


def _is_image(blob: types.Blob | None) -> bool:
    return bool(blob and blob.data and (blob.mime_type or "").startswith("image/"))


def to_messages(req: LlmRequest) -> list[dict[str, Any]]:
    """ADK-Verlauf (genai Contents) in Ollama-Nachrichten übersetzen."""
    msgs: list[dict[str, Any]] = []
    system = _system_text(req.config.system_instruction if req.config else None)
    if system:
        msgs.append({"role": "system", "content": system})
    for content in req.contents:
        texts: list[str] = []
        images: list[str] = []
        calls: list[types.FunctionCall] = []
        responses: list[types.FunctionResponse] = []
        for part in content.parts or []:
            if part.thought:
                continue
            if part.function_call:
                calls.append(part.function_call)
            elif part.function_response:
                responses.append(part.function_response)
            elif part.text:
                texts.append(part.text)
            elif _is_image(part.inline_data):
                images.append(_b64(part.inline_data.data))
        if content.role == "model":
            msg: dict[str, Any] = {"role": "assistant", "content": "".join(texts)}
            if calls:
                msg["tool_calls"] = [{"function": {"name": c.name, "arguments": c.args or {}}} for c in calls]
            msgs.append(msg)
            continue
        tool_images: list[str] = []
        for r in responses:
            msgs.append(
                {
                    "role": "tool",
                    "tool_name": r.name,
                    "content": json.dumps(r.response or {}, ensure_ascii=False, default=str),
                }
            )
            for p in r.parts or []:
                if _is_image(p.inline_data):
                    tool_images.append(_b64(p.inline_data.data))
        images = tool_images + images
        if texts or images:
            user: dict[str, Any] = {"role": "user", "content": "\n".join(texts) or "(Bild)"}
            if images:
                user["images"] = images
            msgs.append(user)
    return msgs


class OllamaLlm(BaseLlm):
    """Lokales Modell über Ollama. Ein Modell für alle Agenten (nur eins passt in den Grafikspeicher)."""

    base_url: str = "http://127.0.0.1:11434"
    num_ctx: int = 32768
    keep_alive: str = "30m"
    think: bool | None = None
    temperature: float | None = None
    timeout_s: float = 600.0
    transport: Any = Field(default=None, exclude=True)
    """Nur für Tests: httpx-Transport statt echter Verbindung."""

    @property
    def capabilities(self) -> LlmCapabilities:
        return LlmCapabilities(output_schema_and_tools=False)

    @classmethod
    def supported_models(cls) -> list[str]:
        return [r"ollama/.*"]

    def _body(self, req: LlmRequest, stream: bool) -> dict[str, Any]:
        options: dict[str, Any] = {"num_ctx": self.num_ctx}
        temp = (
            req.config.temperature if req.config and req.config.temperature is not None else self.temperature
        )
        if temp is not None:
            options["temperature"] = temp
        if req.config and req.config.max_output_tokens:
            options["num_predict"] = req.config.max_output_tokens
        body: dict[str, Any] = {
            "model": self.model.removeprefix("ollama/"),
            "messages": to_messages(req),
            "stream": stream,
            "keep_alive": self.keep_alive,
            "options": options,
        }
        tools = tool_specs(req)
        if tools:
            body["tools"] = tools
        if self.think is not None:
            body["think"] = self.think
        return body

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        """Wie _generate_once, aber leere Antworten (kein Text, kein Werkzeugaufruf) werden neu angefragt.

        Beobachtet bei gemma4 über Ollama: Bei manchen Anfragen erzeugt das Modell einige Tokens, die Ollama verwirft
        (vermutlich ein nicht erkannter Werkzeugaufruf); übrig bleibt eine leere Antwort. Mit eingeschaltetem „Denken“
        passiert das nicht (gemessen 0/10 statt 10/10), daher laufen Wiederholungen mit think=True.
        """
        for attempt in range(MAX_EMPTY_RETRIES + 1):
            final: LlmResponse | None = None
            # Gemessen (gemma4:26b, 10 Versuche): bestimmte Anfragen liefern ohne „Denken“ immer leer, mit „Denken“ nie.
            # Wiederholungen laufen deshalb mit think=True.
            async for r in self._generate_once(llm_request, stream, think=True if attempt else None):
                if r.partial:
                    yield r
                else:
                    final = r
            if final is None:
                return
            empty = not final.error_code and not any(
                p.text or p.function_call for p in (final.content.parts if final.content else [])
            )
            if empty and attempt < MAX_EMPTY_RETRIES:
                repair.STATS["empty_retry"] += 1
                continue
            yield final
            return

    async def _generate_once(
        self, llm_request: LlmRequest, stream: bool = False, think: bool | None = None
    ) -> AsyncGenerator[LlmResponse, None]:
        body = self._body(llm_request, stream=True)
        if think is not None:
            body["think"] = think
        known = list(llm_request.tools_dict.keys()) or [t["function"]["name"] for t in body.get("tools", [])]
        schemas = {t["function"]["name"]: t["function"]["parameters"] for t in body.get("tools", [])}
        text, thinking = "", ""
        raw_calls: list[dict[str, Any]] = []
        final: dict[str, Any] = {}
        try:
            timeout = httpx.Timeout(self.timeout_s, connect=10.0)
            async with (
                httpx.AsyncClient(timeout=timeout, transport=self.transport) as client,
                client.stream("POST", f"{self.base_url}/api/chat", json=body) as res,
            ):
                if res.status_code >= 400:
                    detail = (await res.aread()).decode(errors="replace")
                    yield _error(res.status_code, detail)
                    return
                async for line in res.aiter_lines():
                    if not line.strip():
                        continue
                    chunk = json.loads(line)
                    if chunk.get("error"):
                        yield _error(500, chunk["error"])
                        return
                    msg = chunk.get("message") or {}
                    if msg.get("thinking"):
                        thinking += msg["thinking"]
                    if msg.get("content"):
                        text += msg["content"]
                        if stream:
                            yield LlmResponse(
                                content=types.Content(role="model", parts=[types.Part(text=msg["content"])]),
                                partial=True,
                            )
                    raw_calls.extend(msg.get("tool_calls") or [])
                    if chunk.get("done"):
                        final = chunk
        except httpx.ConnectError:
            yield _error(503, f"Ollama ist unter {self.base_url} nicht erreichbar. Läuft Ollama?")
            return

        calls: list[repair.ParsedCall] = []
        for rc in raw_calls:
            fn = rc.get("function") or {}
            name = repair.resolve_name(fn.get("name"), known) or fn.get("name") or ""
            args = repair.parse_args(fn.get("arguments"))
            if args is None:
                repair.STATS["args_unrepairable"] += 1
                args = {"_unparseable_arguments": str(fn.get("arguments"))}
            calls.append(repair.ParsedCall(name, args))
        if not calls:
            extracted, text = repair.extract_text_calls(text, known)
            calls.extend(extracted)

        parts: list[types.Part] = []
        if thinking:
            parts.append(types.Part(text=thinking, thought=True))
        if text:
            parts.append(types.Part(text=text))
        for c in calls:
            args = repair.coerce_types(c.args, schemas.get(c.name))
            parts.append(
                types.Part(
                    function_call=types.FunctionCall(
                        id=f"call_{uuid.uuid4().hex[:12]}", name=c.name, args=args
                    )
                )
            )
        if not parts:
            log.warning(
                "Leere Modellantwort: done_reason=%s eval_count=%s thinking=%d Zeichen, Nachrichten=%d",
                final.get("done_reason"),
                final.get("eval_count"),
                len(thinking),
                len(body["messages"]),
            )
            parts.append(types.Part(text=""))
        repair.STATS["responses"] += 1
        if calls:
            repair.STATS["responses_with_calls"] += 1
        prompt_tokens = final.get("prompt_eval_count") or 0
        out_tokens = final.get("eval_count") or 0
        yield LlmResponse(
            content=types.Content(role="model", parts=parts),
            partial=False,
            turn_complete=True,
            finish_reason=types.FinishReason.MAX_TOKENS
            if final.get("done_reason") == "length"
            else types.FinishReason.STOP,
            usage_metadata=types.GenerateContentResponseUsageMetadata(
                prompt_token_count=prompt_tokens,
                candidates_token_count=out_tokens,
                total_token_count=prompt_tokens + out_tokens,
            ),
            custom_metadata={
                "load_ms": round((final.get("load_duration") or 0) / 1e6),
                "eval_ms": round((final.get("eval_duration") or 0) / 1e6),
            },
        )


def _error(status: int, detail: str) -> LlmResponse:
    msg = detail
    with contextlib.suppress(json.JSONDecodeError, AttributeError):
        msg = json.loads(detail).get("error", detail)
    if "not found" in str(msg) and "model" in str(msg):
        msg = f"{msg}. Das Modell ist nicht heruntergeladen (ollama pull …)."
    return LlmResponse(error_code=f"OLLAMA_{status}", error_message=str(msg), turn_complete=True)
