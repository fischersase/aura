"""Kleiner MCP-Server für Tests (stdio): Notizen lesen (nur lesend), anlegen (ändernd), ping (für autoApprove)."""

import sys
from pathlib import Path

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

NOTES = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("notes.txt")
mcp = MCPServer("notes")


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
def read_notes() -> str:
    """Liest alle Notizen."""
    return NOTES.read_text(encoding="utf-8") if NOTES.exists() else ""


@mcp.tool()
def add_note(text: str) -> str:
    """Legt eine Notiz an."""
    with NOTES.open("a", encoding="utf-8") as f:
        f.write(text + "\n")
    return "ok"


@mcp.tool()
def ping() -> str:
    """Antwortet mit pong."""
    return "pong"


if __name__ == "__main__":
    mcp.run()
