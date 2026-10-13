"""Stand-in model when the chosen provider is not set up yet (e.g. Gemini without a key).

The agent still starts, so everything that needs no model keeps working: the memory page in the Zentrale, the
system check, forgetting deleted chats (AURA-108). A task fails with the configuration message instead.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator

from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse


class ModelNotConfiguredError(RuntimeError):
    """The provider chosen in the settings cannot be used yet; the message says what is missing."""


class UnconfiguredLlm(BaseLlm):
    reason: str

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        raise ModelNotConfiguredError(self.reason)
        yield  # pragma: no cover - makes this an async generator like every other model
