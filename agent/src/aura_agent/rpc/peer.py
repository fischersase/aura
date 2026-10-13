"""JSON-RPC 2.0 über eine Zeilen-Verbindung, in beide Richtungen.

Jede Nachricht ist eine JSON-Zeile. Beide Seiten können Anfragen (mit id),
Antworten und Benachrichtigungen (ohne id) schicken. Electron fragt den Agenten
(task.start …), der Agent fragt Electron (host.approve, host.screenshot …).
Antworten werden nur gegen die eigenen offenen Anfragen abgeglichen, daher
stören sich die id-Räume beider Seiten nicht.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any, cast

log = logging.getLogger(__name__)

PROTOCOL_VERSION = 1

# JSON-RPC-Fehlercodes
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

Handler = Callable[[dict[str, Any]], Awaitable[Any]]


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


def _rpc_error(error: Any) -> RpcError:
    """RpcError from the error member of a response; tolerates a missing or non-object value."""
    if isinstance(error, dict):
        e = cast("dict[str, Any]", error)
        code = e.get("code")
        return RpcError(
            code if isinstance(code, int) else INTERNAL_ERROR, str(e.get("message", "Fehler")), e.get("data")
        )
    return RpcError(INTERNAL_ERROR, str(error or "Fehler"))


class Peer:
    def __init__(self, reader: asyncio.StreamReader, write: Callable[[bytes], None]) -> None:
        self._reader = reader
        self._write = write
        self._ids = itertools.count(1)
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._handlers: dict[str, Handler] = {}
        self._tasks: set[asyncio.Task[Any]] = set()
        self.closed = asyncio.Event()

    def on(self, method: str, handler: Handler) -> None:
        self._handlers[method] = handler

    def _send(self, msg: dict[str, Any]) -> None:
        msg["jsonrpc"] = "2.0"
        self._write((json.dumps(msg, ensure_ascii=False, separators=(",", ":"), default=str) + "\n").encode())

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        if not self.closed.is_set():
            self._send({"method": method, "params": params or {}})

    async def request(
        self, method: str, params: dict[str, Any] | None = None, timeout: float | None = None
    ) -> Any:
        if self.closed.is_set():
            raise RpcError(INTERNAL_ERROR, "Verbindung geschlossen")
        rid = next(self._ids)
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        self._send({"id": rid, "method": method, "params": params or {}})
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(rid, None)

    async def serve(self) -> None:
        """Liest bis zum Ende der Verbindung. Danach sind offene Anfragen gescheitert."""
        try:
            while True:
                line = await self._reader.readline()
                if not line:
                    break
                if line.strip():
                    self._dispatch(line)
        finally:
            self.closed.set()
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(RpcError(INTERNAL_ERROR, "Verbindung geschlossen"))
            for t in list(self._tasks):
                t.cancel()

    def _dispatch(self, line: bytes) -> None:
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            self._send({"id": None, "error": {"code": PARSE_ERROR, "message": "Ungültiges JSON"}})
            return
        if not isinstance(msg, dict):
            self._send(
                {"id": None, "error": {"code": INVALID_REQUEST, "message": "Nachricht muss ein Objekt sein"}}
            )
            return
        message = cast("dict[str, Any]", msg)
        if "method" in message:
            task = asyncio.create_task(self._handle(message))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
        elif isinstance(message.get("id"), int):
            # Responses to our own requests; anything malformed is ignored instead of stopping the reader.
            fut = self._pending.get(message["id"])
            if fut and not fut.done():
                if "error" in message:
                    fut.set_exception(_rpc_error(message["error"]))
                else:
                    fut.set_result(message.get("result"))

    async def _handle(self, msg: dict[str, Any]) -> None:
        rid = msg.get("id")
        handler = self._handlers.get(msg["method"])
        try:
            if handler is None:
                raise RpcError(METHOD_NOT_FOUND, f"Unbekannte Methode {msg['method']}")
            params: Any = msg.get("params") or {}
            if not isinstance(params, dict):
                raise RpcError(INVALID_PARAMS, "params muss ein Objekt sein")
            result = await handler(cast("dict[str, Any]", params))
            if rid is not None:
                self._send({"id": rid, "result": result if result is not None else {}})
        except RpcError as e:
            if rid is not None:
                self._send({"id": rid, "error": {"code": e.code, "message": e.message, "data": e.data}})
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.exception("Fehler in %s", msg.get("method"))
            if rid is not None:
                self._send(
                    {"id": rid, "error": {"code": INTERNAL_ERROR, "message": str(e) or type(e).__name__}}
                )
