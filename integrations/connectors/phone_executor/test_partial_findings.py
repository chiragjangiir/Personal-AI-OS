"""Phone terminal evidence from real workflow events, without a device or model endpoint."""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from mobilerun.agent.common.events import RecordUIStateEvent
from mobilerun.agent.fast_agent.events import FastAgentInputEvent, FastAgentResponseEvent

import server
from step_trace import StepTrace


LEDGER = """<add_memory>
Todo ledger:
[claimed_verified] 示例店甲：屏幕参考价格 68–98 元，双人份。
[changed_unverified] 示例店乙：报价 128 元，尚未读完。
[pending] 配送地址和配送费尚未读到。
</add_memory>"""
SCREEN = [{"text": "千问"}, *({"text": ""} for _ in range(6)),
          {"children": [{"text": "示例店丙，距离 2 公里"}, {"contentDescription": "参考价 88 元"}]}]


class PartialFindings(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.addCleanup(server._jobs.clear)
        for patch in (mock.patch.object(server, "SPOOL", self.folder.name),
                      mock.patch.object(server, "PHONE_PROVIDER", "")):
            patch.start()
            self.addCleanup(patch.stop)

    async def test_timeout_failure_and_cancel_deliver_verified_partial_findings(self):
        for ending, reason in (("timeout", "timed_out"), ("failed", "failed"),
                               ("error", "failed"), ("cancel", "cancelled_by_user"), ("success", "completed")):
            with self.subTest(ending=ending):
                observed = asyncio.Event()

                class Handler:
                    def __await__(self):
                        async def run():
                            await observed.wait()
                            if ending in ("timeout", "cancel"):
                                await asyncio.Event().wait()
                            if ending == "error":
                                raise RuntimeError("fixture execution failed")
                            return SimpleNamespace(success=ending == "success", reason="fixture result", steps=1)
                        return run().__await__()

                    async def stream_events(self):
                        yield FastAgentInputEvent()
                        yield RecordUIStateEvent(ui_state=SCREEN)
                        yield FastAgentResponseEvent(thought="private reasoning must not be saved\n" + LEDGER)
                        observed.set()
                        await asyncio.Event().wait()

                    async def cancel_run(self):
                        pass

                config = SimpleNamespace(device=SimpleNamespace(), agent=SimpleNamespace(), llm_profiles={})

                async def errand(**_):
                    return await server._agent("read fixture", 4, None, driver=SimpleNamespace())

                with mock.patch.object(server, "_load_model"), mock.patch.object(server, "_bind"), \
                     mock.patch.object(server, "ConfigLoader", SimpleNamespace(load=lambda _: config), create=True), \
                     mock.patch.object(server, "MobileAgent", return_value=SimpleNamespace(run=Handler), create=True), \
                     mock.patch.object(server, "TASK_TIMEOUT_S", .1), \
                     mock.patch.object(server, "_screen_signs", new=mock.AsyncMock(return_value=set())), \
                     mock.patch.object(server, "_signs_after", new=mock.AsyncMock(return_value=set())), \
                     mock.patch.object(server, "_errand_task", errand):
                    jid = "job-123456abcdef"
                    server._start(jid, dict(goal="read fixture", max_steps=4, payment_intent=None, app="千问", tier="fast"), "查价格", "owner")
                    task = server._jobs[jid]["task"]
                    await observed.wait()
                    if ending == "cancel":
                        server._jobs[jid]["state"] = "stopping"
                        task.cancel()
                    await task
                terminal = json.loads(Path(self.folder.name, f"{jid}.done.json").read_text())
                self.assertEqual(terminal["terminal_reason"], reason)
                if ending == "success":
                    self.assertNotIn("partial_findings", terminal)
                    continue
                findings = terminal["partial_findings"]
                self.assertEqual(findings["verified"], ["示例店甲：屏幕参考价格 68–98 元，双人份。"])
                self.assertEqual(len(findings["not_verified"]), 2)
                self.assertNotIn("128", " ".join(findings["verified"]))
                self.assertIn("示例店丙，距离 2 公里", findings["last_screen_text"])
                self.assertIn("参考价 88 元", findings["last_screen_text"])
                self.assertEqual(terminal["trace"]["findings"], findings)
                self.assertIn("部分结果", terminal["answer"])
                self.assertIn("68–98", terminal["answer"])
                self.assertIn("未核实", terminal["answer"])
                self.assertNotIn("private reasoning", json.dumps(terminal))
                self.assertFalse(terminal["success"])
                status = await server.phone_status(principal_id="owner", job_id=jid)
                self.assertEqual(status["jobs"][0]["partial_findings"], findings)
                self.assertEqual((await server.phone_status(principal_id="other", job_id=jid))["jobs"], [])

    async def test_restart_preserves_partial_findings_from_the_running_trace(self):
        trace = StepTrace()
        trace.event(RecordUIStateEvent(ui_state=SCREEN))
        trace.event(FastAgentResponseEvent(thought=LEDGER))
        jid = "job-abcdef123456"
        Path(self.folder.name, f"{jid}.running.json").write_text(json.dumps({
            "job_id": jid, "principal_id": "owner", "task": "read fixture", "state": "running",
            "tier": "fast", "trace": trace.snapshot()}))
        server._recover_interrupted()
        terminal = json.loads(Path(self.folder.name, f"{jid}.done.json").read_text())
        self.assertEqual(terminal["terminal_reason"], "interrupted")
        self.assertIn("68–98", terminal["partial_findings"]["verified"][0])
        self.assertIn("部分结果", terminal["answer"])

    async def test_latest_empty_screen_clears_old_text_without_losing_the_ledger(self):
        trace = StepTrace()
        trace.event(RecordUIStateEvent(ui_state=SCREEN))
        trace.event(FastAgentResponseEvent(thought=LEDGER))
        trace.event(RecordUIStateEvent(ui_state=[]))
        findings = trace.snapshot()["findings"]
        self.assertEqual(findings["last_screen_text"], "")
        self.assertIn("68–98", findings["verified"][0])

    async def test_bounded_observations_and_unverified_only_results_remain_explicit(self):
        trace = StepTrace()
        trace.event(RecordUIStateEvent(ui_state=[{"text": "屏幕" * 3000}]))
        trace.event(FastAgentResponseEvent(thought="<add_memory>\n" + "\n".join(
            f"[pending] 未读取项目 {index}：" + "待核实" * 100 for index in range(40)) + "\n</add_memory>"))
        record = server.step_trace.partial_result({"success": False, "answer": "fixture failed", "trace": trace.snapshot()})
        findings = record["partial_findings"]
        self.assertEqual(findings["verified"], [])
        self.assertTrue(findings["truncated"])
        self.assertLessEqual(len(findings["last_screen_text"]), 4000)
        self.assertLessEqual(sum(map(len, findings["not_verified"])), 6000)
        self.assertIn("无已核实条目", record["answer"])
        trace.event(FastAgentResponseEvent(thought="<add_memory>\n[blocked] 价格无法核实\n</add_memory>"))
        self.assertEqual(trace.snapshot()["findings"]["not_verified"], ["[blocked] 价格无法核实"])


if __name__ == "__main__":
    unittest.main()
