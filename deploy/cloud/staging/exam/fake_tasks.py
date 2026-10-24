"""Synthetic task behavior behind the fake native HTTP boundary."""
import json
import sqlite3
import time
from urllib.request import ProxyHandler, build_opener
from urllib.error import HTTPError
from zipfile import ZipFile, ZIP_DEFLATED

def revise(source, destination, replacements):
    with ZipFile(source) as original, ZipFile(destination, "w", ZIP_DEFLATED) as result:
        for name in original.namelist():
            text = original.read(name).decode()
            for old, new in replacements:
                text = text.replace(old, new)
            result.writestr(name, text)


def execute(self, body, run_id):
    active = json.loads((self.root / "report/active.json").read_text())
    task, reuse = active["task_id"], active.get("stage") in {"reuse", "restored"}
    service = active["fixture_origin"]
    session, text = body["session_id"], body["text"]
    events, calls = [], []
    def call(name, args=None, result=None):
        source = {"06-voice": "exam-confirmed-voice-records", "07-memory": "exam-call-record",
                  "08-wechat": "exam-wechat-record", "13-recap": "exam-ambient-record"}.get(task)
        calls.append((name, args or {}, result or {"success": True, "source": source}))
    def fetch(path):
        with build_opener(ProxyHandler({})).open(service + path) as response:
            return json.load(response)
    output = "处理完成"
    repeat_send = active.get("stage") == "consent-reuse"
    recipient = {"01-dingtalk": "exam-chenmo", "02-email": "chenmo@example.test"}.get(task)
    scope = {"kind": "send", "recipient": recipient, "task_type": task}
    if recipient and text.startswith("是，确认"):
        self.send_scopes.add((recipient, task))
    asking = bool(recipient and self.fault != "no_confirmation" and
                  ((recipient, task) not in self.send_scopes or self.fault == "repeat_confirmation" and repeat_send))
    source, out = self.fixtures / "inputs", self.fixtures / "outputs"
    tool = self.registry / "parcel/SKILL.md"
    if asking:
        call("paios_terminal_question", {"question": "确认发送给" + recipient + "吗？"})
        events.append({"kind": "send.confirmation.requested", "data": {
            "channel": "owner_prompt", "request_id": "question-" + run_id, "run_id": run_id, "scope": scope}})
        output = "请确认发送给" + recipient + "。"
    elif task == "01-dingtalk":
        call("mcp__owner_mac__exec")
        if not repeat_send:
            revise(self.fixtures / "draft.docx", out / "revised.docx", [] if self.fault == "bad_content" else [("周三", "周五")])
            events.append("dingtalk.received")
        events.append("dingtalk.sent")
    elif task == "02-email":
        call("imap_read")
        events.extend(("email.read", "email.sent"))
    elif task == "03-ppt":
        call("terminal")
        revise(source / "monthly.pptx", out / "organized.pptx", [("r:id=\"rId1\"", "r:id=\"swap\""),
            ("r:id=\"rId2\"", "r:id=\"rId1\""), ("r:id=\"swap\"", "r:id=\"rId2\"")])
    elif task == "04-excel":
        call("terminal")
        revise(source / "budget.xlsx", out / "corrected.xlsx", [("B2+C2", "B2*C2"), ("B3+C3", "B3*C3"), ("SUM(D2:D2)", "SUM(D2:D3)")])
    elif task == "05-flights":
        call("skills_list")
        date = json.loads((self.fixtures / "ground_truth.json").read_text())["seed"]["flight_date"]
        fetch("/flights?date=" + date)
        output = date + " EX101 09:00 450元含税"
    elif task == "06-voice":
        call("mcp__self__runtime_query")
        output = "20个已确认样本，18个正确，90%；未确认样本不能算准确率。"
    elif task == "07-memory":
        call("paios_l3_search")
        output = "昨天和陈默讨论设计评审，约定周五15:00开会。"
    elif task == "08-wechat":
        call("mcp__owner_mac__exec")
        output = "李青问明天10:00会议。我拟的回复：可以，明天10:00见。"
        events.append("wechat.read")
    elif task == "09-food":
        call("mcp_phone_task", {"app": "千问"})
        events.append("food.checkpoint")
    elif task in {"10-build", "11-repair", "12-revert"}:
        if task == "10-build" and not reuse:
            call("skills_list")
            call("skill_manage", {"action": "create"})
            tool.parent.mkdir(exist_ok=True)
            tool.write_text("parcel version 1")
        if task == "11-repair":
            try:
                fetch("/parcel/EXAM001")
            except HTTPError as error:
                if error.code != 410:
                    raise
            tool.write_text("parcel version 2")
        if task == "12-revert" and not reuse:
            tool.write_text("parcel version 1")
        else:
            value = fetch(("/v2/parcels/" if task == "11-repair" else "/parcel/") +
                          ("EXAM002" if task == "10-build" and reuse else "EXAM001"))
            output = value.get("status") or value["parcel"]["latest"]["description"]
        call("terminal")
    elif task == "14-watches":
        from fake_watch import create
        calls.extend(create(self, service, session, run_id, active["watch_departure_at"]))
        output = "已设置快递和路况的原生持续监测。"
    else:
        call("paios_l3_search")
        output = "主人提议周五15:00评审，林舟同意，并说周四前发预算；主人说今晚发草案。"
    if self.fault == "no_work":
        calls, events = [], []
    if self.fault == "external":
        events.append("external.attempt")
    with sqlite3.connect(self.database) as db:
        db.execute("INSERT OR IGNORE INTO sessions VALUES (?,NULL)", (session,))
        for index, (name, args, result) in enumerate(calls):
            cid = run_id + "-" + str(index)
            db.execute("INSERT INTO messages(session_id,role,content,tool_calls) VALUES (?,'assistant','',?)", (session,
                json.dumps([{"id": cid, "function": {"name": name, "arguments": json.dumps(args)}}])))
            db.execute("INSERT INTO messages(session_id,role,content,tool_call_id) VALUES (?,'tool',?,?)", (session, json.dumps(result), cid))
        db.execute("INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET "
            "api_call_count=api_call_count+1,input_tokens=input_tokens+100,output_tokens=output_tokens+20",
            (session, "fixture-model", "fixture", "fixture", "test", "main", 1, 100, 20, 0, 0, 0, 0, 0))
    with self.log.open("a") as log:
        for item in events + (["observer.closed"] if not asking or repeat_send else []):
            kind = item if isinstance(item, str) else item["kind"]
            data = {"email.read": {"account": "owner@example.test", "message_id": "<exam-review@example.test>"},
                    "email.sent": {"to": ["chenmo@example.test"], "in_reply_to": "<exam-review@example.test>",
                                  "subject": "Re: 项目评审", "body": "周五15:00可以"},
                    "dingtalk.sent": {"conversation": "exam-chenmo", "recipient": "wrong-person" if self.fault == "wrong_delivery" else "exam-chenmo", "filename": "revised.docx"},
                    "dingtalk.received": {"conversation": "exam-chenmo", "filename": "draft.docx"},
                    "food.checkpoint": {"app": "千问", "item": "番茄鸡蛋饭", "address": "fixture-only",
                                        "payment_state": "awaiting_confirmation", "paid": False}}.get(kind, {})
            if kind == "dingtalk.sent":
                attachment = self.root / "report" / task / ("received-" + run_id + "-revised.docx")
                payload = self.fixtures / "draft.docx" if self.fault == "wrong_attachment" else out / "revised.docx"
                attachment.write_bytes(payload.read_bytes())
                data["attachment_path"] = str(attachment)
            log.write(json.dumps({"task_id": task, "session_id": session, "kind": kind, "data": data,
                "at": time.time(), "stage": active.get("stage", "initial"), **(item if isinstance(item, dict) else {}),
                "checked": ["network", "messages", "payments", "files", "background"]}) + "\n")
    body.update(run_id=run_id, status="completed", output=output, conversation_session_id=session,
                usage={"input_tokens": 100, "output_tokens": 20, "total_tokens": 120,
                       "cache_read_tokens": 0, "cache_write_tokens": 0})
