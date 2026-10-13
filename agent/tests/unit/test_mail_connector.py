"""Aura's mail connector (connectors/mail.py, AURA-98): filter, search criteria, parsing, presets, MCP tools."""

from email.message import EmailMessage

import pytest

from aura_agent.connectors import mail


def test_one_time_codes_and_login_links_are_removed():
    text = (
        "Dein Bestätigungscode lautet 482913. Oder klicke https://accounts.example.com/reset?token=abc123 "
        "123456 ist dein Code für Login. Bestellung 4711 ist versandt, Treffen um 1530 bleibt."
    )
    out = mail.scrub(text)
    assert "482913" not in out and "123456" not in out
    assert "token=abc123" not in out
    assert out.count("[entfernt: Einmalcode]") == 2
    assert "[entfernt: Login-Link]" in out
    assert "Bestellung 4711" in out, "ordinary numbers stay"


def test_search_criteria_are_quoted():
    crit = mail.search_criteria('nvidia" OR ALL', "Treiber", "", True, 7)
    assert crit[0] == "SINCE"
    assert crit[2:4] == ["FROM", '"nvidia OR ALL"']
    assert crit[4:6] == ["SUBJECT", '"Treiber"']
    assert crit[-1] == "UNSEEN"
    assert mail.search_criteria("", "", "", False, 0) == ["ALL"]


def _raw(html=False):
    m = EmailMessage()
    m["From"] = "NVIDIA <news@nvidia.com>"
    m["To"] = "anna@gmail.com"
    m["Subject"] = "Neuer Treiber verfügbar"
    m["Date"] = "Mon, 12 Oct 2026 18:30:00 +0200"
    if html:
        m.set_content(
            "<html><body><h1>Treiber 600.1</h1><p>Code: 991234</p><script>x()</script></body></html>",
            subtype="html",
        )
    else:
        m.set_content("Der Treiber 600.1 ist da.\nIhr Sicherheitscode 991234")
    m.add_attachment(b"%PDF", maintype="application", subtype="pdf", filename="notes.pdf")
    return m.as_bytes()


@pytest.mark.parametrize("html", [False, True])
def test_messages_are_parsed_and_scrubbed(html):
    s = mail.message_summary("42", _raw(html))
    assert s["von"] == "NVIDIA <news@nvidia.com>" and s["betreff"] == "Neuer Treiber verfügbar"
    assert s["datum"] == "2026-10-12 18:30"
    full = mail.message_full("42", _raw(html))
    assert "Treiber 600.1" in full["text"] and "991234" not in full["text"]
    assert "x()" not in full["text"]
    assert full["anhaenge"] == ["notes.pdf"]


def test_provider_presets_and_missing_credentials():
    acc = mail.Account.from_env({"MAIL_ADDRESS": "anna@gmail.com", "MAIL_PASSWORD": "abcd efgh ijkl mnop"})
    assert (acc.imap_host, acc.smtp_host, acc.smtp_port, acc.smtp_ssl) == (
        "imap.gmail.com",
        "smtp.gmail.com",
        465,
        True,
    )
    assert acc.password == "abcdefghijklmnop", "spaces from Google's display are removed"
    web = mail.Account.from_env({"MAIL_ADDRESS": "a@web.de", "MAIL_PASSWORD": "x"})
    assert (web.smtp_port, web.smtp_ssl) == (587, False)
    with pytest.raises(RuntimeError, match="App-Passwort fehlt"):
        mail.Account.from_env({"MAIL_ADDRESS": "a@gmail.com"})
    with pytest.raises(RuntimeError, match="Unbekannter Mail-Anbieter"):
        mail.Account.from_env({"MAIL_ADDRESS": "a@firma.example", "MAIL_PASSWORD": "x"})


class FakeBox:
    def __init__(self):
        self.sent = []

    def search(self, query, sender, subject, unread_only, days, limit, folder):
        return [mail.message_summary("42", _raw())] if "nvidia" in (sender + query).lower() else []

    def read(self, uid, folder):
        return mail.message_full(uid, _raw())

    def send(self, to, subject, body, cc=""):
        self.sent.append((to, subject))
        return {"gesendet": True}


async def test_mcp_tools_read_only_hints_and_results():
    server = mail.build_server(FakeBox())
    tools = {t.name: t for t in await server.list_tools()}
    assert set(tools) == {"mail_search", "mail_read", "mail_send"}
    assert tools["mail_search"].annotations.read_only_hint is True
    assert tools["mail_send"].annotations.read_only_hint is False
    res = await server.call_tool("mail_search", {"sender": "nvidia"})
    assert "Neuer Treiber" in str(res)
    assert "991234" not in str(await server.call_tool("mail_read", {"id": "42"}))
