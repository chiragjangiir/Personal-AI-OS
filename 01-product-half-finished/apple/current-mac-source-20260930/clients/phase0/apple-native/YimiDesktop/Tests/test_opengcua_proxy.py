"""Proxy boundary tests. No CuaDriver, TCC call, or GUI input is executed."""
import asyncio
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import dataclass
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

RUNNER = Path(__file__).resolve().parents[1] / "Helpers/opengcua/run.py"
SPEC = importlib.util.spec_from_file_location("opengcua_batch", RUNNER)
batch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(batch)


class ProxyTests(unittest.TestCase):
    def test_missing_socket_exits_before_sdk_or_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([sys.executable, "-I", "-B", str(RUNNER),
                                     directory + "/missing", "unused.app", directory, "-"],
                                    input="raise AssertionError('batch must not run')", text=True,
                                    capture_output=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Embedded CuaDriver socket unavailable", result.stderr)
            self.assertNotIn("AssertionError", result.stderr)

    def test_non_socket_does_not_construct_runtime(self):
        with tempfile.NamedTemporaryFile() as regular, patch.dict(sys.modules, {"mai_ui": None}):
            with self.assertRaisesRegex(ConnectionError, "Embedded CuaDriver socket unavailable"):
                asyncio.run(batch.run(regular.name, "unused.app", "/unused", "", "batch.py"))
            self.assertEqual(os.environ["CUA_DRIVER_EMBEDDED"], "1")

    def test_disconnect_surfaces_receipt_and_never_replays_unknown_effect(self):
        @dataclass
        class Receipt:
            effect: str = "unknown"

        class DriverError(Exception):
            receipt = Receipt()
            stop_receipt = None
            code = "DEVICE_OFFLINE"

        calls = []

        class Session:
            auto_reconnect = True

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                calls.append("session closed")

            async def register(self, resource, *, name):
                self.test_policy = self.auto_reconnect
                return self

            async def click(self):
                calls.append("one effect")
                self.output({"type": "image", "mime_type": "image/png", "data": b"snapshot evidence"})
                raise DriverError("DEVICE_OFFLINE: result unknown")

        session = Session()

        class Runtime:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                calls.append("runtime closed")

            async def add_macos(self, **options):
                calls.append(options)
                return "resource"

            def session(self, *, output):
                session.output = output
                return session

        sdk = types.SimpleNamespace(Runtime=Runtime, MuError=DriverError)
        with tempfile.TemporaryDirectory() as directory, socket.socket(socket.AF_UNIX) as endpoint:
            private = directory + "/s"
            endpoint.bind(private)
            errors, stdout = io.StringIO(), io.StringIO()
            with patch.dict(sys.modules, {"mai_ui": sdk}), redirect_stderr(errors), redirect_stdout(stdout):
                with self.assertRaises(DriverError):
                    asyncio.run(batch.run(private, "signed.app", directory,
                                          "await mac.click()\nraise AssertionError('must stop')", "batch.py"))
            self.assertEqual(calls, [{"name": "owner-mac", "app_path": "signed.app", "socket": private},
                                     "one effect", "session closed", "runtime closed"])
            self.assertFalse(session.test_policy)
            self.assertEqual(os.environ["CUA_DRIVER_EMBEDDED"], "1")
            error = json.loads(errors.getvalue())
            self.assertEqual(error["receipt"]["effect"], "unknown")
            self.assertFalse(error["replay"])
            image = json.loads(stdout.getvalue())
            self.assertEqual(Path(image["path"]).read_bytes(), b"snapshot evidence")
            self.assertNotIn("data", image)


if __name__ == "__main__":
    unittest.main()
