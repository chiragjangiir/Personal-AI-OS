#!/usr/bin/env python3
"""Loopback-only HealthKit ingestion fixture using Python's standard library."""

import argparse
from datetime import datetime, timezone
import json
import socket
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


MODES = {
    "success",
    "401",
    "403",
    "408",
    "429",
    "500",
    "503",
    "timeout",
    "connection-loss",
}


class IngestionServer(ThreadingHTTPServer):
    def __init__(self, address, handler, mode, delay, summary_log):
        super().__init__(address, handler)
        self.mode = mode
        self.delay = delay
        self.summary_log = summary_log
        self.accepted_keys = set()
        self.accepted_keys_lock = threading.Lock()
        self.summary_log_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server_version = "HealthKitMock/1"
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        if self.path != "/v1/healthkit/ingest":
            self._respond(404, {"error": "not_found"})
            return

        if self.server.mode == "timeout":
            time.sleep(self.server.delay)
            self._respond(408, {"error": "timeout"})
            return
        if self.server.mode == "connection-loss":
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return

        forced_status = {
            "401": 401,
            "403": 403,
            "408": 408,
            "429": 429,
            "500": 500,
            "503": 503,
        }.get(self.server.mode)
        if forced_status is not None:
            headers = {"Retry-After": "5"} if forced_status in (429, 503) else None
            self._respond(forced_status, {"error": f"simulated_{forced_status}"}, headers)
            return

        if self.headers.get("Authorization") != "Bearer test-token":
            self._respond(401, {"error": "unauthorized"})
            return

        content_length = self.headers.get("Content-Length")
        if content_length is None:
            self._respond(411, {"error": "length_required"})
            return
        try:
            length = int(content_length)
        except ValueError:
            self._respond(400, {"error": "invalid_content_length"})
            return
        if length < 0 or length > 1_000_000:
            self._respond(413, {"error": "payload_too_large"})
            return

        try:
            payload = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._respond(400, {"error": "invalid_json"})
            return

        batch_id = payload.get("batchId")
        idempotency_key = self.headers.get("Idempotency-Key")
        if not isinstance(batch_id, str) or batch_id != idempotency_key:
            self._respond(400, {"error": "batch_id_mismatch"})
            return

        with self.server.accepted_keys_lock:
            duplicate = idempotency_key in self.server.accepted_keys
            self.server.accepted_keys.add(idempotency_key)
        self._record_summary(payload, batch_id, duplicate)
        self._respond(
            200 if duplicate else 202,
            {"batchId": batch_id, "duplicate": duplicate},
        )

    def _record_summary(self, payload, batch_id, duplicate):
        if not self.server.summary_log:
            return
        records = payload.get("records")
        deleted_records = payload.get("deletedRecords")
        summary = {
            "receivedAt": datetime.now(timezone.utc).isoformat(),
            "batchId": batch_id,
            "schemaVersion": payload.get("schemaVersion"),
            "mode": payload.get("mode"),
            "recordCount": len(records) if isinstance(records, list) else None,
            "deletedRecordCount": (
                len(deleted_records) if isinstance(deleted_records, list) else None
            ),
            "duplicate": duplicate,
        }
        encoded = json.dumps(summary, separators=(",", ":"))
        with self.server.summary_log_lock:
            with open(self.server.summary_log, "a", encoding="utf-8") as log:
                log.write(encoded + "\n")

    def _respond(self, status, body, headers=None):
        encoded = json.dumps(body, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, message, *args):
        print(f"{self.client_address[0]} - {message % args}")


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--mode", choices=sorted(MODES), default="success")
    parser.add_argument("--delay", type=float, default=35.0)
    parser.add_argument(
        "--summary-log",
        help="Append redacted batch metadata as JSON lines; never writes payload values",
    )
    parser.add_argument("--cert", help="PEM certificate for optional TLS")
    parser.add_argument("--key", help="PEM private key for optional TLS")
    args = parser.parse_args()
    if bool(args.cert) != bool(args.key):
        parser.error("--cert and --key must be provided together")
    return args


def main():
    args = parse_args()
    server = IngestionServer(
        (args.host, args.port),
        Handler,
        args.mode,
        args.delay,
        args.summary_log,
    )
    scheme = "http"
    if args.cert:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(args.cert, args.key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        scheme = "https"
    print(
        f"Mock ingestion server listening on "
        f"{scheme}://{args.host}:{args.port} in {args.mode} mode"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
