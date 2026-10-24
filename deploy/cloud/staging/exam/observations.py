"""Read independently captured fixture effects and native background lineage."""
import json
import datetime as dt
import time
from pathlib import Path
from urllib.parse import quote


def iso_time(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00") if isinstance(value, str) else value)


def read_events(path, task, sessions):
    events = []
    with Path(path).open() as source:
        for line in source:
            if not line.endswith("\n"):
                break
            event = json.loads(line)
            if event.get("task_id") == task and event.get("session_id") in sessions:
                events.append(event)
    return events


def await_observer(path, task, session, deadline, poll):
    while True:
        events = read_events(path, task, [session])
        if any(event["kind"] == "observer.closed" for event in events):
            return events
        if time.monotonic() >= deadline:
            raise TimeoutError("Independent effect observer did not close this task")
        time.sleep(poll)


def scheduled_binding(event, terminal):
    receipt = event.get("scheduled_admission", {})
    context, source = receipt.get("context", {}), receipt.get("response", {})
    try:
        captured = iso_time(source.get("scheduled_captured_at", ""))
    except (ValueError, TypeError):
        return False
    return bool(source.get("origin_processed_event_id") and source.get("scheduled_job_id") == event.get("job_id")
        and source.get("scheduled_occurrence_id") == event.get("occurrence_id")
        and context.get("run_id") == event.get("run_id") == terminal.get("run_id")
        and context.get("session_id") in event.get("session_ids", []) and context.get("tool_call_id")
        and captured.utcoffset() is not None)


def background_evidence(events, profiles, foreground_runs, after, *, scheduled=False):
    """Only exact native run/session bridges may extend the tool/accounting scope."""
    tools, messages, turns = [], [], []
    seen = set()
    sessions = {name: [] for name in profiles}
    for event in events:
        if event["kind"] != "background.completed":
            continue
        if event["run_id"] in foreground_runs:
            raise ValueError("Background completion must identify a distinct native run")
        if event["run_id"] in seen:
            raise ValueError("Duplicate background run receipt")
        seen.add(event["run_id"])
        if (event["foreground_run_id"] not in foreground_runs or not event["job_id"] or not event["occurrence_id"]):
            raise ValueError("Background completion is not bound to this task's admission")
        profile = event["profile"]
        client = profiles[profile]
        terminal = client.request("/v1/runs/" + quote(event["run_id"], safe=""))
        if terminal["run_id"] != event["run_id"]:
            raise ValueError("Native background status returned a different run identity")
        if scheduled and not scheduled_binding(event, terminal):
            raise ValueError("Watch run is not bound to its authoritative scheduled-task admission")
        if terminal["status"] not in {"completed", "failed", "cancelled", "interrupted", "expired"}:
            raise ValueError("Observer closed while background work was still running")
        if terminal["session_id"] not in event["session_ids"]:
            raise ValueError("Background run/session mismatch")
        sessions[profile].extend(event["session_ids"])
        trace = client.trace(event["session_ids"], after[profile])
        if scheduled:
            context = event["scheduled_admission"]["context"]
            if not any(call["id"] == context["tool_call_id"] and call["session_id"] == context["session_id"]
                       and call["tool"] == "paios_watch_check" for call in trace["tools"]):
                raise ValueError("Scheduled receipt does not identify this phase's native watch tool call")
        tools.extend(trace["tools"])
        messages.extend(trace["messages"])
        turns.append(terminal)
    return {"tools": tools, "messages": messages, "turns": turns, "sessions": sessions}
