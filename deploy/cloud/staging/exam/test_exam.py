"""Exercise the real harness through HTTP, disk artifacts and native-shaped SQLite."""
import contextlib
import datetime as dt
from datetime import date
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from accounting import delta, read_usage
from artifacts import collect as collect_artifact
from catalog import TASKS
from fake_hermes import FakeHermes
from fixtures import prepare
from hermes import Hermes, initialize_desktop, loopback_origin
from mail_fixture import Mailbox
from rubrics import evaluate, office
import run as exam
import capture

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import regression_effects


class ExamTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.data = self.root / "fixtures"
        prepare(self.data, date(2026, 10, 17))

    def config(self, fake):
        (self.root / "api.key").write_text("fixture-api")
        (self.root / "device.key").write_text("fixture-device")
        return {"exam_id": "ci-fixtures", "test_mode": True, "fixture_root": str(self.data),
                "profiles": {"owner": {"home": str(fake.home), "key_file": str(self.root / "api.key"), "origin": fake.origin}},
                "gateway_origin": fake.origin, "device_key_file": str(self.root / "device.key"),
                "observer_log": str(fake.log), "registry_root": str(fake.registry), "poll_s": 0.001, "timeout_s": 3}

    def execute(self, fake, selected=None, notification=None):
        with contextlib.redirect_stdout(io.StringIO()):
            return exam.run(self.config(fake), self.root / "report", selected, notification)

    def variant(self, name):
        self.root = Path(self.temporary.name) / name
        self.data = self.root / "fixtures"
        prepare(self.data, date(2026, 10, 17))

    def test_office_collection_uses_current_native_scope_and_refuses_unbound_files(self):
        workshop = self.root / 'workshop-out'
        token, unrelated = 'a' * 32, 'b' * 32
        for scope in (token, unrelated):
            (workshop / scope).mkdir(parents=True)
        source = workshop / token / 'organized.pptx'
        source.write_bytes(b'current task output')
        (workshop / unrelated / source.name).write_bytes(b'unrelated newer output')
        evidence = {'tools': [{'tool': 'terminal', 'args': {'command': 'echo "$OUT"'},
            'result': json.dumps({'exit_code': 0, 'error': None, 'output': '/owner/out/' + token + '\n'}),
            'id': 'native-call', 'session_id': 'native-session'}]}
        destination = self.data / 'outputs' / source.name
        for command, trailing in [('echo "$OUT"', ''), ('echo "$OUT"; ls /owner/in', 'inputs\n'),
                                  ('''printf '%s\\n' "$OUT"; pwd''', '/workshop\n')]:
            evidence['tools'][0]['args']['command'] = command
            evidence['tools'][0]['result'] = json.dumps({'exit_code': 0, 'error': None,
                'output': '/owner/out/' + token + '\n' + trailing})
            receipt = collect_artifact(evidence, workshop, destination)
            self.assertEqual(destination.read_bytes(), source.read_bytes())
            self.assertEqual(receipt['tool_call_id'], 'native-call')
        source.unlink()
        with self.assertRaisesRegex(ValueError, 'bound to this task'):
            collect_artifact(evidence, workshop, destination)
        source.symlink_to(workshop / unrelated / source.name)
        with self.assertRaisesRegex(ValueError, 'regular file'):
            collect_artifact(evidence, workshop, destination)

    def test_all_fourteen_and_manual_grade_cannot_accept_a_fake_release(self):
        with FakeHermes(self.root, self.data) as fake:
            report = self.execute(fake, notification="CI simulated owner notification")
            self.assertEqual(len(report["tasks"]), 14)
            for result in report["tasks"]:
                self.assertEqual(result["status"], "needs_review", result)
                evidence = exam.load(self.root / "report" / result["id"] / "evidence.json")
                self.assertTrue(evidence["tools"])
                self.assertIsNotNone(evidence["api_usage"])
            lifecycle = exam.load(self.root / "report/10-build/evidence.json")
            self.assertNotIn(lifecycle["reuse_session"], lifecycle["initial_sessions"])
            self.assertEqual(lifecycle["usage"]["totals"]["input_tokens"], 200)
            self.assertTrue(any("/v1/prompts" == path for path, _ in fake.requests))
            self.assertFalse(any("/v1/runs" == path for path, _ in fake.requests))
            reviews = {"run_id": report["run_id"], "tasks": {result["id"]: {
                "approved": True, "content_approved": True, "note": "Synthetic review for harness testing only",
                "evidence": [result["id"] + "/evidence.json"]} for result in report["tasks"]}}
            exam.write(self.root / "reviews.json", reviews)
            with contextlib.redirect_stdout(io.StringIO()):
                graded = exam.grade(self.root / "report", self.root / "reviews.json")
            self.assertTrue(all(result["status"] == "passed" for result in graded["tasks"]))
            self.assertFalse(graded["release_accepted"])
            if destination := os.environ.get("PAIOS_EXAM_TEST_OUT"):
                shutil.copytree(self.root / "report", destination, dirs_exist_ok=True)

    def test_ppt_sections_allow_continuation_pages_but_preserve_order_and_numbers(self):
        with FakeHermes(self.root, self.data) as fake:
            self.execute(fake, ["03-ppt"])
        evidence = exam.load(self.root / "report/03-ppt/evidence.json")
        seven = ["数据月报", "数据", "数据\n实际120，目标150", "结论", "结论\n仍需提升", "下一步", "下一步\n继续跟进"]
        cases = [(seven, True), (["数据", "120和150", "结论", "仍需提升", "下一步"], True),
                 (["数据\n120和150", "结论", "数据", "下一步"], False),
                 (["数据\n120和150", "下一步"], False),
                 (["数据\n1200和150", "结论", "下一步"], False),
                 (["数据\n120", "结论", "下一步"], False),
                 (["数据\n结论\n下一步\n120和150"], False)]
        for slides, expected in cases:
            with self.subTest(slides=slides), patch("rubrics.office", return_value=slides):
                self.assertEqual(evaluate(TASKS[2], evidence, self.data)["pptx"], expected)

    def test_gui_is_operator_run_without_owner_notification(self):
        with FakeHermes(self.root, self.data) as fake:
            report = self.execute(fake, ["01-dingtalk", "08-wechat"])
            self.assertEqual([task["status"] for task in report["tasks"]], ["operator-run", "operator-run"])
            self.assertEqual(fake.requests, [])

    def test_no_work_and_forbidden_attempts_fail(self):
        for fault in ("no_work", "external"):
            with self.subTest(fault=fault), FakeHermes(self.root, self.data) as fake:
                fake.fault = fault
                report = self.execute(fake, ["06-voice"])
                self.assertEqual(report["tasks"][0]["status"], "failed")
            shutil.rmtree(self.root / "report")
            shutil.rmtree(self.root / "home")

    def test_live_preflight_fails_before_network_or_credentials(self):
        with FakeHermes(self.root, self.data) as fake:
            config = self.config(fake)
            config.update(test_mode=False, hermes_pid=99999999)
            with self.assertRaises(FileNotFoundError):
                exam.run(config, self.root / "report")
            self.assertEqual(fake.requests, [])

    def test_origin_and_redirect_cannot_escape_to_production(self):
        for origin in ("https://production.test", "http://localhost:1", "http://127.0.0.1:1/path",
                       "http://fixture:secret@127.0.0.1:1", "http://127.0.0.1:1?x=1"):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                loopback_origin(origin)
        from hermes import NoRedirect
        with self.assertRaises(ValueError):
            NoRedirect().redirect_request(None, None, 302, "", {}, "https://production.test")

    def test_fresh_session_must_return_the_second_parcel(self):
        with FakeHermes(self.root, self.data) as fake:
            self.execute(fake, ["10-build"])
            evidence = exam.load(self.root / "report/10-build/evidence.json")
            evidence["reuse_output"] = "我会去查"
            checks = evaluate(TASKS[9], evidence, self.data)
            self.assertFalse(checks["reuse"])
            evidence["reuse_output"] = "已签收"
            for event in evidence["events"]:
                if event["kind"] == "parcel.v1":
                    event["session_id"] = evidence["session"]
            self.assertFalse(evaluate(TASKS[9], evidence, self.data)["reuse"])

    def test_observer_failure_aborts_instead_of_contaminating_the_next_task(self):
        with FakeHermes(self.root, self.data) as fake, patch("run.await_observer", side_effect=TimeoutError):
            report = self.execute(fake, ["10-build", "11-repair"])
            self.assertTrue(report["aborted"])
            self.assertEqual(len(report["tasks"]), 1)
            self.assertEqual(report["tasks"][0]["status"], "error")

    def test_artifacts_and_seed_dates_are_real_and_inputs_are_not_overwritten(self):
        text = office(self.data / "draft.docx", "docx")
        self.assertIn("周三", text)
        self.assertEqual(len(office(self.data / "inputs/monthly.pptx", "pptx")), 3)
        self.assertEqual(office(self.data / "inputs/budget.xlsx", "xlsx")["D2"]["f"], "B2+C2")
        truth = exam.load(self.data / "ground_truth.json")
        self.assertEqual(truth["seed"]["flight_date"], "2026-10-19")
        self.assertIsNone(truth["seed"]["ambient"]["audio_path"])
        self.assertEqual({path.name for path in (self.data / "inputs").iterdir()}, {"monthly.pptx", "budget.xlsx"})
        with self.assertRaises(FileExistsError):
            prepare(self.data)

    def test_review_cannot_override_automatic_failure_or_use_outside_evidence(self):
        with FakeHermes(self.root, self.data) as fake:
            fake.fault = "external"
            report = self.execute(fake, ["06-voice"])
            reviews = {"run_id": report["run_id"], "tasks": {"06-voice": {
                "approved": True, "note": "review", "evidence": ["06-voice/evidence.json"]}}}
            exam.write(self.root / "reviews.json", reviews)
            with contextlib.redirect_stdout(io.StringIO()):
                graded = exam.grade(self.root / "report", self.root / "reviews.json")
            self.assertEqual(graded["tasks"][0]["status"], "failed")
            reviews["tasks"]["06-voice"]["evidence"] = ["../../api.key"]
            exam.write(self.root / "reviews.json", reviews)
            with self.assertRaises(ValueError):
                exam.grade(self.root / "report", self.root / "reviews.json")

    def test_native_usage_resets_fail_and_model_costs_are_not_invented(self):
        key = ("exam", "configured-model", "provider", "base", "mode", "auxiliary")
        from accounting import COUNTERS
        before = {key: dict.fromkeys(COUNTERS, 2)}
        after = {key: dict.fromkeys(COUNTERS, 1)}
        with self.assertRaises(ValueError):
            delta(before, after, ["exam"])
        self.assertIsNone(delta({}, {}, ["exam"]))

    def test_real_imap_read_and_smtp_reply_are_captured_without_external_delivery(self):
        import imaplib
        import smtplib
        from email.message import EmailMessage
        events = []
        with Mailbox(self.data / "fixture.eml", events.append) as mailbox:
            with imaplib.IMAP4("127.0.0.1", mailbox.imap_port) as client:
                client.login("owner@example.test", "fixture-only")
                client.select("INBOX", readonly=True)
                status, ids = client.search(None, "ALL")
                self.assertEqual((status, ids), ("OK", [b"1"]))
                status, message = client.fetch(b"1", "(RFC822)")
                self.assertEqual(status, "OK")
                self.assertIn(b"exam-review@example.test", message[0][1])
                self.assertEqual(events[0]["kind"], "email.read")
            reply = EmailMessage()
            reply["From"], reply["To"] = "owner@example.test", "chenmo@example.test"
            reply["Subject"], reply["In-Reply-To"] = "Re: 项目评审", "<exam-review@example.test>"
            reply.set_content("周五15:00可以开会。")
            with smtplib.SMTP("127.0.0.1", mailbox.smtp_port) as client:
                client.login("owner@example.test", "fixture-only")
                client.send_message(reply)
                sent = next(event for event in events if event["kind"] == "email.sent")
                self.assertEqual(sent["data"]["to"], ["chenmo@example.test"])
                self.assertIn("15:00", sent["data"]["body"])
                self.assertEqual(client.mail("owner@example.test")[0], 250)
                self.assertEqual(client.rcpt("external@example.org")[0], 550)
                self.assertEqual(events[-1]["kind"], "external.attempt")

    def test_compressed_transcript_is_collected_by_native_lineage(self):
        with FakeHermes(self.root, self.data) as fake:
            original = fake.execute
            def rotated(body, run_id):
                original(body, run_id)
                conversation, transcript = body["session_id"], body["session_id"] + "-compressed"
                with sqlite3.connect(fake.database) as db:
                    db.execute("INSERT INTO sessions VALUES (?,?)", (transcript, conversation))
                    db.execute("UPDATE messages SET session_id=? WHERE session_id=?", (transcript, conversation))
                    db.execute("UPDATE session_model_usage SET session_id=? WHERE session_id=?", (transcript, conversation))
                body["session_id"] = transcript
            with patch.object(fake, "execute", side_effect=rotated):
                report = self.execute(fake, ["06-voice"])
            self.assertEqual(report["tasks"][0]["status"], "needs_review")
            evidence = exam.load(self.root / "report/06-voice/evidence.json")
            self.assertTrue(evidence["tools"][0]["session_id"].endswith("-compressed"))
            # Staging effects observe the sim client's run without submitting a second HTTP prompt.
            c = Hermes(fake.origin, "fixture-api", fake.database)
            before = list(fake.requests)
            receipt = {"run_id": evidence["turns"][0]["run_id"]}
            terminal = regression_effects.completed(c, receipt, evidence["session"])
            self.assertEqual(c.trace(terminal["transcript_sessions"])["tools"], evidence["tools"])
            self.assertEqual(fake.requests, before)
            with self.assertRaisesRegex(ValueError, "persisted conversation"):
                regression_effects.completed(c, receipt, "unrelated-conversation")
            fake.runs[receipt["run_id"]]["status"] = "failed"
            with self.assertRaisesRegex(ValueError, "did not complete"):
                regression_effects.completed(c, receipt, evidence["session"])


    def test_background_run_has_its_own_tools_and_accounting_bound_to_the_job(self):
        with FakeHermes(self.root, self.data) as fake:
            original = fake.execute
            def background(body, run_id):
                original(body, run_id)
                if not body["session_id"].endswith("-fresh"):
                    return
                session, child = body["session_id"], "paios-build-fixture"
                with sqlite3.connect(fake.database) as db:
                    db.execute("INSERT INTO sessions VALUES (?,NULL)", (child,))
                    db.execute("UPDATE messages SET session_id=? WHERE session_id=?", (child, session))
                    db.execute("INSERT INTO session_model_usage SELECT ?,model,billing_provider,billing_base_url,billing_mode,"
                        "task,api_call_count,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,"
                        "estimated_cost_usd,actual_cost_usd FROM session_model_usage WHERE session_id=?", (child, session))
                    calls = [{"id": "schedule", "function": {"name": "cronjob_manage", "arguments": '{"build":true}'}}]
                    db.execute("INSERT INTO messages(session_id,role,content,tool_calls) VALUES (?,'assistant','',?)", (session, json.dumps(calls)))
                    db.execute("INSERT INTO messages(session_id,role,content,tool_call_id) VALUES (?,'tool',?,'schedule')", (session, '{"job_id":"fixture-job"}'))
                fake.runs["background-run"] = {"run_id": "background-run", "session_id": child, "status": "completed",
                    "output": body["output"], "usage": body["usage"]}
                with fake.log.open("a") as log:
                    log.write(json.dumps({"kind": "background.completed", "task_id": "10-build", "session_id": session,
                        "profile": "owner", "foreground_run_id": run_id, "job_id": "fixture-job", "occurrence_id": "one",
                        "run_id": "background-run", "session_ids": [child]}) + "\n")
            with patch.object(fake, "execute", side_effect=background):
                report = self.execute(fake, ["10-build"])
            self.assertEqual(report["tasks"][0]["status"], "needs_review", report)
            self.assertEqual(report["tasks"][0]["usage"]["totals"]["input_tokens"], 300)
            evidence = exam.load(self.root / "report/10-build/evidence.json")
            self.assertTrue(any(call["session_id"] == "paios-build-fixture" for call in evidence["tools"]))
            self.assertIn("paios-build-fixture", evidence["reuse_transcripts"])
            evidence["tools"].append({"session_id": "paios-build-fixture", "tool": "skill_manage",
                                      "args": {"action": "create"}, "result": '{"success":true}'})
            self.assertFalse(evaluate(TASKS[9], evidence, self.data)["reuse"])
            first = evidence["turns"][0]
            replay = {"kind": "background.completed", "foreground_run_id": first["run_id"], "profile": "owner",
                      "job_id": "fixture-job", "occurrence_id": "one", "run_id": first["run_id"],
                      "session_ids": [first["session_id"]]}
            clients, _ = exam.make_clients(self.config(fake))
            with self.assertRaises(ValueError):
                capture.background_evidence([replay], clients, [first["run_id"]], {"owner": 0})

    def test_capture_closure_requires_native_completion_and_five_proof_files(self):
        with FakeHermes(self.root, self.data) as fake:
            self.execute(fake, ["06-voice"])
            evidence = exam.load(self.root / "report/06-voice/evidence.json")
            active = {"task_id": "06-voice", "session_id": evidence["session"], "message_after": 0,
                      "admission": evidence["admissions"][0]["admission"]}
            clients, _ = exam.make_clients(self.config(fake))
            with self.assertRaises(ValueError):
                capture.close(active, clients, fake.log, {})
            proofs = {}
            for field in capture.CHECKED:
                path = self.root / "report/observations" / (field + ".txt")
                path.write_text("Synthetic independent fixture observation")
                proofs[field] = str(path)
            record = capture.close(active, clients, fake.log, proofs)
            self.assertEqual(record["kind"], "observer.closed")
            self.assertEqual(set(record["checked"]), set(capture.CHECKED))
            run_id = active["admission"]["run_id"]
            fake.runs[run_id]["status"] = "running"
            with self.assertRaises(ValueError):
                capture.close(active, clients, fake.log, proofs)

    def test_live_binding_rejects_a_different_loopback_service_before_requests(self):
        with FakeHermes(self.root, self.data) as fake:
            config = self.config(fake)
            config.update(test_mode=False, hermes_pid=99999999, isolation_receipt=str(self.root / "isolation.json"))
            for name in ("network", "observers"):
                (self.root / name).write_text("Independently captured fixture isolation evidence")
            receipt = {"exam_id": config["exam_id"], "stage": "staging", "hermes_home": str(fake.home),
                "fixture_root": str(self.data), "hermes_origin": fake.origin, "gateway_origin": fake.origin,
                "external_effects": "blocked", "fixture_only": True,
                "expires_at": (exam.dt.datetime.now(exam.dt.timezone.utc) + exam.dt.timedelta(hours=1)).isoformat(),
                "network_evidence": str(self.root / "network"), "observer_evidence": str(self.root / "observers")}
            exam.write(config["isolation_receipt"], receipt)
            original = Path.read_text
            def process(path, *args, **kwargs):
                if str(path) == "/proc/99999999/environ":
                    port = fake.origin.rsplit(":", 1)[-1]
                    return f"PAIOS_STAGE=staging\0HERMES_HOME={fake.home}\0API_SERVER_PORT={port}\0PAIOS_INTEGRATION_PORT={port}\0PAIOS_HERMES_INTERNAL_KEY=fixture-api\0"
                if str(path) == "/proc/99999999/cmdline":
                    return "/opt/paios/integrations/hermes/personal_aios/run_api.py"
                return original(path, *args, **kwargs)
            with patch.object(Path, "read_text", process):
                self.assertEqual(exam.preflight(config), receipt)
                initialized = exam.preflight(config, desktop=True)
                self.assertEqual(initialized["desktop_mcp"]["serverInfo"]["name"], "paios-desktop")
                self.assertEqual(initialized["desktop_mcp"]["list_allowed_directories"]["structuredContent"],
                                 {"directories": []})
                self.assertEqual([body.get("method") for _, body in fake.requests[:-1]],
                                 ["initialize", "notifications/initialized", "tools/call"])
                self.assertEqual(fake.requests[-1], ("/internal/desktop/mcp", {"session": "fixture-desktop"}))
                fake.fault = "desktop_offline"
                with self.assertRaisesRegex(ValueError, "DESKTOP_OFFLINE"):
                    exam.preflight(config, desktop=True)
                self.assertEqual(fake.requests[-1], ("/internal/desktop/mcp", {"session": "fixture-desktop"}))
                fake.fault = "desktop_401"
                with self.assertRaises(HTTPError) as rejected:
                    exam.preflight(config, desktop=True)
                self.assertEqual(rejected.exception.code, 401)
                self.assertEqual(json.load(rejected.exception)["error_code"], "SOURCE_HOST_CREDENTIAL_REQUIRED")
                config["gateway_origin"] = "http://127.0.0.1:1"
                with self.assertRaises(ValueError):
                    exam.preflight(config)
            self.assertTrue(all(path == "/internal/desktop/mcp" for path, _ in fake.requests))

    def test_desktop_requires_a_successful_tool_payload(self):
        with FakeHermes(self.root, self.data) as fake:
            fake.fault = "desktop_missing_result"
            with self.assertRaisesRegex(ValueError, "list_allowed_directories failed"):
                initialize_desktop(fake.origin, "fixture-api")
            self.assertEqual(fake.requests[-1], ("/internal/desktop/mcp", {"session": "fixture-desktop"}))

    def test_revert_does_not_ignore_typescript_or_binary_tool_resources(self):
        with FakeHermes(self.root, self.data) as fake:
            script, resource = fake.registry / "query.ts", fake.registry / "resource.bin"
            script.write_text("export const version = 1;")
            resource.write_bytes(b"\x00\xff\x01")
            original = fake.execute
            def leave_unreverted_sources(body, run_id):
                active = exam.load(self.root / "report/active.json")
                if active["task_id"] == "11-repair":
                    script.write_text("export const version = 2;")
                    resource.write_bytes(b"\x00\xff\x02")
                original(body, run_id)
            with patch.object(fake, "execute", side_effect=leave_unreverted_sources):
                report = self.execute(fake, ["10-build", "11-repair", "12-revert"])
            self.assertEqual(report["tasks"][-1]["status"], "failed", report)
            self.assertFalse(report["tasks"][-1]["checks"]["registry.reverted"])


    def test_missing_or_repeated_send_confirmation_fails(self):
        for task in ("01-dingtalk", "02-email"):
            for fault in ("no_confirmation", "repeat_confirmation"):
                with self.subTest(task=task, fault=fault):
                    self.variant(task + fault)
                    with FakeHermes(self.root, self.data) as fake:
                        fake.fault = fault
                        result = self.execute(fake, [task], "fixture notification")["tasks"][0]
                        self.assertEqual(result["status"], "failed")
                        self.assertFalse(result["checks"]["remembered_scope"])

    def test_dingtalk_content_and_delivery_are_graded_separately(self):
        for fault, content, delivery in (("bad_content", False, True), ("wrong_delivery", True, False),
                                         ("wrong_attachment", True, False), (None, True, True)):
            with self.subTest(fault=fault):
                self.variant(str(fault))
                with FakeHermes(self.root, self.data) as fake:
                    fake.fault = fault
                    report = self.execute(fake, ["01-dingtalk"], "fixture notification")
                    result = report["tasks"][0]
                    self.assertEqual(result["checks"]["content"], content)
                    self.assertEqual(result["checks"]["delivery"], delivery)
                    review = {"run_id": report["run_id"], "tasks": {"01-dingtalk": {
                        "approved": True, "note": "Synthetic content review", "evidence": ["01-dingtalk/evidence.json"]}}}
                    exam.write(self.root / "review.json", review)
                    with contextlib.redirect_stdout(io.StringIO()):
                        graded = exam.grade(self.root / "report", self.root / "review.json")
                    self.assertEqual(graded["tasks"][0]["status"], "needs_review" if fault is None else "failed")

    def test_standing_watches_use_native_producer_and_persist_checkpoints(self):
        with FakeHermes(self.root, self.data) as fake:
            result = self.execute(fake, ["14-watches"])["tasks"][0]
            self.assertEqual(result["status"], "needs_review", result)
            evidence = exam.load(self.root / "report/14-watches/evidence.json")
            self.assertEqual([s["stage"] for s in evidence["watch_stages"]], ["pending", "hangup", "arrived", "restart", "repeated"])
            self.assertIn("personal_aios/watch.py", fake.watch_binding)
            self.assertEqual(result["usage"]["totals"]["input_tokens"], 1100)
            self.assertEqual(len([e for e in evidence["events"] if e["kind"] == "owner.notified"]), 2)
            final = evidence["watch_stages"][-1]["jobs"]
            self.assertTrue(all(job["standing_watch"]["delivered_sequence"] == 1 for job in final.values()))

    def test_query_only_lost_restart_and_duplicate_watch_delivery_fail(self):
        for fault in ("watch_no_check", "watch_lost_restart", "watch_duplicate"):
            with self.subTest(fault=fault):
                self.variant(fault)
                with FakeHermes(self.root, self.data) as fake:
                    fake.fault = fault
                    result = self.execute(fake, ["14-watches"])["tasks"][0]
                    self.assertEqual(result["status"], "failed", result)
                    self.assertFalse(result["checks"]["watch.once"])

    def test_late_traffic_and_calendar_cannot_pass_the_watch(self):
        with FakeHermes(self.root, self.data) as fake:
            self.execute(fake, ["14-watches"])
            evidence = exam.load(self.root / "report/14-watches/evidence.json")
            traffic = next(e for e in evidence["events"] if e["kind"] == "owner.notified" and e["data"]["watch_kind"] == "traffic")
            traffic["at"] = dt.datetime.fromisoformat(evidence["watch_departure_at"]).timestamp() + 1
            self.assertFalse(evaluate(TASKS[13], evidence, self.data)["watch.traffic"])
            evidence = exam.load(self.root / "report/14-watches/evidence.json")
            evidence["tools"].append({"tool": "calendar_create", "args": {}, "result": '{"success":true}'})
            self.assertFalse(evaluate(TASKS[13], evidence, self.data)["watch.once"])

    def test_watch_cannot_relabel_an_old_run_or_scheduled_occurrence(self):
        with FakeHermes(self.root, self.data) as fake:
            self.execute(fake, ["14-watches"])
            retained = self.root / "report/14-watches/evidence.json"
            evidence = exam.load(retained)
            event = next(e for e in evidence["watch_stages"][0]["events"] if e["kind"] == "background.completed")
            clients = {"owner": Hermes(fake.origin, "fixture-api", fake.database)}
            wrong = json.loads(json.dumps(event))
            wrong["occurrence_id"] = "a-different-occurrence"
            with self.assertRaises(ValueError):
                capture.background_evidence([wrong], clients, [evidence["turns"][0]["run_id"]], {"owner": 0}, scheduled=True)
            for field in ("job_id", "occurrence_id", "run_id"):
                damaged = exam.load(retained)
                receipt = next(e for e in damaged["watch_stages"][0]["events"] if e["kind"] == "background.completed")
                receipt[field] = "stale-or-unrelated"
                self.assertFalse(evaluate(TASKS[13], damaged, self.data)["watch.lifecycle"])
            event["scheduled_admission"]["response"]["scheduled_captured_at"] = "2000-01-01T00:00:00+00:00"
            self.assertFalse(evaluate(TASKS[13], evidence, self.data)["watch.lifecycle"])

    def test_watch_capture_requires_both_jobs_and_a_different_restart_pid(self):
        with FakeHermes(self.root, self.data) as fake:
            self.execute(fake, ["14-watches"])
            evidence = exam.load(self.root / "report/14-watches/evidence.json")
            clients = {"owner": Hermes(fake.origin, "fixture-api", fake.database)}
            active = {"task_id": "14-watches", "session_id": evidence["session"], "watch_stage": "restart",
                      "watch_jobs": evidence["watch_jobs"], "admission": {"run_id": evidence["turns"][0]["run_id"]},
                      "hermes_pid": 1000}
            proofs = {}
            for field in capture.CHECKED:
                path = self.root / "report" / (field + ".txt")
                path.write_text("Retained synthetic observation")
                proofs[field] = str(path)
            with self.assertRaises(ValueError):
                capture.close_watch(active, self.config(fake), clients, fake.log, proofs, 1000)
            active["watch_jobs"] = {"parcel": "missing-job"}
            with self.assertRaises(ValueError):
                capture.close_watch(active, self.config(fake), clients, fake.log, proofs, 1001)


if __name__ == "__main__":
    unittest.main()
