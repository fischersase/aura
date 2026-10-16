"""Einstieg: `python -m aura_agent` spricht JSON-RPC über stdin/stdout.

stdout gehört allein dem Protokoll. Deshalb wird der echte stdout-Deskriptor
gleich zu Beginn gesichert und sys.stdout auf stderr umgelenkt; versehentliche
print()-Ausgaben von Bibliotheken landen so im Log statt im Protokoll.

`python -m aura_agent --selftest` prüft das gebündelte Paket ohne Modell.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import sys
import threading
import warnings

if sys.platform == "win32":
    with contextlib.suppress(Exception):
        import msvcrt

        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stderr.fileno(), os.O_BINARY)


def _pump_stdin(loop: asyncio.AbstractEventLoop, reader: asyncio.StreamReader) -> None:
    """Liest stdin in einem eigenen Thread. loop.connect_read_pipe geht unter Windows mit der
    von Electron geerbten Pipe nicht zuverlässig; der Thread funktioniert überall gleich."""
    stdin = sys.stdin.buffer
    while True:
        line = stdin.readline()
        if not line:
            loop.call_soon_threadsafe(reader.feed_eof)
            return
        loop.call_soon_threadsafe(reader.feed_data, line)


def _protocol_stdout():
    fd = os.dup(1)
    if sys.platform == "win32":
        with contextlib.suppress(Exception):
            import msvcrt

            msvcrt.setmode(fd, os.O_BINARY)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return os.fdopen(fd, "wb", buffering=0)


async def serve() -> None:
    from .rpc.peer import Peer
    from .runtime.server import AgentServer

    out = _protocol_stdout()
    lock = threading.Lock()

    def write(data: bytes) -> None:
        with lock:
            out.write(data)
            with contextlib.suppress(Exception):
                out.flush()

    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=64 * 1024 * 1024)
    threading.Thread(target=_pump_stdin, args=(loop, reader), name="stdin", daemon=True).start()
    peer = Peer(reader, write)
    server = AgentServer(peer)
    serve_task = asyncio.create_task(peer.serve())
    await peer.closed.wait()
    serve_task.cancel()
    if server.controller:
        await server.controller.cancel_all()


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("AURA_AGENT_LOG", "INFO"),
        stream=sys.stderr,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    warnings.filterwarnings("ignore", category=UserWarning, module="google.adk")
    # Lokale Modelle liefern bei Prompt-Cache-Treffern keine Tokenzahlen; ADK warnt dann bei jedem Aufruf.
    logging.getLogger("google_adk.google.adk.telemetry").setLevel(logging.ERROR)
    if "--selftest" in sys.argv:
        from .selftest import run

        return asyncio.run(run())
    if "--version" in sys.argv:
        from . import __version__

        print(__version__)
        return 0
    asyncio.run(serve())
    return 0


if __name__ == "__main__":
    sys.exit(main())
