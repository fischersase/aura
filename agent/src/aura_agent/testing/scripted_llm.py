"""Ein Modell mit festem Drehbuch, für Tests ohne echtes LLM.

Jeder Schritt ist entweder Text oder eine Liste von Werkzeugaufrufen. Das
Modell merkt sich jede Anfrage, damit Tests prüfen können, was das Modell zu
sehen bekam (z. B. Ablehnungen, gekürzte Ausgaben, angehefteten Kontext).
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator, Callable
from dataclasses import dataclass, field
from typing import Any

from google.adk.models._capabilities import LlmCapabilities
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from pydantic import PrivateAttr


@dataclass
class Call:
  name: str
  args: dict[str, Any] = field(default_factory=dict)


Step = str | list[Call] | Callable[[LlmRequest], "str | list[Call]"]


class ScriptedLlm(BaseLlm):
  model: str = "scripted"
  _steps: list[Step] = PrivateAttr(default_factory=list)
  _requests: list[LlmRequest] = PrivateAttr(default_factory=list)
  _fallback: str = PrivateAttr(default="(Drehbuch zu Ende)")

  def __init__(self, steps: list[Step], fallback: str = "(Drehbuch zu Ende)", **kw: Any) -> None:
    super().__init__(**kw)
    self._steps = list(steps)
    self._fallback = fallback

  @property
  def capabilities(self) -> LlmCapabilities:
    return LlmCapabilities(output_schema_and_tools=False)

  @property
  def requests(self) -> list[LlmRequest]:
    return self._requests

  async def generate_content_async(
      self, llm_request: LlmRequest, stream: bool = False
  ) -> AsyncGenerator[LlmResponse, None]:
    self._requests.append(llm_request.model_copy(deep=True))
    step: Step = self._steps.pop(0) if self._steps else self._fallback
    if callable(step):
      step = step(llm_request)
    if isinstance(step, str):
      parts = [types.Part(text=step)]
    else:
      parts = [
          types.Part(function_call=types.FunctionCall(id=f"call_{uuid.uuid4().hex[:8]}", name=c.name, args=c.args))
          for c in step
      ]
    yield LlmResponse(content=types.Content(role="model", parts=parts), partial=False, turn_complete=True)


def tool_responses(req: LlmRequest) -> list[types.FunctionResponse]:
  """Alle Werkzeugantworten, die das Modell in dieser Anfrage sieht."""
  return [p.function_response for c in req.contents for p in c.parts or [] if p.function_response]
