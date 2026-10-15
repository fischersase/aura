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


class FakeImap:
    """Gmail-like IMAP: INBOX has nothing from NVIDIA, the archived NVIDIA mail is only in All Mail."""

    capabilities = ("IMAP4REV1", "X-GM-EXT-1")

    def __init__(self):
        self.selected = None
        self.searched = []

    def list(self):
        return "OK", [
            b'(\\HasNoChildren) "/" "INBOX"',
            b'(\\All \\HasNoChildren) "/" "[Gmail]/Alle Nachrichten"',
        ]

    def select(self, mailbox, readonly=False):
        self.selected = mailbox
        return "OK", [b"1"]

    def uid(self, cmd, *args):
        if cmd == "SEARCH":
            self.searched.append((self.selected, args))
            found = self.selected == '"[Gmail]/Alle Nachrichten"' and "nvidia" in " ".join(args).lower()
            return "OK", [b"7 42" if found else b""]
        if cmd == "FETCH":
            assert self.selected == '"[Gmail]/Alle Nachrichten"', "read must use the folder of the search"
            return "OK", [(b"42 (BODY[] {1}", _raw())]
        raise AssertionError(cmd)

    def logout(self):
        return "BYE", []


def test_gmail_search_and_read_use_all_mail_including_archived(monkeypatch):
    fake = FakeImap()
    box = mail.Mailbox(mail.Account("a@gmail.com", "x", "imap.gmail.com", 993, "smtp.gmail.com", 465, True))
    monkeypatch.setattr(box, "_imap", lambda: fake)
    hits = box.search("", "nvidia", "", False, 0, 10, "")
    assert [h["id"] for h in hits] == ["42", "7"], "newest first"
    assert hits[0]["ordner"] == "[Gmail]/Alle Nachrichten"
    assert "SINCE" not in fake.searched[0][1], "no time limit by default"
    assert box.read("42", "")["betreff"] == "Neuer Treiber verfügbar"


async def test_empty_search_says_so():
    class Empty(FakeBox):
        def search(self, *a):
            return []

    server = mail.build_server(Empty())
    assert "Keine Mails gefunden für nvidia" in str(
        await server.call_tool("mail_search", {"sender": "nvidia"})
    )


def test_email_domain_typo_normalization():
    addr = mail.normalize_email_address("fischer.sase@gmailcom")
    assert addr == "fischer.sase@gmail.com"
    acc = mail.Account.from_env(
        {"MAIL_ADDRESS": "fischer.sase@gmailcom", "MAIL_PASSWORD": "abcd efgh ijkl mnop"}
    )
    assert acc.address == "fischer.sase@gmail.com"
    assert acc.imap_host == "imap.gmail.com"


async def test_google_workspace_connector_tools_and_ical():
    from datetime import UTC, datetime, timedelta

    from aura_agent.connectors import google_workspace as gw

    sample_ics = (
        "BEGIN:VCALENDAR\r\n"
        "BEGIN:VEVENT\r\n"
        "UID:evt-1\r\n"
        "DTSTART:20261020T090000Z\r\n"
        "DTEND:20261020T100000Z\r\n"
        "SUMMARY:NVIDIA Technical Interview\r\n"
        "LOCATION:Microsoft Teams\r\n"
        "DESCRIPTION:Interview mit dem Team\r\n"
        "END:VEVENT\r\n"
        "END:VCALENDAR\r\n"
    )
    now = datetime(2026, 10, 15, tzinfo=UTC)
    events = gw.parse_ics_events(
        sample_ics,
        start_from=now - timedelta(days=1),
        end_until=now + timedelta(days=30),
        query="nvidia",
    )
    assert len(events) == 1
    assert events[0]["titel"] == "NVIDIA Technical Interview"
    assert events[0]["ort"] == "Microsoft Teams"

    class FakeWorkspace(gw.GoogleWorkspaceClient):
        def __init__(self):
            super().__init__(gw.WorkspaceAccount(address="anna@gmail.com", app_password="secret"))
            self._box = FakeBox()

        def gmail_search(
            self, query="", sender="", subject="", unread_only=False, days=0, limit=10, folder=""
        ):
            return self._box.search(query, sender, subject, unread_only, days, limit, folder)

        def gmail_read(self, msg_id, folder=""):
            return self._box.read(msg_id, folder)

        def gmail_send(self, to, subject, body, cc=""):
            return self._box.send(to, subject, body, cc)

        def calendar_events(self, days=14, query="", include_past_days=0, limit=20):
            return events

        def calendar_create(self, title, start, end="", description="", location=""):
            return {"angelegt": True, "titel": title, "start": start, "ende": end}

        def drive_search(self, query="", file_type="", limit=15):
            return [{"id": "doc-1", "name": f"Report {query}", "typ": "application/vnd.google-apps.document"}]

        def drive_read(self, file_id):
            return {"id": file_id, "name": "Report", "text": "Quartalszahlen."}

    ws_server = gw.build_server(FakeWorkspace())
    ws_tools = {t.name: t for t in await ws_server.list_tools()}
    assert set(ws_tools) == {
        "workspace_gmail_search",
        "workspace_gmail_read",
        "workspace_gmail_send",
        "workspace_calendar_events",
        "workspace_calendar_create",
        "workspace_drive_search",
        "workspace_drive_read",
    }
    assert ws_tools["workspace_gmail_search"].annotations.read_only_hint is True
    assert ws_tools["workspace_calendar_events"].annotations.read_only_hint is True
    assert ws_tools["workspace_drive_read"].annotations.read_only_hint is True
    assert ws_tools["workspace_gmail_send"].annotations.read_only_hint is False
    assert ws_tools["workspace_calendar_create"].annotations.read_only_hint is False

    res_mail = await ws_server.call_tool("workspace_gmail_search", {"sender": "nvidia"})
    assert "Neuer Treiber" in str(res_mail)
    res_cal = await ws_server.call_tool("workspace_calendar_events", {"query": "nvidia"})
    assert "NVIDIA Technical Interview" in str(res_cal)
    res_drive = await ws_server.call_tool("workspace_drive_read", {"file_id": "doc-1"})
    assert "Quartalszahlen" in str(res_drive)
