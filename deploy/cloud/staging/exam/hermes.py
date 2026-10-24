"""Thin binding to Hermes' native runs API and read-only transcript database."""
import json
import re
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


# Native make_tool_result_message persists web/browser/MCP output inside untrusted-data delimiters for the model.
UNTRUSTED = re.compile(r'<untrusted_tool_result source="[^"\n]*">\n[^\n]*\n\n(.*)\n</untrusted_tool_result>', re.S)


def tool_result(content):
    """The tool's own result from its persisted transcript row."""
    match = UNTRUSTED.fullmatch(content) if isinstance(content, str) else None
    return match.group(1) if match else content


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Exam requests must not redirect")


def loopback_origin(value):
    url = urlsplit(value)
    if (url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port
            or url.username or url.password or url.path or url.query or url.fragment):
        raise ValueError("Use a direct numeric-loopback Hermes origin in the staging namespace")
    return value


def initialize_desktop(origin, key):
    """Prove the relay can execute a read-only tool on its connected Mac."""
    url = loopback_origin(origin) + "/internal/desktop/mcp"
    headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json",
               "Accept": "application/json, text/event-stream"}
    body = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-11-25", "capabilities": {},
        "clientInfo": {"name": "paios-staging-exam", "version": "1"}}}
    opener = build_opener(ProxyHandler({}), NoRedirect())
    session = None
    try:
        with opener.open(Request(url, json.dumps(body).encode(), headers), timeout=10) as response:
            session = response.headers.get("mcp-session-id")
            if response.headers.get_content_type() == "text/event-stream":
                reply = json.loads(next(line[5:] for line in response if line.startswith(b"data:")))
            else:
                reply = json.load(response)
        result = reply.get("result", {})
        if (reply.get("jsonrpc") != "2.0" or reply.get("id") != 1 or "error" in reply
                or result.get("serverInfo", {}).get("name") != "paios-desktop"
                or "tools" not in result.get("capabilities", {}) or not result.get("protocolVersion")):
            raise ValueError("Desktop MCP initialize did not return the desktop relay capabilities")
        if not session:
            raise ValueError("Desktop MCP initialize did not return a session")
        headers.update({"Mcp-Session-Id": session, "MCP-Protocol-Version": result["protocolVersion"]})
        notification = {"jsonrpc": "2.0", "method": "notifications/initialized"}
        with opener.open(Request(url, json.dumps(notification).encode(), headers), timeout=10):
            pass
        call = {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": {"name": "list_allowed_directories", "arguments": {}}}
        with opener.open(Request(url, json.dumps(call).encode(), headers), timeout=10) as response:
            if response.headers.get_content_type() == "text/event-stream":
                reply = json.loads(next(line[5:] for line in response if line.startswith(b"data:")))
            else:
                reply = json.load(response)
        tool = reply.get("result", {})
        if (reply.get("jsonrpc") != "2.0" or reply.get("id") != 2 or "error" in reply
                or tool.get("isError") or not isinstance(tool.get("structuredContent", {}).get("directories"), list)):
            code = tool.get("structuredContent", {}).get("error", {}).get("code")
            raise ValueError("Desktop MCP list_allowed_directories failed" + (": " + str(code) if code else ""))
        return {"serverInfo": result["serverInfo"], "protocolVersion": result["protocolVersion"],
                "capabilities": result["capabilities"], "list_allowed_directories": tool}
    finally:
        if session:
            with opener.open(Request(url, headers={**headers, "Mcp-Session-Id": session}, method="DELETE"), timeout=10):
                pass


class Hermes:
    def __init__(self, origin, key, database, timeout=900, poll=2,
                 gateway_origin=None, device_key=None):
        self.origin = loopback_origin(origin)
        self.key, self.database = key, Path(database)
        self.timeout, self.poll = timeout, poll
        self.opener = build_opener(ProxyHandler({}), NoRedirect())
        self.active_run = None
        self.pending_event = None
        self.gateway_origin = loopback_origin(gateway_origin) if gateway_origin else None
        self.device_key = device_key

    def request(self, path, body=None, *, idempotency=None, admission=False):
        headers = {"Authorization": "Bearer " + (self.device_key if admission else self.key), "Content-Type": "application/json"}
        if idempotency:
            headers["Idempotency-Key"] = idempotency
        request = Request((self.gateway_origin if admission else self.origin) + path,
                          None if body is None else json.dumps(body).encode(), headers)
        with self.opener.open(request, timeout=min(30, self.timeout)) as response:
            return json.load(response)

    def turn(self, session, prompt, event_id, *, deadline=None, admitted=None, on_status=None):
        if not self.gateway_origin or not self.device_key:
            raise ValueError("Use the staging paired-device admission authority; build jobs need its source reference")
        deadline = deadline or time.monotonic() + self.timeout
        accepted = self.request("/v1/prompts", {"event_id": event_id, "session_id": session, "text": prompt,
                                "captured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, admission=True)
        event = accepted["processed_event"]
        if event["origin"] != "explicit_user_prompt" or event["content"]["text"] != prompt:
            raise ValueError("Admission changed the owner request")
        self.pending_event = "/v1/events/" + quote(event["processed_event_id"], safe="")
        query = "?" + urlencode({"session_id": session})
        self.pending_event += query
        while not accepted["admission"].get("run_id"):
            if accepted["admission"]["state"] in {"failed", "cancelled", "expired"}:
                raise ValueError("Admission terminated before a native run was created")
            if time.monotonic() >= deadline:
                self.stop()
                raise TimeoutError("Admission deadline exceeded")
            time.sleep(self.poll)
            accepted = self.request(self.pending_event, admission=True)
        self.active_run = accepted["admission"]["run_id"]
        if admitted:
            admitted(accepted)
        status = {"status": "queued"}
        while status["status"] not in {"completed", "failed", "cancelled", "interrupted", "expired"}:
            if time.monotonic() >= deadline:
                self.stop()
                raise TimeoutError("Hermes run exceeded the task deadline; stop requested")
            time.sleep(self.poll)
            status = self.request("/v1/runs/" + quote(self.active_run, safe=""))
            if on_status:
                on_status(status)
        self.active_run = None
        self.pending_event = None
        if status.get("conversation_session_id", status.get("session_id")) != session:
            raise ValueError("Hermes returned a different session; do not mix evidence")
        status["transcript_sessions"] = self.session_scope(session, status["session_id"])
        return status

    def stop(self):
        if self.active_run:
            self.request("/v1/runs/" + quote(self.active_run, safe="") + "/stop", {})
        elif self.pending_event:
            path, query = self.pending_event.split("?", 1)
            self.request(path + "/cancel?" + query, {}, admission=True)

    def session_scope(self, conversation, transcript):
        with closing(sqlite3.connect(self.database.resolve().as_uri() + "?mode=ro", uri=True)) as db:
            rows = db.execute("WITH RECURSIVE scope(id) AS (SELECT id FROM sessions WHERE id IN (?,?) "
                "UNION SELECT s.id FROM sessions s JOIN scope ON s.parent_session_id=scope.id) SELECT id FROM scope",
                (conversation, transcript)).fetchall()
        if not rows:
            raise ValueError("Native session was not persisted")
        return [row[0] for row in rows]

    def trace(self, sessions, after=0):
        with closing(sqlite3.connect(self.database.resolve().as_uri() + "?mode=ro", uri=True)) as db:
            db.row_factory = sqlite3.Row
            marks = ",".join("?" for _ in sessions)
            rows = [dict(row) for row in db.execute(
                f"SELECT id,session_id,role,content,tool_call_id,tool_calls FROM messages "
                f"WHERE session_id IN ({marks}) AND id>? ORDER BY id", (*sessions, after))]
        calls, by_id = [], {}
        for row in rows:
            for entry in json.loads(row["tool_calls"] or "[]"):
                function = entry["function"]
                call = {"id": entry["id"], "session_id": row["session_id"], "tool": function["name"],
                        "args": json.loads(function["arguments"]), "result": None}
                calls.append(call)
                by_id[(row["session_id"], entry["id"])] = call
            if row["role"] == "tool" and (row["session_id"], row["tool_call_id"]) in by_id:
                by_id[(row["session_id"], row["tool_call_id"])]["result"] = tool_result(row["content"])
        return {"messages": rows, "tools": calls}

    def watermark(self):
        with closing(sqlite3.connect(self.database.resolve().as_uri() + "?mode=ro", uri=True)) as db:
            return db.execute("SELECT COALESCE(MAX(id),0) FROM messages").fetchone()[0]


def token_usage(turns):
    """Native terminal run counters describe that agent turn, not a dollar estimate."""
    fields = ("input_tokens", "output_tokens", "total_tokens", "cache_read_tokens", "cache_write_tokens")
    usage = {field: 0 for field in fields}
    for turn in turns:
        current = turn.get("usage")
        if not isinstance(current, dict) or any(type(current.get(k)) is not int or current[k] < 0 for k in fields):
            return None
        for field in fields:
            usage[field] += current[field]
    return usage
