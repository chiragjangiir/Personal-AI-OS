"""Replay the audited async closeout order without a model, device or external service."""
import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import server
from test_fake_cashier import fake


def finished_at(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class CloseoutStatus(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.spool = Path(self.folder.name)
        for patch in (mock.patch.object(server, "SPOOL", self.folder.name),
                      mock.patch.object(server, "PHONE_PROVIDER", ""),
                      mock.patch.object(server, "_online", return_value=True),
                      mock.patch.object(server, "_errand_task", new=mock.AsyncMock(
                          return_value={"success": True, "answer": "模拟继续办理完成。"})),
                      mock.patch.dict(os.environ, PAIOS_ERRAND_SPOOL=self.folder.name)):
            patch.start()
            self.addCleanup(patch.stop)
        for executor in (server, fake):
            executor._jobs.clear()
            self.addCleanup(executor._jobs.clear)

    async def finish(self, executor, principal="owner", goal="发送已核验的fixture文件"):
        started = await executor.phone_task(goal, app="千问", principal_id=principal,
            effect={"kind": "send", "task_type": "send_file", "requested": True,
                    "recipient": "fixture:recipient"})
        await executor._jobs[started["job_id"]]["task"]
        return started, json.loads((self.spool / f"{started['job_id']}.done.json").read_text())

    async def test_completed_before_child_query_survives_parent_event_and_late_summary(self):
        for executor in (server, fake):
            with self.subTest(executor=executor.__name__):
                started, terminal = await self.finish(executor)
                order = ["phone_task:started", "job:completed"]
                self.assertNotIn(started["job_id"], executor._jobs)
                status = await executor.phone_status(principal_id="owner")
                order.append("child:phone_status")
                job = next(j for j in status["jobs"] if j["job_id"] == started["job_id"])
                self.assertEqual({k: job[k] for k in ("state", "success", "terminal_reason", "answer", "finished_at")},
                    {"state": "completed", **{k: terminal[k] for k in
                     ("success", "terminal_reason", "answer", "finished_at")}})
                # The gateway delivers this durable result to the parent after the child's query.
                event = {"kind": "errand_result", **terminal}
                source = self.spool / f"{started['job_id']}.done.json"
                source.rename(source.with_name(f"{started['job_id']}.notified.json"))
                order.extend(["parent:errand_result", "child:summary_arrives"])
                self.assertEqual(order, ["phone_task:started", "job:completed", "child:phone_status",
                                         "parent:errand_result", "child:summary_arrives"])
                after = await executor.phone_status(principal_id="owner")
                self.assertEqual(next(j for j in after["jobs"] if j["job_id"] == event["job_id"]), job)

    async def test_status_never_exposes_another_principals_running_or_terminal_job(self):
        for executor in (server, fake):
            with self.subTest(executor=executor.__name__):
                _, other = await self.finish(executor, "other-owner", "private task")
                executor._jobs["job-aaaaaaaaaaaa"] = {"principal_id": "other-owner", "app": "千问",
                    "goal": "private running task", "state": "running", "since": server.time.time()}
                result = await executor.phone_status(principal_id="owner")
                self.assertNotIn(other["job_id"], [j["job_id"] for j in result["jobs"]])
                self.assertNotIn("job-aaaaaaaaaaaa", [j["job_id"] for j in result["jobs"]])
                executor._jobs.pop("job-aaaaaaaaaaaa")

    async def test_status_uses_the_terminal_family_and_existing_600_second_window(self):
        for executor in (server, fake):
            with self.subTest(executor=executor.__name__):
                started, terminal = await self.finish(executor)
                path = self.spool / f"{started['job_id']}.done.json"
                for reason in ("completed", "failed", "timed_out", "cancelled_by_user", "interrupted"):
                    terminal.update(success=reason == "completed", terminal_reason=reason)
                    path.write_text(json.dumps(terminal))
                    result = await executor.phone_status(principal_id="owner")
                    job = next(j for j in result["jobs"] if j["job_id"] == started["job_id"])
                    self.assertEqual((job["state"], job["terminal_reason"], job["success"]),
                                     (reason, reason, reason == "completed"))
                for state in ("notified", "delivered"):
                    target = path.with_name(f"{started['job_id']}.{state}.json")
                    path.rename(target)
                    path = target
                    result = await executor.phone_status(principal_id="owner")
                    self.assertIn(started["job_id"], [j["job_id"] for j in result["jobs"]])
                old = server.time.time() - server.RECENT_S - 1
                terminal["finished_at"] = finished_at(old)
                path.write_text(json.dumps(terminal))
                result = await executor.phone_status(principal_id="owner")
                self.assertNotIn(started["job_id"], [j["job_id"] for j in result["jobs"]])

    async def test_restored_legacy_terminals_do_not_revive_or_poison_fresh_status(self):
        for state in ("delivered", "invalid"):
            started, terminal = await self.finish(fake)
            path = self.spool / f"{started['job_id']}.done.json"
            terminal["finished_at"] = finished_at(server.time.time() - server.RECENT_S - 1)
            if state == "delivered":
                terminal.pop("principal_id")  # A historical terminal, not a newly accepted result.
            path.write_text(json.dumps(terminal))
            path.rename(path.with_name(f"{started['job_id']}.{state}.json"))
        own, terminal = await self.finish(fake)
        foreign, _ = await self.finish(fake, "other-owner", "private task")
        for executor in (server, fake):
            result = await executor.phone_status(principal_id="owner")
            self.assertEqual([job["job_id"] for job in result["jobs"]], [own["job_id"]])
            self.assertEqual({key: result["jobs"][0][key] for key in ("success", "terminal_reason", "answer", "finished_at")},
                             {key: terminal[key] for key in ("success", "terminal_reason", "answer", "finished_at")})
            self.assertNotIn(foreign["job_id"], json.dumps(result))
            self.assertNotIn("private task", json.dumps(result))

    async def test_finished_clock_keeps_600_boundary_even_when_mtime_disagrees(self):
        started, terminal = await self.finish(fake)
        path = self.spool / f"{started['job_id']}.done.json"
        now = 2_000_000_000.0
        for elapsed, visible in ((600, True), (600.001, False)):
            terminal["finished_at"] = finished_at(now - elapsed)
            path.write_text(json.dumps(terminal))
            os.utime(path, (now - 10_000 if visible else now, now - 10_000 if visible else now))
            for executor in (server, fake):
                with mock.patch("errand_status.time.time", return_value=now):
                    result = await executor.phone_status(principal_id="owner")
                self.assertEqual(started["job_id"] in [job["job_id"] for job in result["jobs"]], visible)

    async def test_report_failure_rewrite_does_not_extend_finished_window(self):
        started, terminal = await self.finish(fake)
        path = self.spool / f"{started['job_id']}.done.json"
        terminal.update(finished_at=finished_at(server.time.time() - server.RECENT_S - 1),
                        delivery_failure={"error_code": "ERRAND_REPORT_NOT_DELIVERED", "failed_at": server._now()})
        for state in ("delivery-failed", "invalid"):
            target = path.with_name(f"{started['job_id']}.{state}.json")
            path.rename(target)
            target.write_text(json.dumps(terminal))  # The report owner rewrites the original executor result.
            for executor in (server, fake):
                self.assertEqual((await executor.phone_status(principal_id="owner"))["jobs"], [])
            path = target

    async def test_recent_results_sort_by_finished_time_not_restore_or_delivery_mtime(self):
        pairs = [await self.finish(fake) for _ in range(2)]
        now = server.time.time()
        for index, (started, terminal) in enumerate(pairs):
            terminal["finished_at"] = finished_at(now - 2 + index)
            path = self.spool / f"{started['job_id']}.done.json"
            path.write_text(json.dumps(terminal))
            os.utime(path, (now - index * 1000, now - index * 1000))
        for executor in (server, fake):
            result = await executor.phone_status(principal_id="owner")
            self.assertEqual([job["job_id"] for job in result["jobs"]], [pair[0]["job_id"] for pair in reversed(pairs)])

    async def test_unknown_or_corrupt_timestamp_never_ages_out_by_mtime(self):
        started, terminal = await self.finish(fake)
        path = self.spool / f"{started['job_id']}.done.json"
        for value in (None, "2026-13-01T00:00:00.000Z", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00.000+00:00"):
            path.write_text(json.dumps({**terminal, "finished_at": value}))
            old = server.time.time() - server.RECENT_S - 1
            os.utime(path, (old, old))
            for executor in (server, fake):
                with self.subTest(timestamp=value, executor=executor.__name__), self.assertRaisesRegex(ValueError, "ERRAND_TERMINAL_UNREADABLE"):
                    await executor.phone_status(principal_id="owner")

    async def test_status_surfaces_unreadable_terminal_instead_of_empty_success(self):
        (self.spool / "job-bbbbbbbbbbbb.done.json").write_text("{")
        for executor in (server, fake):
            with self.subTest(executor=executor.__name__), self.assertRaisesRegex(ValueError, "ERRAND_TERMINAL_UNREADABLE"):
                await executor.phone_status(principal_id="owner")

    async def test_status_requires_principal(self):
        for executor in (server, fake):
            with self.subTest(executor=executor.__name__), self.assertRaisesRegex(ValueError, "ERRAND_PRINCIPAL_REQUIRED"):
                await executor.phone_status()


if __name__ == "__main__":
    unittest.main()
