"""Fake MCP servers for evals (AURA-134): a mailbox with the same tools as Aura's mail connector, and a GitHub-like
server that must NOT be used for mail questions. Run: python fake_servers.py mail|github
"""

from __future__ import annotations

import sys
from email.message import EmailMessage
from typing import Any

from aura_agent.connectors import mail

MAILS = [
    (
        "101",
        "NVIDIA <news@nvidia.com>",
        "Einladung zur GTC Europe",
        "Mon, 03 Aug 2026 09:00:00 +0200",
        "Die GTC Europe findet im Oktober statt.",
    ),
    (
        "205",
        "Paketdienst <info@paket.example>",
        "Ihre Sendung ist unterwegs",
        "Fri, 09 Oct 2026 08:10:00 +0200",
        "Zustellung morgen.",
    ),
    (
        "230",
        "NVIDIA GeForce <geforce@nvidia.com>",
        "GeForce-Treiber 600.12 ist da",
        "Sat, 10 Oct 2026 18:30:00 +0200",
        "Der neue Game-Ready-Treiber 600.12 bringt DLSS 5. Dein Bestätigungscode lautet 482913.",
    ),
    (
        "240",
        "Anna <anna@example.org>",
        "Abendessen am Freitag?",
        "Mon, 12 Oct 2026 19:00:00 +0200",
        "Hast du Zeit?",
    ),
]


def _raw(uid: str) -> bytes:
    _, frm, subj, date, body = next(m for m in MAILS if m[0] == uid)
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"], msg["Date"] = frm, "nutzer@gmail.com", subj, date
    msg.set_content(body)
    return msg.as_bytes()


class Box:
    def search(
        self, query: str, sender: str, subject: str, unread_only: bool, days: int, limit: int, folder: str
    ) -> list[dict[str, Any]]:
        terms = [t.lower() for t in (sender, subject, query.replace("from:", "")) if t]
        hits = [m for m in MAILS if all(t in (m[1] + " " + m[2]).lower() for t in terms)]
        return [{**mail.message_summary(m[0], _raw(m[0])), "ordner": "INBOX"} for m in reversed(hits)][:limit]

    def read(self, uid: str, folder: str) -> dict[str, Any]:
        return mail.message_full(uid, _raw(uid))

    def send(self, to: str, subject: str, body: str, cc: str = "") -> dict[str, Any]:
        return {"gesendet": True, "an": [to]}


def github() -> Any:
    from mcp.server.mcpserver import MCPServer

    server = MCPServer("github")

    @server.tool()
    def get_me() -> dict[str, str]:
        """Details of the authenticated GitHub user."""
        return {"login": "fischersase"}

    @server.tool()
    def search_issues(query: str) -> dict[str, Any]:
        """Search GitHub issues and pull requests."""
        return {"items": []}

    @server.tool()
    def list_notifications() -> dict[str, Any]:
        """GitHub notifications of the user."""
        return {"items": [{"title": "Review requested: aura#64"}]}

    return server


if __name__ == "__main__":
    (mail.build_server(Box()) if sys.argv[1] == "mail" else github()).run("stdio")
