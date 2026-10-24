"""Errand progress marker and cancel-by-marker; no phone, agent or adb involved.
Run with the executor's interpreter: .venv/bin/python -I test_errand_progress.py"""
import asyncio
import json
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402

KEYS = {"principal_id", "job_id", "task", "title", "app", "tier", "state", "started_at", "step", "max_steps",
        "phone_started_at", "payment_owner"}


class Progress(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.spool = Path(self.dir.name)
        identity = f'progress-{os.getpid()}'
        self.addCleanup((Path('/tmp') / f'paios-phone-progress_{os.getpid()}.lock').unlink, missing_ok=True)
        for patch in (mock.patch.object(server, "SPOOL", str(self.spool)), mock.patch.object(server, 'PHONE_SERIAL', identity),
                      mock.patch.object(server, "_online", lambda *_: True)):
            patch.start()
            self.addCleanup(patch.stop)
        self.addCleanup(self.dir.cleanup)
        self.addCleanup(server._jobs.clear)

    async def test_phone_tool_contract_requires_typed_effect(self):
        schema = next(tool.inputSchema for tool in await server.mcp.list_tools() if tool.name == "phone_task")
        self.assertIn("effect", schema["required"])
        self.assertEqual(schema["properties"]["effect"]["type"], "object")
        rejected = await server.phone_task("读取首页", principal_id="owner", effect=None)
        self.assertEqual(rejected["error_code"], "EFFECT_CLASSIFICATION_REQUIRED")

    def marker(self, job_id):
        return json.loads((self.spool / f"{job_id}.running.json").read_text())

    async def start(self, fake, **kw):
        patch = mock.patch.object(server, "_errand_task", fake)  # the job task runs after phone_task returns
        patch.start()
        self.addCleanup(patch.stop)
        res = await server.phone_task("在千问里点一杯香柠养乐多\n第二行", app="千问", **kw, principal_id=kw.pop("principal_id", "owner"), effect={"kind": "external", "task_type": "purchase_errand", "requested": True})
        return res["job_id"]

    async def test_principal_survives_creation_progress_and_completion(self):
        gate = asyncio.Event()
        async def fake(**_):
            await gate.wait()
            return {"success": True, "answer": "owned result"}
        with mock.patch.object(server, "_errand_task", fake):
            a = await server.phone_task("same private task", app="千问", principal_id="owner-a", effect={"kind": "external", "task_type": "purchase_errand", "requested": True})
            b = await server.phone_task("same private task", app="千问", principal_id="owner-b", effect={"kind": "external", "task_type": "purchase_errand", "requested": True})
            self.assertNotEqual(a["job_id"], b["job_id"], "dedup is principal scoped")
            for job, owner in ((a, "owner-a"), (b, "owner-b")):
                self.assertEqual(self.marker(job["job_id"])["principal_id"], owner)
            tasks = [server._jobs[job["job_id"]]["task"] for job in (a, b)]
            gate.set()
            await asyncio.gather(*tasks)
            for job, owner in ((a, "owner-a"), (b, "owner-b")):
                result = json.loads((self.spool / f"{job['job_id']}.done.json").read_text())
                self.assertEqual(result["principal_id"], owner)
                self.assertNotIn("origin_processed_event_id", result)
            self.assertEqual((await server.phone_task("same private task", app="千问", principal_id="owner-a", effect={"kind": "external", "task_type": "purchase_errand", "requested": True}))["job_id"], a["job_id"])
        with self.assertRaisesRegex(ValueError, "ERRAND_PRINCIPAL_REQUIRED"):
            await server.phone_task("unowned task", effect={"kind": "external", "task_type": "purchase_errand", "requested": True})

    async def test_server_lineage_survives_running_done_and_restart(self):
        origin = "pe-owner-request"
        for recovered in (False, True):
            with self.subTest(recovered=recovered):
                gate = asyncio.Event()
                async def fake(**args):
                    self.assertNotIn("origin_processed_event_id", args)
                    self.assertNotIn("job_id", args)
                    await gate.wait()
                    return {"success": True, "answer": "ok"}
                job_id = "job-0123456789ab" if recovered else "job-abcdef012345"
                actual = await self.start(fake, job_id=job_id, origin_processed_event_id=origin, repeat=True)
                self.assertEqual(actual, job_id)
                self.assertEqual(self.marker(job_id)["origin_processed_event_id"], origin)
                server._jobs[job_id]["state"] = "running"
                server._write_running(job_id, force=True)
                self.assertEqual(self.marker(job_id)["origin_processed_event_id"], origin)
                task = server._jobs[job_id]["task"]
                if recovered:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                    server._jobs.pop(job_id)
                    server._recover_interrupted()
                else:
                    gate.set()
                    await task
                done = json.loads((self.spool / f"{job_id}.done.json").read_text())
                self.assertEqual(done["origin_processed_event_id"], origin)
                self.assertEqual(done["terminal_reason"], "interrupted" if recovered else "completed")

    async def test_wire_lineage_rejects_invalid_identifiers(self):
        for args in ({"job_id": "../job-0123456789ab"}, {"origin_processed_event_id": "bad origin"}):
            with self.assertRaises(ValueError):
                await server.phone_task("read", principal_id="owner", effect={"kind": "read", "task_type": "read", "requested": True}, **args)

    async def test_schema_and_title(self):
        gate = asyncio.Event()

        async def fake(**_):
            await gate.wait()
            return {"success": True, "answer": "ok"}

        job_id = await self.start(fake, max_steps=500, title=" 点一杯\n香柠养乐多 " + "长" * 60)
        m = self.marker(job_id)
        self.assertEqual(set(m), KEYS)
        self.assertIsNone(m["phone_started_at"])
        self.assertIsNone(m["payment_owner"])
        self.assertEqual((m["state"], m["step"], m["max_steps"], m["app"], m["tier"]), ("waiting", 0, 120, "千问", "fast"))
        self.assertLessEqual(len(m["title"]), 40)
        self.assertTrue(m["title"].endswith("…"))
        self.assertTrue(m["title"].startswith("点一杯 香柠养乐多"))
        self.assertRegex(m["started_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
        self.assertEqual(oct((self.spool / f"{job_id}.running.json").stat().st_mode & 0o777), "0o600")
        self.assertEqual([p.name for p in self.spool.glob("*.tmp")], [])
        self.assertEqual(server._title("", "  在千问里点\t一杯  \n第二行"), "在千问里点 一杯")
        self.assertEqual(server._title("", "核对测试报表，" + "internationalization " * 3), "核对测试报表，internationalization…")
        self.assertEqual(server._title("核对测试报表", "长指令" * 40), "核对测试报表")
        gate.set()
        await server._jobs[job_id]["task"]

    async def test_states_throttle_and_no_resurrection(self):
        writes, real = [], server._spool
        server._spool = lambda jid, rec, state: (writes.append((state, dict(rec))), real(jid, rec, state))[1]
        self.addCleanup(setattr, server, "_spool", real)

        class Handler:
            def __init__(self, job_id): self.job_id = job_id

            async def stream_events(self):
                from mobilerun.agent.fast_agent.events import FastAgentResponseEvent
                ev = FastAgentResponseEvent(thought="t")
                for _ in range(5):  # a burst inside one second: only the first step is written
                    yield ev
                server._jobs[self.job_id]["written"] = 0  # a second later the next step goes out
                yield ev

        async def fake(**_):
            job_id = server._job_id.get()
            with mock.patch.object(server, "_online", lambda *_: False):
                with self.assertRaises(RuntimeError):
                    async with server._errand(None, None):
                        pass  # state -> running is written before the phone is touched
            await server._count_steps(Handler(job_id), 80)
            return {"success": True, "answer": "ok"}

        job_id = await self.start(fake)
        task = server._jobs[job_id]["task"]
        await task
        running = [r for s, r in writes if s == "running"]
        self.assertEqual([(r["state"], r["step"]) for r in running], [("waiting", 0), ("running", 0), ("running", 1), ("running", 6)])
        self.assertFalse((self.spool / f"{job_id}.running.json").exists())
        self.assertTrue((self.spool / f"{job_id}.done.json").exists())
        server._write_running(job_id, force=True)  # a late step event after completion
        self.assertFalse((self.spool / f"{job_id}.running.json").exists())

    async def test_cancel_marker(self):
        async def fake(**_):
            await asyncio.sleep(60)

        job_id = await self.start(fake)
        task = server._jobs[job_id]["task"]
        states = []
        real = server._spool
        with mock.patch.object(server, "_spool", lambda j, r, s: (states.append(r["state"]) if s == "running" else None, real(j, r, s))[1]):
            (self.spool / f"{job_id}.cancel").write_text("")
            (self.spool / "job-000000000000.cancel").write_text("")  # unknown job
            (self.spool / "job-xyz.cancel").write_text("")  # not a job marker: left alone
            (self.spool / "notes.txt").write_text("")
            server._scan_cancels()
        self.assertEqual(states, ["stopping"])
        self.assertEqual(sorted(p.name for p in self.spool.glob("*.cancel")), ["job-xyz.cancel"])
        await task
        done = json.loads((self.spool / f"{job_id}.done.json").read_text())
        self.assertEqual((done["success"], done["answer"]), (False, server.STOPPED))
        self.assertNotIn(job_id, server._jobs)
        self.assertFalse((self.spool / f"{job_id}.running.json").exists())



if __name__ == "__main__":
    unittest.main()
