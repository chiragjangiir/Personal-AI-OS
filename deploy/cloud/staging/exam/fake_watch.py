"""CI boundary around the real standing-watch producer; never a second watcher."""
from contextlib import contextmanager
import base64
import datetime as dt
import json
from pathlib import Path
import sqlite3
import sys
import time
from types import ModuleType, SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlencode, urlsplit
from urllib.request import ProxyHandler, build_opener
import uuid


def producer(fake):
    root = Path(__file__).resolve().parents[4]
    path = root / "integrations/hermes/personal_aios/watch.py"
    if hasattr(fake, "watch_source"):
        source, binding = fake.watch_source, fake.watch_binding
    else:
        # The integrated producer only; a missing file is a broken tree, not a reason to read another branch.
        source, binding = path.read_text(), str(path)
    module = ModuleType("_exam_watch_native.watch")
    module.__package__ = "_exam_watch_native"
    exec(compile(source, binding, "exec"), module.__dict__)
    fake.watch_binding = binding
    fake.watch_source = source
    return module


def jobs_path(fake):
    return Path(fake.home) / "cron/jobs.json"


def read_jobs(fake):
    return json.loads(jobs_path(fake).read_text())["jobs"]


def save_jobs(fake, jobs):
    path = jobs_path(fake)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"jobs": jobs}, ensure_ascii=False) + "\n")
    temporary.replace(path)


def record(fake, active, kind, **fields):
    with Path(fake.log).open("a") as log:
        log.write(json.dumps({"task_id": active["task_id"], "session_id": active["session_id"],
                              "kind": kind, "at": time.time(), **fields}, ensure_ascii=False) + "\n")


def create(fake, origin, session, run_id, departure_at):
    native = producer(fake)
    existing = read_jobs(fake) if jobs_path(fake).exists() else []
    calls = []
    for kind, before, after, message in (("parcel", "pending", "arrived", "包裹到了"),
                                         ("traffic", "clear", "congested", "路上有点堵，早点出门")):
        watch = {"query_tool": "fixture_" + kind + "_query", "query_args": {"url": origin + "/watch/" + kind},
                 "status_field": "status", "from_status": before, "to_status": after, "message": message}
        if kind == "traffic":
            watch["query_args"]["departure_at"] = departure_at
        args = {"action": "create", "name": "exam-" + kind + "-watch", "schedule": "every 1m",
                "standing_watch": watch}
        job_id = "exam-" + kind + "-" + uuid.uuid4().hex[:10]
        owner = {"principal_id": "fixture-owner", "device_id": "fixture-phone"}
        job = {"id": job_id, "name": args["name"], "enabled": True, "state": "scheduled",
               "schedule": {"kind": "interval", "minutes": 1}, "schedule_display": "every 1m",
               "deliver": "personal_aios:" + base64.urlsafe_b64encode(json.dumps(owner).encode()).decode(),
               "script": "personal-aios-task.py", "no_agent": True,
               "prompt": "Run paios_watch_check and remain silent; it owns transition notification.",
               "standing_watch": native.definition(watch)}
        existing.append(job)
        calls.append(("cronjob_manage", args, {"success": True, "job_id": job_id, "name": job["name"],
                     "job": {"job_id": job_id, "enabled": True}, "producer_binding": fake.watch_binding}))
    save_jobs(fake, existing)
    return calls


@contextmanager
def native_boundary(fake, active, job_id, notify):
    def get_job(identifier):
        return next((job for job in read_jobs(fake) if job["id"] == identifier), None)

    def update_job(identifier, changes):
        jobs = read_jobs(fake)
        job = next((job for job in jobs if job["id"] == identifier), None)
        if job is not None:
            job.update(changes)
            save_jobs(fake, jobs)
        return job

    @contextmanager
    def lock(*args):
        yield True

    def query(name, args, **kwargs):
        url = args["url"]
        origin = urlsplit(active["fixture_origin"])
        target = urlsplit(url)
        if (origin.scheme != "http" or origin.hostname != "127.0.0.1" or not origin.port
                or (target.scheme, target.netloc) != (origin.scheme, origin.netloc)):
            raise ValueError("Fake watch queries require the owned numeric-loopback fixture")
        extra = {key: value for key, value in args.items() if key != "url"}
        if extra:
            url += "?" + urlencode(extra)
        with build_opener(ProxyHandler({})).open(url, timeout=5) as response:
            return json.load(response)

    def request(path, body):
        if path.endswith("schedule-context"):
            response = {"principal_id": "fixture-owner", "scheduled_job_id": job_id,
                        "scheduled_occurrence_id": active["watch_occurrence_id"],
                        "scheduled_captured_at": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
                        "origin_processed_event_id": "watch-event-" + uuid.uuid4().hex}
            active["schedule_context_receipt"].update(context=body["context"], response=response.copy())
            return response
        if path.endswith("scheduled-delivery"):
            notify(body)
            return {"status": "delivered"}
        raise ValueError("Unexpected native watch fixture boundary")

    modules = {}
    for name, attributes in {
        "cron.jobs": {"get_job": get_job, "update_job": update_job, "_jobs_lock": lock, "_fire_job_lock": lock},
        "gateway.session_context": {"get_api_run_id": lambda session: active["admission"]["run_id"]},
        "tools.approval_context": {"_approval_tool_call_id": SimpleNamespace(get=lambda: active["watch_tool_call_id"])},
        "tools.personal_aios_dispatch": {"dispatch_nested_tool": query},
        "_exam_watch_native.cron": {"job_owner": lambda job: json.loads(base64.urlsafe_b64decode(job["deliver"].split(":", 1)[1]))},
    }.items():
        module = modules[name] = ModuleType(name)
        module.__dict__.update(attributes)
    with patch.dict(sys.modules, modules):
        yield SimpleNamespace(_request=request)


def stage(fake, active):
    phase = active["watch_stage"]
    if phase not in {"pending", "hangup", "arrived", "restart", "repeated"}:
        raise ValueError("Unknown fake watch stage")
    native = producer(fake)
    if phase == "hangup":
        record(fake, active, "watch.hangup", synthetic=True, stage=phase,
               data={"call_id": "fixture-call", "from_state": "active", "state": "ended"})
    if phase == "restart":
        record(fake, active, "watch.restart", synthetic=True, stage=phase,
               data={"before_pid": 1000, "after_pid": 1001, "hermes_home": str(fake.home), "verified": True})
    fault = getattr(fake, "fault", None)
    if phase == "restart" and fault == "watch_lost_restart":
        save_jobs(fake, [])
    skip = fault == "watch_no_check" or fault == "watch_lost_restart" and phase in {"restart", "repeated"}
    for kind, job_id in (() if skip else active["watch_jobs"].items()):
        run_id = "watch-run-" + uuid.uuid4().hex
        session = "cron:" + job_id
        occurrence = "fixture-" + phase + "-" + uuid.uuid4().hex
        def notify(body):
            record(fake, active, "owner.notified", stage=phase, synthetic=True, data={"job_id": job_id,
                   "notification_id": body["id"], "text": body["text"], "watch_kind": kind,
                   "surface": "glasses_card" if kind == "traffic" else "notification"})
        handlers = []
        cid, admission = run_id + "-check", {}
        scheduled = {**active, "admission": {"run_id": run_id}, "watch_tool_call_id": cid,
                     "watch_occurrence_id": occurrence, "schedule_context_receipt": admission}
        with native_boundary(fake, scheduled, job_id, notify) as provider:
            native.register(SimpleNamespace(register_tool=lambda *args: handlers.append(args[3]) or True), provider)
            result = json.loads(handlers[0]({}, session_id=session))
        if phase == "repeated" and fault == "watch_duplicate":
            job = next(job for job in read_jobs(fake) if job["id"] == job_id)
            notify({"id": "watch:" + job_id + ":1", "text": job["standing_watch"]["definition"]["message"]})
        with sqlite3.connect(fake.database) as db:
            db.execute("INSERT OR IGNORE INTO sessions VALUES (?,NULL)", (session,))
            calls = [{"id": cid, "function": {"name": "paios_watch_check", "arguments": "{}"}}]
            db.execute("INSERT INTO messages(session_id,role,content,tool_calls) VALUES (?,'assistant','',?)", (session, json.dumps(calls)))
            db.execute("INSERT INTO messages(session_id,role,content,tool_call_id) VALUES (?,'tool',?,?)", (session, json.dumps(result), cid))
            db.execute("INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET "
                       "api_call_count=api_call_count+1,input_tokens=input_tokens+100,output_tokens=output_tokens+20",
                       (session, "fixture-model", "fixture", "fixture", "test", "", 1, 100, 20, 0, 0, 0, 0, 0))
        fake.runs[run_id] = {"run_id": run_id, "session_id": session, "conversation_session_id": session,
                             "status": "completed", "output": "", "usage": {"input_tokens": 100,
                             "output_tokens": 20, "total_tokens": 120, "cache_read_tokens": 0, "cache_write_tokens": 0}}
        record(fake, active, "background.completed", foreground_run_id=active["admission"]["run_id"],
               profile="owner", job_id=job_id, occurrence_id=occurrence, run_id=run_id,
               session_ids=[session], stage=phase, scheduled_admission=admission)
    record(fake, active, "watch.stage.closed", stage=phase, synthetic=True, producer_binding=fake.watch_binding)
    return {"status": "closed", "stage": phase, "producer_binding": fake.watch_binding}
