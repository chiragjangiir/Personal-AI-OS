"""Exercise the dispatcher's native watches; lifecycle actions belong to the test operator."""
import json
from pathlib import Path
import time

from observations import background_evidence, iso_time, read_events, scheduled_binding

CREATE_TOOL = "cronjob_manage"
CHECK_TOOL = "paios_watch_check"
STAGES = ("pending", "hangup", "arrived", "restart", "repeated")
STATES = {"parcel": ("pending", "arrived"), "traffic": ("clear", "congested")}


def created_jobs(tools):
    jobs = {}
    for call in tools:
        args = call["args"]
        if call["tool"] != CREATE_TOOL or args.get("action") != "create" or "standing_watch" not in args:
            continue
        watch = args["standing_watch"]
        kind = next((name for name, states in STATES.items()
                     if (watch.get("from_status"), watch.get("to_status")) == states), None)
        result = json.loads(call["result"] or "{}")
        if kind and result.get("success") is True:
            if kind in jobs:
                raise ValueError("Duplicate standing watch for one fixture")
            jobs[kind] = result["job_id"]
    return jobs


def snapshot_jobs(home, identifiers):
    rows = json.loads((Path(home) / "cron/jobs.json").read_text())["jobs"]
    return {row["id"]: row for row in rows if row["id"] in identifiers}


def exercise(config, clients, fixtures, active, evidence, deadline, publish):
    jobs = created_jobs(evidence["tools"])
    if set(jobs) != set(STATES):
        evidence["watch_stages"] = []
        return {"sessions": {name: [] for name in clients}}
    home = config["profiles"]["owner"]["home"]
    evidence["watch_jobs"] = jobs
    evidence["watch_registered"] = snapshot_jobs(home, jobs.values())
    evidence["watch_stages"] = []
    sessions = {name: [] for name in clients}
    seen_runs, seen_occurrences = set(), set()
    for phase in STAGES:
        marks = {name: client.watermark() for name, client in clients.items()}
        phase_started = time.time()
        control = {**active, "watch_stage": phase, "watch_jobs": jobs,
                   "watch_departure_at": fixtures.watch_departure_at, "watch_stage_started_at": phase_started}
        publish(control)
        fixtures.stage = phase
        fixtures.watch_target = phase in {"arrived", "restart", "repeated"}
        if config.get("test_mode"):
            clients["owner"].request("/_exam/watch-stage", control)
        while True:
            events = [event for event in read_events(config["observer_log"], active["task_id"], [active["session_id"]])
                      if event.get("stage") == phase]
            if any(event["kind"] == "watch.stage.closed" for event in events):
                break
            if time.monotonic() >= deadline:
                raise TimeoutError("Operator did not close the standing-watch lifecycle stage")
            time.sleep(config.get("poll_s", 2))
        traces = background_evidence(events, clients, [active["admission"]["run_id"]], marks, scheduled=True)
        for event in events:
            if event["kind"] != "background.completed":
                continue
            occurrence = (event["job_id"], event["occurrence_id"])
            captured = iso_time(event["scheduled_admission"]["response"]["scheduled_captured_at"]).timestamp()
            if event["run_id"] in seen_runs or occurrence in seen_occurrences or captured < phase_started:
                raise ValueError("A stale scheduled watch run cannot satisfy another lifecycle stage")
            seen_runs.add(event["run_id"])
            seen_occurrences.add(occurrence)
        for field in ("turns", "tools", "messages"):
            evidence[field].extend(traces[field])
        evidence["events"].extend(events)
        for name in clients:
            sessions[name].extend(traces["sessions"][name])
        evidence["watch_stages"].append({"stage": phase, "started_at": phase_started, "jobs": snapshot_jobs(home, jobs.values()),
                                         "events": events, "tools": traces["tools"], "turns": traces["turns"]})
        if phase == "restart":
            restart = next((event for event in events if event["kind"] == "watch.restart"), None)
            if restart:
                active = {**active, "hermes_pid": restart["data"]["after_pid"]}
    return {"sessions": sessions}


def checks(evidence):
    jobs, registered = evidence.get("watch_jobs", {}), evidence.get("watch_registered", {})
    stages = evidence.get("watch_stages", [])
    result = dict.fromkeys(("watch.registered", "watch.lifecycle", "watch.parcel", "watch.traffic", "watch.once"), False)
    if set(jobs) != set(STATES) or set(registered) != set(jobs.values()):
        return result
    definitions = {kind: registered[identifier].get("standing_watch", {}).get("definition", {})
                   for kind, identifier in jobs.items()}
    result["watch.registered"] = all(
        set(watch) == {"query_tool", "query_args", "status_field", "from_status", "to_status", "message"}
        and watch["query_tool"] not in {CHECK_TOOL, CREATE_TOOL} and bool(watch["query_args"])
        and bool(watch["status_field"]) and bool(watch["message"])
        and (watch["from_status"], watch["to_status"]) == STATES[kind]
        and registered[jobs[kind]]["schedule"]["kind"] != "once"
        for kind, watch in definitions.items())
    if [stage["stage"] for stage in stages] != list(STAGES):
        return result
    lifecycle = True
    seen_runs, seen_occurrences = set(), set()
    for stage in stages:
        target = stage["stage"] in {"arrived", "restart", "repeated"}
        for kind, identifier in jobs.items():
            job = stage["jobs"].get(identifier, {})
            state = job.get("standing_watch", {})
            receipts = [event for event in stage["events"] if event["kind"] == "background.completed"
                        and event.get("job_id") == identifier]
            for event in receipts:
                terminal = next((turn for turn in stage["turns"] if turn["run_id"] == event["run_id"]), {})
                if not scheduled_binding(event, terminal):
                    lifecycle = False
                    continue
                occurrence = (identifier, event["occurrence_id"])
                captured = iso_time(event["scheduled_admission"]["response"]["scheduled_captured_at"]).timestamp()
                context = event["scheduled_admission"]["context"]
                matching_call = any(call["id"] == context["tool_call_id"] and call["session_id"] == context["session_id"]
                                    and call["tool"] == CHECK_TOOL for call in stage["tools"])
                lifecycle &= (event["run_id"] not in seen_runs and occurrence not in seen_occurrences
                              and captured >= stage["started_at"] and matching_call)
                seen_runs.add(event["run_id"])
                seen_occurrences.add(occurrence)
            native_sessions = {sid for event in receipts for sid in event["session_ids"]}
            calls = [call for call in stage["tools"] if call["tool"] == CHECK_TOOL
                     and call["session_id"] in native_sessions]
            outputs = [json.loads(call["result"] or "{}") for call in calls]
            expected = "delivered" if stage["stage"] == "arrived" else "silent"
            lifecycle &= (job.get("enabled") is True and job.get("deliver") == registered[identifier]["deliver"]
                and state.get("definition") == definitions[kind] and state.get("last_status") == STATES[kind][int(target)]
                and state.get("sequence") == int(target) and bool(receipts) and bool(calls)
                and any(output.get("status") == expected for output in outputs)
                and (not target or state.get("delivered_sequence") == 1 and not state.get("pending")))
    events = evidence["events"]
    hangups = [event.get("data", {}) for event in events if event["kind"] == "watch.hangup" and event.get("stage") == "hangup"]
    restarts = [event.get("data", {}) for event in events if event["kind"] == "watch.restart" and event.get("stage") == "restart"]
    lifecycle &= (len(hangups) == len(restarts) == 1 and bool(hangups[0].get("call_id"))
                  and hangups[0].get("from_state") == "active" and hangups[0].get("state") == "ended"
                  and restarts[0].get("before_pid") != restarts[0].get("after_pid") and restarts[0].get("verified") is True)
    result["watch.lifecycle"] = bool(lifecycle)
    notifications = [event for event in events if event["kind"] == "owner.notified"]
    once = len(notifications) == 2
    for kind, identifier in jobs.items():
        notices = [event for event in notifications if event.get("data", {}).get("job_id") == identifier]
        reads = [event for event in events if event["kind"] == "watch." + kind + ".read"]
        states = {event.get("body", {}).get("status") for event in reads}
        valid = len(notices) == 1 and set(STATES[kind]) <= states
        if valid:
            notice, data = notices[0], notices[0]["data"]
            valid &= (data.get("notification_id") == "watch:" + identifier + ":1" and notice.get("stage") == "arrived")
            if kind == "traffic":
                departure = iso_time(evidence["watch_departure_at"]).timestamp()
                valid &= ("堵" in data.get("text", "") and "早点出门" in data.get("text", "")
                          and data.get("surface") in {"glasses_card", "notification"}
                          and 0 < notice.get("at", 0) < departure
                          and all(0 < event.get("at", 0) < departure for event in reads))
            else:
                valid &= "到了" in data.get("text", "") or "已送达" in data.get("text", "")
        result["watch." + kind] = bool(valid and lifecycle)
        once &= valid
    result["watch.once"] = bool(once and lifecycle and not any("calendar" in call["tool"].lower() for call in evidence["tools"]))
    return result
