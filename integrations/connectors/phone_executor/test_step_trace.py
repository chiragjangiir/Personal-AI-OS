"""Bounded executor evidence through the real model callback and workflow event contracts."""
import asyncio
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import server
from llama_index.core.base.llms.types import ChatMessage, ChatResponse
from llama_index.core.llms.callbacks import llm_chat_callback
from mobilerun.agent.fast_agent.events import FastAgentInputEvent


class ReasoningModel:
    rate_limiter = None

    def to_payload(self):
        return {}

    @llm_chat_callback()
    async def astream_chat(self, messages):
        async def tokens():
            while True:
                await asyncio.sleep(.005)
                yield ChatResponse(message=ChatMessage(role="assistant", content=""),
                                   delta="", additional_kwargs={"reasoning_content": "private reasoning"})
        return tokens()


class TraceRegression(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.addCleanup(server._jobs.clear)
        for patch in (mock.patch.object(server, "SPOOL", self.folder.name),
                      mock.patch.object(server, "PHONE_PROVIDER", "")):
            patch.start()
            self.addCleanup(patch.stop)

    async def test_reasoning_past_deadline_keeps_stalled_model_step_and_private_exact_status(self):
        entered = asyncio.Event()
        class Handler:
            def __await__(self):
                async def run():
                    stream = await ReasoningModel().astream_chat([ChatMessage(role="user", content="private prompt")])
                    entered.set()
                    async for _ in stream:
                        pass
                return run().__await__()

            async def stream_events(self):
                yield FastAgentInputEvent()
                await asyncio.Event().wait()

            async def cancel_run(self):
                pass

        config = SimpleNamespace(device=SimpleNamespace(), agent=SimpleNamespace(), llm_profiles={})
        async def errand(**_):
            return await server._agent("read fixture", 4, None, driver=SimpleNamespace())
        with mock.patch.object(server, "_load_model"), \
             mock.patch.object(server, "ConfigLoader", SimpleNamespace(load=lambda _: config), create=True), \
             mock.patch.object(server, "MobileAgent", return_value=SimpleNamespace(run=Handler), create=True), \
             mock.patch.object(server, "TASK_TIMEOUT_S", .06), \
             mock.patch.object(server, "_screen_signs", new=mock.AsyncMock(return_value=set())), \
             mock.patch.object(server, "_signs_after", new=mock.AsyncMock(return_value=set())), \
             mock.patch.object(server, "_errand_task", errand):
            task = dict(goal="read fixture", max_steps=4, payment_intent=None, app="千问", tier="fast")
            server._start("job-123456abcdef", task, "fixture title", "owner")
            await entered.wait()
            marker = json.loads(Path(self.folder.name, "job-123456abcdef.running.json").read_text())
            self.assertEqual(marker["trace"]["in_progress"]["waiting_for"], "model")
            await server._jobs["job-123456abcdef"]["task"]
        self.assertTrue(entered.is_set())
        path = Path(self.folder.name) / "job-123456abcdef.done.json"
        terminal = json.loads(path.read_text())
        self.assertEqual(terminal["terminal_reason"], "timed_out")
        trace = terminal["trace"]
        stalled = trace["in_progress"]
        self.assertEqual((stalled["index"], stalled["status"], stalled["waiting_for"]), (1, "stalled", "model"))
        self.assertGreater(stalled["model_wait_seconds"], .02)
        self.assertGreaterEqual(stalled["elapsed_seconds"], stalled["model_wait_seconds"])
        self.assertIsNone(stalled["ended_at"])
        self.assertNotIn("private", json.dumps(trace))
        self.assertEqual(terminal["title"], "fixture title")
        self.assertEqual(terminal["evidence_ref"], {"tool": "phone_status", "job_id": terminal["job_id"]})
        # A delayed child or parent can retrieve this job after the normal recent window.
        old = server.time.time() - server.RECENT_S - 10
        terminal["finished_at"] = datetime.fromtimestamp(old, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        path.write_text(json.dumps(terminal))
        self.assertEqual((await server.phone_status(principal_id="owner"))["jobs"], [])
        status = await server.phone_status(principal_id="owner", job_id=terminal["job_id"])
        self.assertEqual(status["jobs"][0]["trace"], trace)
        self.assertEqual((await server.phone_status(principal_id="other", job_id=terminal["job_id"]))["jobs"], [])

    async def test_self_check_lineage_survives_without_becoming_task_authority(self):
        async def errand(**kwargs):
            self.assertNotIn("self_check_of", kwargs)
            return {"success": False, "answer": "fixture failed"}
        with mock.patch.object(server, "_online", return_value=True), mock.patch.object(server, "_errand_task", errand):
            started = await server.phone_task("read fixture", principal_id="owner", self_check_of="failure-123",
                effect={"kind": "read", "task_type": "read", "requested": True})
            jid = started["job_id"]
            marker = json.loads(Path(self.folder.name, f"{jid}.running.json").read_text())
            self.assertEqual(marker["self_check_of"], "failure-123")
            await server._jobs[jid]["task"]
        terminal = json.loads(Path(self.folder.name, f"{jid}.done.json").read_text())
        self.assertEqual(terminal["self_check_of"], "failure-123")
        status = await server.phone_status(principal_id="owner", job_id=jid)
        self.assertEqual(status["jobs"][0]["self_check_of"], "failure-123")

    async def test_lifecycle_failure_keeps_self_check_lineage_from_each_public_tool(self):
        import agentbay_phone
        schemas = {tool.name: tool.inputSchema for tool in await server.mcp.list_tools()}
        tools = ((server.phone_start, {}), (server.phone_restore_apps, {"apps": ["千问"]}),
                 (server.phone_save_apps, {"apps": ["千问"]}), (server.phone_close, {}))
        for tool, kwargs in tools:
            with self.subTest(tool=tool.__name__), \
                 mock.patch.object(server, "PHONE_PROVIDER", "agentbay"), \
                 mock.patch.object(server, "_login_phone", None if tool == server.phone_start else object()), \
                 mock.patch.object(server, "_login_lease", None), \
                 mock.patch.object(server, "_phone_operation", new=mock.AsyncMock(side_effect=RuntimeError("fixture lifecycle failure"))), \
                 mock.patch.object(agentbay_phone, "progress"):
                self.assertIn("self_check_of", schemas[tool.__name__]["properties"])
                self.assertNotIn("self_check_of", schemas[tool.__name__].get("required", []))
                started = await tool(principal_id="owner", self_check_of="failure-lifecycle", **kwargs)
                jid = started["job_id"]
                marker = json.loads(Path(self.folder.name, f"{jid}.running.json").read_text())
                self.assertEqual(marker["self_check_of"], "failure-lifecycle")
                await server._jobs[jid]["task"]
                terminal = json.loads(Path(self.folder.name, f"{jid}.done.json").read_text())
                self.assertEqual(terminal["terminal_reason"], "failed")
                self.assertEqual(terminal["self_check_of"], "failure-lifecycle")
                self.assertIn("fixture lifecycle failure", terminal["answer"])
                with mock.patch.object(server, "PHONE_PROVIDER", ""):
                    status = await server.phone_status(principal_id="owner", job_id=jid)
                self.assertEqual(status["jobs"][0]["self_check_of"], "failure-lifecycle")

    async def test_native_action_result_preserves_measured_model_wait_and_app_failure(self):
        from step_trace import StepTrace, bind
        from mobilerun.agent.fast_agent.events import FastAgentToolCallEvent, FastAgentOutputEvent
        class ShortModel(ReasoningModel):
            @llm_chat_callback()
            async def achat(self, messages):
                await asyncio.sleep(.01)
                return ChatResponse(message=ChatMessage(role="assistant", content="private thought"))
        trace = StepTrace()
        bind(trace)
        trace.event(FastAgentInputEvent())
        await ShortModel().achat([])
        from mobilerun.agent.fast_agent.events import FastAgentResponseEvent
        trace.event(FastAgentResponseEvent(thought="private thought"))
        trace.event(FastAgentInputEvent())
        self.assertEqual(trace.snapshot()["steps"][0]["tool_result_status"], "no_action")
        await ShortModel().achat([])
        trace.event(FastAgentToolCallEvent(tool_calls_repr='<function_calls><invoke name="click">fixture</invoke></function_calls>'))
        waiting = trace.snapshot()["in_progress"]
        self.assertEqual((waiting["waiting_for"], waiting["action"]), ("app", "click"))
        self.assertGreater(waiting["model_wait_seconds"], .005)
        trace.event(FastAgentOutputEvent(output="<function_results><result><error>not found</error></result></function_results>"))
        result = trace.snapshot()
        self.assertIsNone(result["in_progress"])
        self.assertEqual(result["steps"][-1]["tool_result_status"], "failed")
        self.assertIsNotNone(result["steps"][-1]["ended_at"])
        self.assertNotIn("private thought", json.dumps(result))

    async def test_trace_bounds_results_and_restart_keeps_interrupted_step(self):
        from step_trace import StepTrace
        from mobilerun.agent.fast_agent.events import FastAgentToolCallEvent, FastAgentOutputEvent
        from mobilerun.agent.common.events import RecordUIStateEvent
        trace = StepTrace()
        for _ in range(40):
            trace.event(FastAgentInputEvent())
            trace.event(RecordUIStateEvent(ui_state=[{"text": "screen" * 1000}]))
            trace.event(FastAgentToolCallEvent(tool_calls_repr="tap(" + "x" * 1000 + ")"))
            trace.event(FastAgentOutputEvent(output="<result>" + "screen" * 1000 + "</result>"))
        trace.event(FastAgentInputEvent())
        snapshot = trace.snapshot()
        self.assertLessEqual(len(snapshot["steps"]), 32)
        self.assertGreater(snapshot["truncated_steps"], 0)
        self.assertLessEqual(len(snapshot["steps"][-1]["target"]), 160)
        self.assertLessEqual(len(snapshot["steps"][-1]["screen_text"]), 300)
        self.assertEqual(snapshot["in_progress"]["waiting_for"], "device")
        record = {"job_id": "job-abcdef123456", "principal_id": "owner", "task": "read",
                  "state": "running", "tier": "fast", "trace": snapshot}
        Path(self.folder.name, "job-abcdef123456.running.json").write_text(json.dumps(record))
        server._recover_interrupted()
        terminal = json.loads(Path(self.folder.name, "job-abcdef123456.done.json").read_text())
        snapshot["in_progress"]["status"] = "stalled"
        self.assertEqual(terminal["trace"], snapshot)
        self.assertEqual(terminal["evidence_ref"], {"tool": "phone_status", "job_id": terminal["job_id"]})


if __name__ == "__main__":
    unittest.main()
