"""Focused consent evidence tests; no model, server, or product state required."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from consent import ANSWERED, REQUESTED, SendConsent, consent_checks


class ConsentTests(unittest.TestCase):
    def setUp(self):
        self.scope = {"principal_id": "owner", "kind": "send", "recipient": "chenmo@example.test",
                      "task_type": "review_reply"}
        self.data = {"request_id": "question-1", "run_id": "run-1", "scope": self.scope,
                     "channel": "native_approval"}
        self.events = [self.event(REQUESTED, 1, self.data),
                       self.event(ANSWERED, 2, {**self.data, "choice": "once", "resolved": 1}),
                       self.event("email.sent", 3, {"to": ["chenmo@example.test"]}),
                       self.event("email.sent", 4, {"to": ["chenmo@example.test"]}, "reuse")]

    def event(self, kind, at, data, session="first"):
        return {"kind": kind, "task_id": "02-email", "session_id": session, "at": at, "data": deepcopy(data)}

    def check(self, events=None, admissions=None):
        return consent_checks(self.events if events is None else events, "first", "reuse",
                              "chenmo@example.test", "email.sent", admissions)

    def test_timestamps_not_list_order(self):
        self.assertTrue(all(self.check(list(reversed(self.events))).values()))

    def test_missing_and_late_confirmation(self):
        self.assertFalse(any(self.check(self.events[1:]).values()))
        self.events[1]["at"] = 3.5
        self.assertFalse(any(self.check().values()))

    def test_reuse_request_and_answer_are_rejected(self):
        for kind in (REQUESTED, ANSWERED):
            with self.subTest(kind=kind):
                extra = self.event(kind, 3.5, self.data, "reuse")
                self.assertFalse(self.check(self.events + [extra])["remembered_scope"])

    def test_wrong_recipient_kind_task_or_observed_scope(self):
        for field, value in (("recipient", "other@example.test"), ("task_type", "other")):
            with self.subTest(field=field):
                events = deepcopy(self.events)
                events[3]["data"]["scope"] = {**self.scope, field: value}
                self.assertFalse(any(self.check(events).values()))
        for path, value in (("kind", "dingtalk.sent"), ("task_id", "different-task")):
            events = deepcopy(self.events)
            events[3][path] = value
            self.assertFalse(any(self.check(events).values()))
        self.events[3]["data"]["to"] = ["other@example.test"]
        self.assertFalse(any(self.check().values()))

    def test_owner_prompt_requires_exact_native_admission(self):
        for event in self.events[:2]:
            event["data"]["channel"] = "owner_prompt"
        self.events[1]["data"].update(response_processed_event_id="owner-yes", response_run_id="run-yes")
        admission = {"processed_event": {"processed_event_id": "owner-yes", "origin": "explicit_user_prompt"},
                     "admission": {"run_id": "run-yes"}}
        self.assertFalse(any(self.check().values()))
        self.assertTrue(all(self.check(admissions=[admission]).values()))
        admission["admission"]["run_id"] = "wrong-run"
        self.assertFalse(any(self.check(admissions=[admission]).values()))

    def test_native_answer_is_exact_and_zero_resolution_is_not_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "observed.jsonl"
            log.write_text(json.dumps(self.events[0]) + "\n")
            captured, calls = [], []
            status = {"run_id": "run-1", "status": "waiting_for_approval", "approval": {"request_id": "question-1"}}
            class Client:
                resolved = 0

                def request(self, path, body):
                    calls.append((path, body))
                    return {"run_id": "run-1", "request_id": body["request_id"],
                            "choice": body["choice"], "resolved": self.resolved}
            client = Client()
            consent = SendConsent(log, "02-email", "chenmo@example.test", captured.append)
            self.assertFalse(consent.respond(client, {**status, "approval": {"request_id": "unknown"}}, "first"))
            self.assertEqual(calls, [])
            with self.assertRaises(ValueError):
                consent.respond(client, status, "first")
            self.assertEqual(captured, [])
            client.resolved = 1
            self.assertTrue(consent.respond(client, status, "first"))
            self.assertEqual(calls[-1], ("/v1/runs/run-1/approval", {"choice": "once", "request_id": "question-1"}))
            self.assertEqual(captured[0]["data"]["scope"], self.scope)
            self.assertFalse(consent.respond(client, status, "first"))

    def test_question_consumed_only_after_completed_matching_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "observed.jsonl"
            self.events[0]["data"]["channel"] = "owner_prompt"
            log.write_text(json.dumps(self.events[0]) + "\n")
            consent = SendConsent(log, "02-email", "chenmo@example.test", lambda event: None)
            self.assertIsNone(consent.question({"run_id": "run-1", "status": "running"}, "first"))
            self.assertIsNone(consent.question({"run_id": "wrong", "status": "completed"}, "first"))
            status = {"run_id": "run-1", "status": "completed"}
            self.assertEqual(consent.question(status, "first"), self.events[0])
            self.assertIsNone(consent.question(status, "first"))


if __name__ == "__main__":
    unittest.main()
