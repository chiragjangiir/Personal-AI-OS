"""Deterministic HTTP/SQLite Hermes stand-in for CI; never measures agent capability."""
import json
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

class FakeHermes:
    def __init__(self, root, fixture_root):
        self.root, self.fixtures = Path(root), Path(fixture_root)
        self.home = self.root / "home"
        self.registry = self.home / "skills/workshop"
        self.registry.mkdir(parents=True)
        self.log = self.root / "observer.jsonl"
        self.log.touch()
        self.database = self.home / "state.db"
        with sqlite3.connect(self.database) as db:
            db.executescript("""CREATE TABLE sessions(id TEXT PRIMARY KEY,parent_session_id TEXT);
                CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,tool_call_id TEXT,tool_calls TEXT);
                CREATE TABLE session_model_usage(session_id TEXT,model TEXT,billing_provider TEXT,billing_base_url TEXT,
                    billing_mode TEXT,task TEXT,api_call_count INTEGER,input_tokens INTEGER,output_tokens INTEGER,
                    cache_read_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER,
                    estimated_cost_usd REAL,actual_cost_usd REAL,
                    PRIMARY KEY(session_id,model,billing_provider,billing_base_url,billing_mode,task));""")
        self.runs, self.pending, self.requests, self.stops = {}, {}, [], []
        self.fault = None
        self.send_scopes = set()
        self.desktop_initialized = False
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def respond(self, body, code=200):
                data = json.dumps(body, ensure_ascii=False).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                if self.headers.get("Authorization") not in {"Bearer fixture-api", "Bearer fixture-device"}:
                    self.respond({"error": "unauthorized"}, 401)
                    return
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                fixture.requests.append((self.path, body))
                if self.path == "/internal/desktop/mcp":
                    if fixture.fault == "desktop_401":
                        self.respond({"error_code": "SOURCE_HOST_CREDENTIAL_REQUIRED"}, 401)
                    elif body["method"] == "initialize":
                        fixture.desktop_initialized = False
                        reply = {"jsonrpc": "2.0", "id": body["id"], "result": {
                            "protocolVersion": "2025-11-25", "serverInfo": {"name": "paios-desktop", "version": "1"},
                            "capabilities": {"tools": {"listChanged": False}}}}
                        self.send_response(200)
                        self.send_header("Content-Type", "text/event-stream")
                        self.send_header("Mcp-Session-Id", "fixture-desktop")
                        self.end_headers()
                        self.wfile.write(b"data: " + json.dumps(reply).encode() + b"\n\n")
                    elif (self.headers.get("Mcp-Session-Id") != "fixture-desktop"
                            or self.headers.get("MCP-Protocol-Version") != "2025-11-25"):
                        self.respond({"error": "Invalid desktop session or protocol"}, 400)
                    elif body["method"] == "notifications/initialized":
                        fixture.desktop_initialized = True
                        self.send_response(202)
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                    elif (fixture.desktop_initialized and body["method"] == "tools/call"
                            and body["params"] == {"name": "list_allowed_directories", "arguments": {}}):
                        structured = {"directories": []}
                        if fixture.fault == "desktop_offline":
                            structured = {"error": {"code": "DESKTOP_OFFLINE", "retryable": True}}
                        elif fixture.fault == "desktop_missing_result":
                            structured = {}
                        self.respond({"jsonrpc": "2.0", "id": body["id"], "result": {
                            "isError": fixture.fault == "desktop_offline", "structuredContent": structured,
                            "content": [{"type": "text", "text": json.dumps(structured)}]}})
                    else:
                        self.respond({"error": "Unexpected desktop MCP request"}, 400)
                elif self.path == "/_exam/watch-stage":
                    from fake_watch import stage
                    self.respond(stage(fixture, body))
                elif self.path == "/v1/prompts":
                    run_id = "run-" + str(len(fixture.pending))
                    event = {"processed_event_id": body["event_id"], "origin": "explicit_user_prompt", "content": {"text": body["text"]}}
                    value = {"processed_event": event, "admission": {"state": "pending"}}
                    fixture.pending[body["event_id"]] = (run_id, body, value)
                    self.respond(value, 202)
                else:
                    fixture.stops.append(self.path)
                    self.respond({"status": "cancelled"}, 202)

            def do_DELETE(self):
                fixture.requests.append((self.path, {"session": self.headers.get("Mcp-Session-Id")}))
                self.respond({}, 200)

            def do_GET(self):
                if self.path == "/health":
                    self.respond({"fake_hermes": True})
                elif self.path.startswith("/v1/events/"):
                    event_id = self.path.split("/v1/events/", 1)[1].split("?", 1)[0]
                    run_id, body, value = fixture.pending[event_id]
                    fixture.runs[run_id] = body
                    self.respond({**value, "admission": {"state": "accepted", "run_id": run_id}})
                elif self.path.startswith("/v1/runs/"):
                    run_id = self.path.rsplit("/", 1)[-1]
                    body = fixture.runs[run_id]
                    if "output" not in body:
                        fixture.execute(body, run_id)
                    self.respond(body)
                else:
                    self.respond({"error": "unknown endpoint"}, 404)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    @property
    def origin(self):
        return "http://127.0.0.1:" + str(self.server.server_port)

    from fake_tasks import execute
