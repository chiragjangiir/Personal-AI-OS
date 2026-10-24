"""Read-only flight/parcel fixtures; the runner alone controls the schema fault."""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


class Fixtures:
    def __init__(self, host="127.0.0.1", port=0):
        self.phase = "v1"
        self.events = []
        self.task = ""
        self.session = ""
        self.stage = "initial"
        self.watch_target = False
        self.watch_departure_at = ""
        self.lock = threading.Lock()
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                url = urlsplit(self.path)
                query = parse_qs(url.query)
                code = 200
                if url.path in {"/watch/parcel", "/watch/traffic"}:
                    name = url.path.rsplit("/", 1)[-1]
                    body = {"status": (("arrived" if fixture.watch_target else "pending") if name == "parcel"
                                       else ("congested" if fixture.watch_target else "clear")),
                            "departure_at": fixture.watch_departure_at}
                    body.update({"tracking_number": "EXAMWATCH"} if name == "parcel" else {"route": "fixture-home-to-work"})
                    kind = "watch." + name + ".read"
                elif url.path == "/flights":
                    date = query.get("date", [""])[0]
                    body = {"date": date, "from": "杭州", "to": "上海", "currency": "CNY", "tax_included": True,
                            "flights": [{"flight": "EX101", "departure": "09:00", "arrival": "10:00", "price": 450},
                                        {"flight": "EX103", "departure": "14:00", "arrival": "15:00", "price": 520}]}
                    kind = "flight.read"
                elif url.path.startswith(("/parcel/", "/v2/parcels/")) and url.path.rsplit("/", 1)[-1] in {"EXAM001", "EXAM002"}:
                    tracking = url.path.rsplit("/", 1)[-1]
                    status = "运输中" if tracking == "EXAM001" else "已签收"
                    if fixture.phase == "v2" and url.path.startswith("/parcel/"):
                        code, kind = 410, "fault.observed"
                        body = {"error": "Fixture endpoint moved", "replacement": "/v2/parcels/" + tracking}
                    elif fixture.phase == "v1" and url.path.startswith("/v2/"):
                        self.send_error(404)
                        return
                    else:
                        body = ({"tracking_number": tracking, "status": status} if fixture.phase == "v1" else
                                {"parcel": {"number": tracking, "latest": {"description": status}}})
                        kind = "parcel." + fixture.phase
                else:
                    self.send_error(404)
                    return
                with fixture.lock:
                    fixture.events.append({"kind": kind, "task": fixture.task, "task_id": fixture.task, "path": self.path,
                                           "body": body, "at": time.time(), "session_id": fixture.session,
                                           "stage": fixture.stage, "http_status": code})
                data = json.dumps(body, ensure_ascii=False).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer((host, port), Handler)
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

    def capture(self):
        with self.lock:
            return [dict(event) for event in self.events if event["task"] == self.task]

    def record(self, event):
        with self.lock:
            self.events.append({**event, "task": self.task, "task_id": self.task, "session_id": self.session, "stage": self.stage, "at": time.time()})
