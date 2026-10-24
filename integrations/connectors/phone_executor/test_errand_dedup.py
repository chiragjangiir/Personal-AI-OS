"""Terminal rename races must never turn a completed errand into a new dispatch."""
import asyncio
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server


class TerminalDedup(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name)
        self.job = "job-0123456789ab"
        self.record = dict(job_id=self.job, principal_id="owner", task="叫车回家", app="千问",
                           success=True, terminal_reason="completed", answer="已叫车", finished_at=server._now())
        for patch in (mock.patch.object(server, "SPOOL", folder.name),
                      mock.patch.object(server, "PHONE_PROVIDER", "agentbay"),
                      mock.patch.object(server, "_login_phone", None)):
            patch.start()
            self.addCleanup(patch.stop)
        server._jobs.clear()
        self.addCleanup(server._jobs.clear)

    def terminal(self, state="done"):
        path = self.folder / f"{self.job}.{state}.json"
        path.write_text(json.dumps(self.record))
        return path

    async def dispatch(self):
        with mock.patch.object(server, "_start") as start:
            result = await server.phone_task(self.record["task"], app="千问", ride_ok=True, principal_id="owner", effect={"kind": "external", "task_type": "purchase_errand", "requested": True})
        start.assert_not_called()
        return result

    async def test_server_job_replay_cannot_start_twice_even_with_repeat(self):
        gate = asyncio.Event()
        async def fake(**_):
            await gate.wait()
            return {"success": False, "answer": "failed once"}
        async def dispatch(job_id):
            return await server.phone_task(self.record["task"], app="千问", principal_id="owner",
                                           job_id=job_id, repeat=True,
                                           effect={"kind": "read", "task_type": "read", "requested": True})
        with mock.patch.object(server, "_errand_task", fake), mock.patch.object(server, "_start", wraps=server._start) as start:
            first, replay = await asyncio.gather(dispatch(self.job), dispatch(self.job))
            self.assertEqual((first["status"], replay["status"]), ("started", "already_running"))
            self.assertEqual(start.call_count, 1)
            task = server._jobs[self.job]["task"]
            gate.set()
            await task
            # A failed terminal and the ordinary goal-dedup age limit cannot reopen this call identity.
            path = self.folder / f"{self.job}.done.json"
            old = server.time.time() - server.RECENT_S - 1
            record = json.loads(path.read_text())
            record["finished_at"] = datetime.fromtimestamp(old, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            path.write_text(json.dumps(record))
            replay = await dispatch(self.job)
            self.assertEqual((replay["status"], replay["job_id"]), ("duplicate", self.job))
            self.assertIn("failed once", replay["answer"])
            self.assertEqual(start.call_count, 1)
            new_id = "job-abcdef012345"
            self.assertEqual((await dispatch(new_id))["status"], "started")
            await server._jobs[new_id]["task"]
            self.assertEqual(start.call_count, 2)

    async def test_report_failure_preserves_executor_status_and_prevents_redispatch(self):
        self.record["delivery_failure"] = dict(error_code="FORMAL_TEXT_OUTPUT_INVALID", failed_at=server._now())
        for state in ("delivery-failed", "invalid"):
            with self.subTest(state=state):
                path = self.terminal(state)
                result = await self.dispatch()
                self.assertEqual((result["status"], result["job_id"]), ("duplicate", self.job))
                status = server.job_status(server.SPOOL, server._jobs, "owner")
                self.assertEqual((status["jobs"][0]["success"], status["jobs"][0]["terminal_reason"]), (True, "completed"))
                path.unlink()

    async def test_targeted_old_completed_identity_remains_deduplicated(self):
        old = server.time.time() - server.RECENT_S - 1
        self.record["finished_at"] = datetime.fromtimestamp(old, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        self.terminal()
        self.assertIsNone(server._same_errand(self.record["task"], "千问", "owner"))
        with mock.patch.object(server, "_start") as start:
            result = await server.phone_task(self.record["task"], app="千问", ride_ok=True, principal_id="owner",
                job_id=self.job, repeat=True, effect={"kind": "external", "task_type": "purchase_errand", "requested": True})
        self.assertEqual((result["status"], result["job_id"]), ("duplicate", self.job))
        start.assert_not_called()

    async def test_rename_after_directory_snapshot_resolves_by_job_identity(self):
        for target in ("notified", "delivered"):
            with self.subTest(target=target):
                source = self.terminal()
                dest = self.folder / f"{self.job}.{target}.json"
                real_glob, real_iterdir = Path.glob, Path.iterdir
                renamed = False

                def snapshot(paths):
                    nonlocal renamed
                    names = list(paths)
                    if not renamed:
                        source.rename(dest)
                        renamed = True
                    return iter(names)

                with mock.patch.object(Path, "glob", lambda p, pattern: snapshot(real_glob(p, pattern))), \
                     mock.patch.object(Path, "iterdir", lambda p: snapshot(real_iterdir(p))):
                    result = await self.dispatch()
                self.assertTrue(renamed)
                self.assertEqual((result["status"], result["job_id"]), ("duplicate", self.job))
                dest.unlink()

    async def test_rename_immediately_before_read_follows_entire_terminal_family(self):
        self.terminal()
        real_open = Path.open
        moves = {"done": "notified", "notified": "delivered"}

        def opening(path, *args, **kwargs):
            state = path.name.split(".")[-2]
            if state in moves and path.exists():
                path.rename(path.with_name(f"{self.job}.{moves[state]}.json"))
            return real_open(path, *args, **kwargs)

        with mock.patch.object(Path, "open", opening):
            result = await self.dispatch()
        self.assertEqual((result["status"], result["job_id"]), ("duplicate", self.job))
        self.assertTrue((self.folder / f"{self.job}.delivered.json").exists())

    async def test_directory_stream_omitting_a_moving_name_is_rescanned(self):
        self.terminal()
        real_iterdir = Path.iterdir
        moves = iter((("done", "notified"), ("notified", "delivered")))

        def listing(folder):
            transition = next(moves, None)
            if transition:
                before, after = transition
                (folder / f"{self.job}.{before}.json").rename(folder / f"{self.job}.{after}.json")
                return iter(())  # POSIX readdir does not promise a snapshot across concurrent renames.
            return real_iterdir(folder)

        with mock.patch.object(Path, "iterdir", listing):
            result = await self.dispatch()
        self.assertEqual((result["status"], result["job_id"]), ("duplicate", self.job))

    async def test_unknown_terminal_state_is_retryable_and_never_starts(self):
        for failure in ("missing", "permission", "malformed", "missing_scope", "unknown_reason", "invalid"):
            with self.subTest(failure=failure):
                source = self.terminal("invalid" if failure == "invalid" else "done")
                real_open = Path.open

                def opening(path, *args, **kwargs):
                    if path == source:
                        if failure == "missing":
                            path.unlink(missing_ok=True)
                        if failure == "permission":
                            raise PermissionError("unreadable terminal")
                    return real_open(path, *args, **kwargs)

                if failure == "malformed":
                    source.write_text("{")
                if failure == "missing_scope":
                    source.write_text(json.dumps({"job_id": self.job}))
                if failure == "unknown_reason":
                    source.write_text(json.dumps({**self.record, "success": False, "terminal_reason": "unknown-wire-value"}))
                with mock.patch.object(Path, "open", opening):
                    result = await self.dispatch()
                self.assertEqual(result["status"], "retryable")
                self.assertTrue(result["retryable"])
                self.assertEqual(result["code"], "ERRAND_DEDUP_STATE_UNKNOWN")
                source.unlink(missing_ok=True)

    async def test_readable_bad_record_blocks_only_its_principal_and_task(self):
        for state, record in (("invalid", self.record), ("done", {**self.record, "answer": None}),
                              ("invalid", {**self.record, "app": "corrupt-app"}),
                              ("invalid", {"principal_id": "owner", "task": self.record["task"]})):
            with self.subTest(state=state, record=record):
                path = self.terminal(state)
                path.write_text(json.dumps(record))
                self.assertEqual((await self.dispatch())["status"], "retryable")
                for principal, goal in (("other-owner", self.record["task"]), ("owner", "查明天天气")):
                    with mock.patch.object(server, "_start") as start:
                        result = await server.phone_task(goal, app="千问", principal_id=principal, effect={"kind": "external", "task_type": "purchase_errand", "requested": True})
                    self.assertEqual(result["status"], "started")
                    start.assert_called_once()
                if record.get("app") in server.APPS:
                    with mock.patch.object(server, "_start") as start:
                        result = await server.phone_task(self.record["task"], app="高德", principal_id="owner", effect={"kind": "external", "task_type": "purchase_errand", "requested": True})
                    self.assertEqual(result["status"], "started")
                    start.assert_called_once()
                path.unlink()

    async def test_unreadable_record_blocks_all_and_cannot_age_out_by_mtime(self):
        path = self.terminal()
        real_open = Path.open

        def opening(candidate, *args, **kwargs):
            if candidate == path:
                raise PermissionError("unreadable terminal")
            return real_open(candidate, *args, **kwargs)

        with mock.patch.object(Path, "open", opening), mock.patch.object(server.logging, "error") as alert:
            for principal in ("owner", "other-owner", "owner"):
                with mock.patch.object(server, "_start") as start:
                    result = await server.phone_task("另一个任务", app="千问", principal_id=principal, effect={"kind": "external", "task_type": "purchase_errand", "requested": True})
                self.assertEqual(result["status"], "retryable")
                start.assert_not_called()
            alert.assert_called_once()
            self.assertIn(self.job, str(alert.call_args))
            old = server.time.time() - server.RECENT_S - 1
            os.utime(path, (old, old))
            with mock.patch.object(server, "_start") as start:
                result = await server.phone_task("另一个任务", app="千问", principal_id="owner", effect={"kind": "external", "task_type": "purchase_errand", "requested": True})
            self.assertEqual(result["status"], "retryable")
            start.assert_not_called()
            alert.assert_called_once()


if __name__ == "__main__":
    unittest.main()
