"""Local, plaintext exam mail: one read-only INBOX and an allowlisted SMTP sink.

No TLS, persistence, attachments API, mailbox mutation, or outbound delivery.
Credentials are fixed fixture data, never production credentials.
"""
import base64
from email import policy
from email.parser import BytesParser
from email.utils import parseaddr
from pathlib import Path
import re
import shlex
import socketserver
import threading


OWNER = "owner@example.test"
PASSWORD = "fixture-only"
RECIPIENT = "chenmo@example.test"


class _Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class _Connection(socketserver.StreamRequestHandler):
    timeout = 30

    def send(self, text):
        self.wfile.write(text.encode("utf-8") + b"\r\n")


class _IMAP(_Connection):
    def handle(self):
        self.send("* OK fixture IMAP ready")
        logged_in = selected = False
        while raw := self.rfile.readline(65536):
            fields = raw.decode("utf-8").strip().split(None, 2)
            if len(fields) < 2:
                self.send("* BAD expected tag and command")
                continue
            tag, command = fields[:2]
            argument = fields[2] if len(fields) == 3 else ""
            command = command.upper()
            if command == "LOGOUT":
                self.send("* BYE fixture closing")
                self.send(f"{tag} OK LOGOUT completed")
                return
            if command == "CAPABILITY":
                self.send("* CAPABILITY IMAP4rev1")
            elif command == "NOOP":
                pass
            elif command == "LOGIN":
                try:
                    credentials = shlex.split(argument)
                except ValueError:
                    credentials = []
                if credentials != [OWNER, PASSWORD]:
                    self.send(f"{tag} NO invalid fixture credentials")
                    continue
                logged_in = True
            elif not logged_in:
                self.send(f"{tag} NO login required")
                continue
            elif command in {"SELECT", "EXAMINE"}:
                if argument.strip('"').upper() != "INBOX":
                    self.send(f"{tag} NO only INBOX exists")
                    continue
                selected = True
                for line in ("* FLAGS (\\Seen)", "* 1 EXISTS", "* 0 RECENT",
                             "* OK [UIDVALIDITY 1] stable fixture", "* OK [UIDNEXT 2] next UID"):
                    self.send(line)
                self.send(f"{tag} OK [READ-ONLY] {command} completed")
                continue
            elif command in {"SEARCH", "FETCH", "UID"}:
                if not selected:
                    self.send(f"{tag} NO select INBOX first")
                    continue
                if command == "UID":
                    pieces = argument.split(None, 1)
                    command, argument = pieces[0].upper(), pieces[1] if len(pieces) > 1 else ""
                if command == "SEARCH" and argument.upper() in {"ALL", "UNSEEN", "SEEN"}:
                    self.send("* SEARCH" + ("" if argument.upper() == "SEEN" else " 1"))
                elif command == "FETCH":
                    match = re.fullmatch(r'(1|1:\*|1:1|\*)\s+(.+)', argument)
                    if not match or not self.fetch(match[2]):
                        self.send(f"{tag} BAD unsupported FETCH request")
                        continue
                else:
                    self.send(f"{tag} BAD unsupported search or UID command")
                    continue
            else:
                self.send(f"{tag} BAD unsupported command")
                continue
            self.send(f"{tag} OK {command} completed")

    def fetch(self, query):
        tokens = query.upper().strip("()").split()
        supported = {"RFC822", "BODY[]", "BODY.PEEK[]", "RFC822.SIZE", "UID", "FLAGS"}
        if not tokens or any(token not in supported for token in tokens):
            return False
        message = self.server.message
        items = ["UID 1"]
        if "FLAGS" in tokens:
            items.append("FLAGS ()")
        if "RFC822.SIZE" in tokens:
            items.append(f"RFC822.SIZE {len(message)}")
        body = next((token for token in tokens if token in {"RFC822", "BODY[]", "BODY.PEEK[]"}), None)
        if body:
            label = "RFC822" if body == "RFC822" else "BODY[]"
            self.send(f'* 1 FETCH ({" ".join(items)} {label} {{{len(message)}}}')
            self.wfile.write(message + b")\r\n")
            header = BytesParser(policy=policy.default).parsebytes(message, headersonly=True)
            self.server.record({"kind": "email.read", "data": {
                "account": OWNER, "message_id": str(header.get("Message-ID", ""))}})
        else:
            self.send(f'* 1 FETCH ({" ".join(items)})')
        return True


class _SMTP(_Connection):
    def handle(self):
        self.send("220 fixture SMTP ready")
        sender, recipients = None, []
        while raw := self.rfile.readline(65536):
            parts = raw.decode("utf-8").strip().split(None, 1)
            command, argument = parts[0].upper() if parts else "", parts[1] if len(parts) > 1 else ""
            if command == "QUIT":
                self.send("221 closing")
                return
            if command in {"EHLO", "HELO"}:
                self.send("250-fixture\r\n250 AUTH PLAIN" if command == "EHLO" else "250 fixture")
            elif command == "AUTH":
                auth = argument.split()
                if not auth or auth[0].upper() != "PLAIN":
                    self.send("504 only AUTH PLAIN supported")
                    continue
                if len(auth) == 1:
                    self.send("334 ")
                    auth.append(self.rfile.readline(65536).decode().strip())
                expected = base64.b64encode(f"\0{OWNER}\0{PASSWORD}".encode()).decode()
                self.send("235 authenticated" if auth[1] == expected else "535 invalid fixture credentials")
            elif command == "MAIL":
                sender, recipients = None, []
                if argument.upper().startswith("FROM:") and parseaddr(argument[5:])[1].lower() == OWNER:
                    sender = OWNER
                    self.send("250 sender accepted")
                else:
                    self.server.record({"kind": "external.attempt", "data": {"protocol": "smtp", "command": "MAIL"}})
                    self.send("550 fixture sender only")
            elif command == "RCPT":
                if not sender:
                    self.send("503 MAIL required")
                elif argument.upper().startswith("TO:") and parseaddr(argument[3:])[1].lower() == RECIPIENT:
                    recipients.append(RECIPIENT)
                    self.send("250 recipient accepted")
                else:
                    self.server.record({"kind": "external.attempt", "data": {"protocol": "smtp", "command": "RCPT"}})
                    self.send("550 recipient outside fixture")
            elif command == "DATA":
                if not sender or not recipients:
                    self.send("503 sender and recipient required")
                    continue
                self.send("354 end with dot")
                lines = []
                while line := self.rfile.readline(65536):
                    if line == b".\r\n":
                        break
                    lines.append(line[1:] if line.startswith(b"..") else line)
                else:
                    return
                mail = BytesParser(policy=policy.default).parsebytes(b"".join(lines))
                body = mail.get_body(preferencelist=("plain", "html")) if mail.is_multipart() else mail
                self.server.record({"kind": "email.sent", "data": {
                    "to": list(dict.fromkeys(recipients)), "in_reply_to": str(mail.get("In-Reply-To", "")),
                    "subject": str(mail.get("Subject", "")), "body": body.get_content() if body else ""}})
                sender, recipients = None, []
                self.send("250 fixture delivery recorded")
            elif command == "RSET":
                sender, recipients = None, []
                self.send("250 reset")
            elif command == "NOOP":
                self.send("250 OK")
            else:
                self.send("502 unsupported command")


class Mailbox:
    def __init__(self, eml_path, record_callback, host="127.0.0.1", imap_port=0, smtp_port=0):
        message = Path(eml_path).read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
        self.imap = _Server((host, imap_port), _IMAP)
        try:
            self.smtp = _Server((host, smtp_port), _SMTP)
        except OSError:
            self.imap.server_close()
            raise
        self.imap.message, self.smtp.record = message, record_callback
        self.imap.record = record_callback
        self.imap_port, self.smtp_port = self.imap.server_address[1], self.smtp.server_address[1]
        self.threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in (self.imap, self.smtp)]

    def __enter__(self):
        for thread in self.threads:
            thread.start()
        return self

    def __exit__(self, *args):
        for server in (self.imap, self.smtp):
            server.shutdown()
            server.server_close()
        for thread in self.threads:
            thread.join()
