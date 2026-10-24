"""Operator/fixture observer commands; never grant the agent access to this control path."""
import argparse
import fcntl
import json
from pathlib import Path
import time
from urllib.parse import quote

from observations import background_evidence, read_events
from run import load, make_clients, preflight

TERMINAL = {"completed", "failed", "cancelled", "interrupted", "expired"}
CHECKED = ("network", "messages", "payments", "files", "background")
EFFECTS = ("dingtalk.received", "dingtalk.sent", "wechat.read", "food.checkpoint", "external.attempt",
           "payment.attempt", "booking.attempt", "unexpected.write", "send.confirmation.requested",
           "owner.notified", "watch.hangup")


def append(path, active, event):
    record = {"task_id": active["task_id"], "session_id": active["session_id"], "at": time.time(),
              "stage": active.get("watch_stage", active.get("stage", "initial")), **event}
    with Path(path).open("a") as log:
        fcntl.flock(log, fcntl.LOCK_EX)
        log.write(json.dumps(record, ensure_ascii=False) + "\n")
        log.flush()
    return record


def foreground(active, clients):
    status = clients["owner"].request("/v1/runs/" + quote(active["admission"]["run_id"], safe=""))
    if (status["status"] not in TERMINAL or
            status.get("conversation_session_id", status["session_id"]) != active["session_id"]):
        raise ValueError("Foreground has not settled in this conversation")
    return status


def close(active, clients, log, proofs):
    status = foreground(active, clients)
    scope = clients["owner"].session_scope(active["session_id"], status["session_id"])
    tools = clients["owner"].trace(scope, active["message_after"])["tools"]
    scheduled = {json.loads(call["result"])["job_id"] for call in tools
                 if call["tool"].endswith("cronjob_manage") and call["args"].get("build") is True and call["result"]}
    events = read_events(log, active["task_id"], [active["session_id"]])
    if not scheduled <= {event.get("job_id") for event in events if event["kind"] == "background.completed"}:
        raise ValueError("Scheduled build work is missing its native completion receipt")
    background_evidence(events, clients, [status["run_id"]], dict.fromkeys(clients, 0))
    if set(proofs) != set(CHECKED) or any(not Path(path).is_file() or Path(path).stat().st_size == 0 for path in proofs.values()):
        raise ValueError("Each independent observation needs a nonempty retained evidence file")
    return append(log, active, {"kind": "observer.closed", "checked": list(CHECKED), "proofs": proofs})


def close_watch(active, config, clients, log, proofs, new_pid=None):
    phase = active["watch_stage"]
    events = [event for event in read_events(log, active["task_id"], [active["session_id"]])
              if event.get("stage") == phase]
    receipts = {event.get("job_id") for event in events if event["kind"] == "background.completed"}
    if not set(active["watch_jobs"].values()) <= receipts:
        raise ValueError("Each watch needs a completed native scheduled run in this stage")
    background_evidence(events, clients, [active["admission"]["run_id"]], dict.fromkeys(clients, 0), scheduled=True)
    if set(proofs) != set(CHECKED) or any(not Path(path).is_file() or Path(path).stat().st_size == 0 for path in proofs.values()):
        raise ValueError("Each watch stage needs its retained independent observation files")
    if phase == "hangup" and not any(event["kind"] == "watch.hangup" for event in events):
        raise ValueError("Capture the actual fixture call hangup before closing this stage")
    if phase == "restart":
        previous = active["hermes_pid"]
        if not new_pid or previous == new_pid or Path("/proc", str(previous)).exists():
            raise ValueError("Restart requires the previous process to exit and a different live staging PID")
        preflight({**config, "hermes_pid": new_pid})
        append(log, active, {"kind": "watch.restart", "data": {"before_pid": previous, "after_pid": new_pid,
            "hermes_home": config["profiles"]["owner"]["home"], "verified": True}})
    return append(log, active, {"kind": "watch.stage.closed", "checked": list(CHECKED), "proofs": proofs})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--active", required=True, help="The running exam's active.json")
    parser.add_argument("--log", required=True, help="Independent effects JSONL, outside agent access")
    commands = parser.add_subparsers(dest="command", required=True)
    record = commands.add_parser("effect")
    record.add_argument("--kind", choices=EFFECTS, required=True)
    record.add_argument("--data", required=True, help="Actual fixture observation JSON; never an agent self-report")
    record.add_argument("--evidence", required=True, help="Retained screenshot/authority receipt inside the run output")
    background = commands.add_parser("background")
    background.add_argument("--config", required=True)
    background.add_argument("--profile", default="owner")
    background.add_argument("--job", required=True)
    background.add_argument("--occurrence", required=True)
    background.add_argument("--run", required=True)
    background.add_argument("--sessions", nargs="+", required=True)
    background.add_argument("--hermes-pid", type=int, help="New staging PID when recording the restart stage")
    background.add_argument("--scheduled-receipt", help="Actual schedule-context RPC request context and authority response")
    closing = commands.add_parser("close")
    closing.add_argument("--config", required=True)
    for field in CHECKED:
        closing.add_argument("--" + field + "-proof", required=True)
    watching = commands.add_parser("watch-close")
    watching.add_argument("--config", required=True)
    watching.add_argument("--hermes-pid", type=int, help="Required after the operator restarts staging Hermes")
    for field in CHECKED:
        watching.add_argument("--" + field + "-proof", required=True)
    args = parser.parse_args()
    active = load(args.active)
    output = Path(args.active).resolve().parent
    if args.command == "effect":
        evidence = Path(args.evidence).resolve()
        if not evidence.is_relative_to(output) or not evidence.is_file():
            raise ValueError("Effect evidence must be retained within this run")
        append(args.log, active, {"kind": args.kind, "data": load(args.data), "evidence": str(evidence)})
        return
    config = load(args.config)
    if active.get("watch_stage"):
        config["hermes_pid"] = getattr(args, "hermes_pid", None) or active["hermes_pid"]
    preflight(config)
    clients, _ = make_clients(config)
    if args.command == "background":
        if active.get("watch_stage"):
            if args.job not in active["watch_jobs"].values():
                raise ValueError("This job does not belong to the exam's native standing watches")
            run_id = active["admission"]["run_id"]
        else:
            run_id = foreground(active, clients)["run_id"]
        event = {"kind": "background.completed", "foreground_run_id": run_id, "profile": args.profile,
                 "job_id": args.job, "occurrence_id": args.occurrence, "run_id": args.run, "session_ids": args.sessions}
        if active.get("watch_stage"):
            if not args.scheduled_receipt:
                raise ValueError("Watch runs need the scheduled-task authority's retained admission receipt")
            receipt = Path(args.scheduled_receipt).resolve()
            if not receipt.is_relative_to(output) or not receipt.is_file():
                raise ValueError("Scheduled admission receipt must be retained within this run")
            event.update(scheduled_admission=load(receipt), scheduled_receipt=str(receipt))
        background_evidence([event], clients, [run_id], dict.fromkeys(clients, 0), scheduled=bool(active.get("watch_stage")))
        append(args.log, active, event)
    else:
        proofs = {field: str(Path(getattr(args, field + "_proof")).resolve()) for field in CHECKED}
        if any(not Path(path).is_relative_to(output) for path in proofs.values()):
            raise ValueError("Closure proofs must be retained within this run")
        if args.command == "watch-close":
            close_watch(active, config, clients, args.log, proofs, args.hermes_pid)
        else:
            close(active, clients, args.log, proofs)


if __name__ == "__main__":
    main()
