"""Fixture-only acceptance exam. No service deployment, GUI operation, or production access."""
import argparse
import datetime as dt
import json
from pathlib import Path
import shutil
import sqlite3
import sys
import time
import uuid
from urllib.parse import urlsplit

from accounting import COUNTERS, delta, read_usage
from artifacts import collect as collect_artifact
from catalog import TASKS, TOOL_ROLES
from consent import SendConsent
from fixtures import prepare
from hermes import Hermes, initialize_desktop, loopback_origin, token_usage
from mail_fixture import Mailbox
from observations import await_observer, background_evidence, iso_time, read_events
from rubrics import evaluate, review_result, snapshot
from services import Fixtures
from watches import exercise as exercise_watches
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile


def load(path):
    return json.loads(Path(path).read_text())


def write(path, value, secrets=()):
    text = json.dumps(value, ensure_ascii=False, indent=2)
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[REDACTED]")
    destination = Path(path)
    temporary = destination.with_name(destination.name + ".tmp")
    temporary.write_text(text + "\n")
    temporary.replace(destination)


def preflight(config, *, desktop=False):
    root = Path(config["fixture_root"]).resolve()
    if not (root / "ground_truth.json").is_file():
        raise ValueError("Prepare fixture inputs first")
    if config.get("test_mode"):
        return {"stage": "fake", "release_eligible": False, "seeds": {
            "voice": {"source_ids": ["exam-confirmed-voice-records"]}, "calls": {"source_ids": ["exam-call-record"]},
            "wechat": {"source_ids": ["exam-wechat-record"]}, "ambient": {"source_ids": ["exam-ambient-record"]}}}
    home = Path(config["profiles"]["owner"]["home"]).resolve()
    process = Path("/proc") / str(int(config["hermes_pid"]))
    env = dict(item.split("=", 1) for item in (process / "environ").read_text().split("\0") if "=" in item)
    if (env.get("PAIOS_STAGE") != "staging" or Path(env.get("HERMES_HOME", "")).resolve() != home
            or "personal_aios/run_api.py" not in (process / "cmdline").read_text()):
        raise ValueError("Hermes PID must own this isolated staging profile in the current Linux namespace")
    if set(config["profiles"]) != {"owner"}:
        raise ValueError("This Hermes fork stores build transcripts/accounting in the owner API profile")
    origin = loopback_origin(config["profiles"]["owner"]["origin"])
    gateway = loopback_origin(config["gateway_origin"])
    if (urlsplit(origin).port != int(env["API_SERVER_PORT"])
            or urlsplit(gateway).port != int(env["PAIOS_INTEGRATION_PORT"])):
        raise ValueError("Exam endpoints do not match the bound staging process ports")
    receipt = load(config["isolation_receipt"])
    if (receipt.get("exam_id") != config["exam_id"] or receipt.get("stage") != "staging"
            or Path(receipt["hermes_home"]).resolve() != home
            or Path(receipt["fixture_root"]).resolve() != root
            or receipt.get("hermes_origin") != origin or receipt.get("gateway_origin") != gateway
            or receipt.get("external_effects") != "blocked" or receipt.get("fixture_only") is not True
            or iso_time(receipt["expires_at"]) <= dt.datetime.now(dt.timezone.utc)):
        raise ValueError("A current operator isolation receipt bound to this exam is required")
    for field in ("network_evidence", "observer_evidence"):
        if not Path(receipt[field]).read_text().strip():
            raise ValueError("Isolation and independent observer evidence must be present")
    for name, seed in receipt.get("seeds", {}).items():
        if not seed.get("source_ids") or not Path(seed["evidence"]).is_file():
            raise ValueError("Seed receipts must identify authoritative ingested source records")
        if name == "ambient" and (len(seed.get("speakers", [])) != 2 or not Path(seed["audio_file"]).is_file()):
            raise ValueError("Ambient recap requires ingested real audio with two voices")
    if desktop:
        receipt["desktop_mcp"] = initialize_desktop(gateway, env["PAIOS_HERMES_INTERNAL_KEY"])
    return receipt


def make_clients(config):
    clients, secrets = {}, []
    homes = [Path(profile["home"]).resolve() for profile in config["profiles"].values()]
    if len(homes) != len(set(homes)):
        raise ValueError("Each accounting database must have one profile label")
    device_key = (load(config["device_pairing_file"])["token"] if "device_pairing_file" in config
                  else Path(config["device_key_file"]).read_text().strip())
    secrets.append(device_key)
    for name, profile in config["profiles"].items():
        key = Path(profile["key_file"]).read_text().strip()
        secrets.append(key)
        home = Path(profile["home"])
        clients[name] = Hermes(profile["origin"], key, home / "state.db",
            config.get("timeout_s", 900), config.get("poll_s", 2), config["gateway_origin"], device_key)
        if config.get("test_mode") and clients[name].request("/health").get("fake_hermes") is not True:
            raise ValueError("Test mode can only use the fake Hermes endpoint")
    return clients, secrets


def summary(report, directory):
    lines = [f'Tasks: {len(report["tasks"])}/{len(TASKS)}', "",
             "| Task | Result | Content | Delivery | Seconds | Input tokens | Output tokens |", "|---|---|---|---|---:|---:|---:|"]
    for result in report["tasks"]:
        usage = (result.get("usage") or {}).get("totals", {})
        lines.append(f'| {result["id"]} | {result["status"]} | {result.get("content_result", "—")} | '
                     f'{result.get("delivery_result", "—")} | {result.get("seconds", 0):.2f} | '
                     f'{usage.get("input_tokens", "unknown")} | {usage.get("output_tokens", "unknown")} |')
    report["release_accepted"] = (not report["test_mode"] and len(report["tasks"]) == len(TASKS)
        and all(task["status"] == "passed" for task in report["tasks"]))
    write(directory / "summary.json", report)
    (directory / "summary.md").write_text("\n".join(lines) + "\n")
    return "\n".join(lines)


def run(config, out, selected=None, operator_notified=None):
    tasks = [task for task in TASKS if not selected or task.id in selected]
    receipt = preflight(config, desktop=any("desktop" in task.checks for task in tasks))
    clients, secrets = make_clients(config)
    root, directory = Path(config["fixture_root"]).resolve(), Path(out).resolve()
    directory.mkdir(parents=True, exist_ok=False)
    (directory / "observations").mkdir()
    report = {"schema": "paios.capability-exam.v1", "exam_id": config["exam_id"],
              "run_id": "exam-" + uuid.uuid4().hex, "test_mode": bool(config.get("test_mode")),
              "task_count": len(TASKS),
              "tasks": [], "release_accepted": False, "operator_notified": operator_notified}
    report["usage_source"] = "Native session_model_usage deltas, including bound background sessions; API usage kept separately"
    truth = load(root / "ground_truth.json")
    write(directory / "isolation.json", receipt, secrets)
    baseline = None
    lifecycle_session = None
    if selected and set(selected) - {task.id for task in TASKS}:
        raise ValueError("Unknown task IDs")
    with Fixtures(config.get("fixture_bind", "127.0.0.1"), config.get("fixture_port", 0)) as fixtures, Mailbox(
        root / "fixture.eml", fixtures.record, config.get("fixture_bind", "127.0.0.1"),
        config.get("imap_port", 0), config.get("smtp_port", 0)) as mailbox:
        for task in tasks:
            started = time.monotonic()
            result = {"id": task.id, "mode": "operator-run" if task.operator_run else "automatic", "status": "blocked"}
            report["tasks"].append(result)
            if task.operator_run and not operator_notified:
                result.update(status="operator-run", reason="The operator must notify the owner before this GUI probe")
                continue
            if task.seed and task.seed not in receipt.get("seeds", {}) and not report["test_mode"]:
                result["reason"] = "Missing seed admission evidence: " + task.seed
                continue
            if task.id in {"11-repair", "12-revert"} and not baseline:
                result["reason"] = "Build/reuse prerequisite did not pass its automatic checks"
                continue
            task_dir = directory / task.id
            task_dir.mkdir()
            session = (lifecycle_session if task.id in {"11-repair", "12-revert"}
                       else report["run_id"] + "-" + task.id)
            fixtures.task = task.id
            if task.id == "11-repair":
                fixtures.phase = "v2"
            mark = {}
            pending_answer = None
            target_person = {"01-dingtalk": "exam-chenmo", "02-email": "chenmo@example.test"}.get(task.id)
            consent = SendConsent(config["observer_log"], task.id, target_person, fixtures.record) if target_person else None
            evidence = {"task_id": task.id, "session": session, "initial_sessions": [session], "turns": [],
                        "artifact_root": str(task_dir),
                        "tools": [], "messages": [], "events": [], "registry_before": {},
                        "seed_receipt": receipt.get("seeds", {}).get(task.seed),
                        "flight_date": truth["seed"]["flight_date"]}
            active = {"exam_id": report["exam_id"], "run_id": report["run_id"], "task_id": task.id,
                      "session_id": session, "fixture_origin": fixtures.origin, "rubric": task.review}
            write(directory / "active.json", active)
            original_name = {"01-dingtalk": "draft.docx", "03-ppt": "monthly.pptx", "04-excel": "budget.xlsx"}.get(task.id)
            original = ((root if task.id == "01-dingtalk" else root / "inputs") / original_name) if original_name else None
            def admitted(accepted, target):
                nonlocal pending_answer
                evidence.setdefault("admissions", []).append({"session_id": target, **accepted})
                write(directory / "active.json", {**active, "session_id": target, "stage": fixtures.stage,
                                                 "admission": accepted["admission"], "message_after": mark["owner"]})
                if pending_answer:
                    fixtures.record({"kind": "send.confirmation.answered", "data": {**pending_answer, "choice": "once",
                        "response_processed_event_id": accepted["processed_event"]["processed_event_id"],
                        "response_run_id": accepted["admission"]["run_id"]}})
                    pending_answer = None
            try:
                mark = {name: client.watermark() for name, client in clients.items()}
                usage_before = {name: read_usage(client.database) for name, client in clients.items()}
                registry_before = evidence["registry_before"] = snapshot(config["registry_root"])
                original_bytes = original.read_bytes() if original else None
                if original:
                    shutil.copy2(original, task_dir / ("input-" + original.name))
                artifact = {"01-dingtalk": "revised.docx", "03-ppt": "organized.pptx", "04-excel": "corrected.xlsx"}.get(task.id)
                if artifact and (root / "outputs" / artifact).exists():
                    raise ValueError("Existing output cannot count as current-task work; use fresh fixture outputs")
                fixture_origin = config.get("fixture_public_origin") or fixtures.origin
                prompt = task.prompt
                if task.id == "02-email":
                    host = config.get("mailbox_public_host", "127.0.0.1")
                    prompt += (f"\n隔离测试邮箱 owner@example.test，密码 fixture-only；只读 INBOX。"
                               f"IMAP {host}:{mailbox.imap_port}，SMTP {host}:{mailbox.smtp_port}，均为 fixture 明文服务。")
                if task.id in {"03-ppt", "04-excel"}:
                    prompt += "\n本次文件位于 " + config.get("agent_inputs", str(root / "inputs")) + "; 输出目录 " + config.get(
                        "agent_outputs", str(root / "outputs")) + "."
                    if config.get("workshop_output_root"):
                        prompt += '\n先单独执行 echo "$OUT" 读取本次工坊输出目录；把成品直接保存在该目录。'
                elif task.id == "01-dingtalk":
                    prompt += "\n请从钉钉原会话取得附件；输出目录 " + config.get("agent_outputs", str(root / "outputs")) + "."
                if task.id in {"05-flights", "10-build"}:
                    prompt += "\n本次只使用隔离测试服务 " + fixture_origin + ("/flights?date=YYYY-MM-DD" if task.id == "05-flights" else "/parcel/{快递单号}")
                if task.id == "14-watches":
                    fixtures.watch_departure_at = config.get("watch_departure_at") or (
                        dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=30)).isoformat()
                    departure = iso_time(fixtures.watch_departure_at)
                    if departure.utcoffset() is None or departure <= dt.datetime.now(dt.timezone.utc):
                        raise ValueError("Fixture usual departure must be a future ISO timestamp with timezone")
                    evidence["watch_departure_at"] = fixtures.watch_departure_at
                    active["watch_departure_at"] = fixtures.watch_departure_at
                    prompt += ("\n只用 fixture 查询端点 " + fixture_origin + "/watch/parcel 和 /watch/traffic，"
                        "返回 JSON status，分别 pending→arrived、clear→congested。我的通常出门时间是 "
                        + fixtures.watch_departure_at + "。用已有持续监测机制每分钟检查；地图观察不使用日历。")
                def turn(text, target):
                    nonlocal pending_answer
                    fixtures.session = target
                    after = clients["owner"].watermark()
                    native = clients["owner"].turn(target, text, "exam-" + uuid.uuid4().hex,
                        deadline=started + config.get("timeout_s", 900), admitted=lambda accepted: admitted(accepted, target),
                        on_status=(lambda status: consent.respond(clients["owner"], status, target)) if consent else None)
                    evidence["turns"].append(native)
                    trace = clients["owner"].trace(native["transcript_sessions"], after)
                    evidence["tools"].extend(trace["tools"])
                    evidence["messages"].extend(trace["messages"])
                    while consent:
                        question = consent.question(native, target)
                        if question:
                            if len(consent.consumed) == 1 and target == session:
                                pending_answer = question["data"]
                                turn("是，确认把本次内容发送给" + target_person + "。", target)
                            break
                        if any(event["kind"] == "observer.closed" for event in read_events(config["observer_log"], task.id, [target])):
                            break
                        if time.monotonic() >= started + config.get("timeout_s", 900):
                            raise TimeoutError("Send question/effect observer did not settle")
                        time.sleep(config.get("poll_s", 2))
                turn(prompt, session)
                events = await_observer(config["observer_log"], task.id, session,
                                        started + config.get("timeout_s", 900), config.get("poll_s", 2))
                background = background_evidence(events, clients, [t["run_id"] for t in evidence["turns"]], mark)
                evidence["turns"].extend(background["turns"])
                evidence["tools"].extend(background["tools"])
                evidence["messages"].extend(background["messages"])
                evidence["events"].extend(events)
                if consent:
                    reuse = report["run_id"] + "-" + task.id + "-send-reuse"
                    evidence["send_reuse_session"] = reuse
                    fixtures.stage = "consent-reuse"
                    repeat = ("把 " + config.get("agent_outputs", str(root / "outputs"))
                              + "/revised.docx 发回钉钉 exam-chenmo。" if task.id == "01-dingtalk" else prompt)
                    turn(repeat, reuse)
                    reuse_events = await_observer(config["observer_log"], task.id, reuse,
                        started + config.get("timeout_s", 900), config.get("poll_s", 2))
                    reuse_bg = background_evidence(reuse_events, clients, [t["run_id"] for t in evidence["turns"]], mark)
                    for key in ("tools", "messages", "turns"):
                        evidence[key].extend(reuse_bg[key])
                    for name in clients:
                        background["sessions"][name].extend(reuse_bg["sessions"][name])
                    evidence["events"].extend(reuse_events)
                if task.id == "14-watches":
                    watch = exercise_watches(config, clients, fixtures,
                        {**active, "admission": evidence["admissions"][-1]["admission"], "message_after": mark["owner"],
                         "hermes_pid": config.get("hermes_pid", 0)},
                        evidence, started + config.get("timeout_s", 900), lambda state: write(directory / "active.json", state))
                    for name in clients:
                        background["sessions"][name].extend(watch["sessions"][name])
                if task.id in {"10-build", "12-revert"}:
                    built = snapshot(config["registry_root"])
                    reuse = report["run_id"] + "-" + task.id + "-fresh"
                    evidence["reuse_session"] = reuse
                    write(directory / "active.json", {**active, "session_id": reuse, "stage": "reuse"})
                    if task.id == "12-revert":
                        fixtures.phase = "v1"
                    fixtures.stage = "restored" if task.id == "12-revert" else "reuse"
                    turn("查一下 EXAM002。" if task.id == "10-build" else "查一下 EXAM001。", reuse)
                    evidence["reuse_output"] = evidence["turns"][-1].get("output", "")
                    evidence["reuse_transcripts"] = evidence["turns"][-1]["transcript_sessions"]
                    reuse_events = await_observer(config["observer_log"], task.id, reuse,
                        started + config.get("timeout_s", 900), config.get("poll_s", 2))
                    reuse_bg = background_evidence(reuse_events, clients, [t["run_id"] for t in evidence["turns"]], mark)
                    for key in ("tools", "messages", "turns"):
                        evidence[key].extend(reuse_bg[key])
                    for name in clients:
                        background["sessions"][name].extend(reuse_bg["sessions"][name])
                        evidence["reuse_transcripts"].extend(reuse_bg["sessions"][name])
                    evidence["reuse_output"] += "\n" + "\n".join(t.get("output", "") for t in reuse_bg["turns"])
                    evidence["events"].extend(reuse_events)
                    evidence["reuse_unchanged"] = built == snapshot(config["registry_root"])
                    lifecycle_session = reuse if task.id == "10-build" else lifecycle_session
                evidence["events"].extend(fixtures.capture())
                evidence["registry_after"] = snapshot(config["registry_root"])
                evidence["registry_baseline"] = baseline
                evidence["inputs_preserved"] = original is None or original.is_file() and original.read_bytes() == original_bytes
                usage = []
                for name, client in clients.items():
                    scoped = background["sessions"][name] + ([sid for native in evidence["turns"]
                        for sid in native.get("transcript_sessions", [])] if name == "owner" else [])
                    amount = delta(usage_before[name], read_usage(client.database), scoped)
                    if amount:
                        usage.extend({"profile": name, **row} for row in amount["rows"])
                evidence["usage"] = ({"rows": usage, "totals": {key: sum(row[key] for row in usage) for key in COUNTERS}}
                                     if usage else None)
                evidence["api_usage"] = token_usage(evidence["turns"])
                if task.id in {"03-ppt", "04-excel"} and config.get("workshop_output_root"):
                    evidence["artifact_receipt"] = collect_artifact(evidence, config["workshop_output_root"],
                                                                  root / "outputs" / artifact)
                checks = evaluate(task, evidence, root, roles=config.get("tool_roles", TOOL_ROLES))
                result.update(checks=checks, usage=evidence["usage"], status=review_result(checks, None), review=task.review)
                if task.id == "01-dingtalk":
                    result.update(content_result="needs_review" if checks["content"] else "failed",
                                  delivery_result="passed" if checks["delivery"] else "failed")
                if task.id == "10-build" and all(checks.values()):
                    baseline = evidence["registry_after"]
                for path in (root / "outputs").iterdir():
                    if path.is_file() and not path.is_symlink():
                        shutil.copy2(path, task_dir / path.name)
            except (ValueError, KeyError, OSError, sqlite3.Error, ParseError, BadZipFile) as error:
                result.update(status="error", error_type=type(error).__name__)
                # Full exception strings can contain credentials from a failed request URL.
                result["reason"] = str(error) if isinstance(error, ValueError) else "Inspect fixture observer and native run records"
                report["aborted"] = True
                report["closure"] = "Stop and settle this isolated staging profile before another exam; background closure is unproven"
                try:
                    clients["owner"].stop()
                except (OSError, ValueError) as stop_error:
                    result["stop_error"] = type(stop_error).__name__
            finally:
                if result["status"] == "error" and "owner" in mark:
                    try:
                        partial = clients["owner"].trace([session, evidence.get("reuse_session", "")], mark["owner"])
                        for field in ("messages", "tools"):
                            existing = {(row["session_id"], row["id"]) for row in evidence[field]}
                            evidence[field].extend(row for row in partial[field] if (row["session_id"], row["id"]) not in existing)
                    except (sqlite3.Error, ValueError, OSError) as capture_error:
                        evidence["capture_error"] = type(capture_error).__name__
                result["seconds"] = round(time.monotonic() - started, 3)
                evidence["events"].extend(event for event in fixtures.capture() if event not in evidence["events"])
                write(task_dir / "evidence.json", evidence, secrets)
                summary(report, directory)
            if report.get("aborted"):
                break
            fixtures.stage = "initial"
    (directory / "active.json").unlink(missing_ok=True)
    print(summary(report, directory))
    return report


def grade(directory, reviews_path):
    directory = Path(directory)
    report, reviews = load(directory / "summary.json"), load(reviews_path)
    if reviews["run_id"] != report["run_id"]:
        raise ValueError("Reviews belong to a different exam run")
    for result in report["tasks"]:
        if "checks" not in result:
            continue
        review = reviews["tasks"].get(result["id"])
        if review:
            for artifact in review.get("evidence", []):
                path = (directory / artifact).resolve()
                if not path.is_relative_to(directory.resolve()) or not path.is_file():
                    raise ValueError("Review must cite retained evidence within this run")
        result["status"] = review_result(result["checks"], review)
        if result["id"] == "01-dingtalk":
            result["content_result"] = ("failed" if not result["checks"]["content"] else
                "passed" if review and review.get("content_approved") is True else
                "failed_review" if review and review.get("content_approved") is False else "needs_review")
        result["review_receipt"] = review
    print(summary(report, directory))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    setup = commands.add_parser("prepare")
    setup.add_argument("--root", required=True)
    setup.add_argument("--date", help="Fixture calendar date in the staging owner's configured timezone")
    execute = commands.add_parser("run")
    execute.add_argument("--config", required=True)
    execute.add_argument("--out", required=True)
    execute.add_argument("--tasks", nargs="+")
    execute.add_argument("--operator-notified", help="Owner notification reference; required for operator-run GUI tasks")
    review = commands.add_parser("grade")
    review.add_argument("--report", required=True)
    review.add_argument("--reviews", required=True)
    commands.add_parser("list")
    args = parser.parse_args()
    if args.command == "prepare":
        print(json.dumps(prepare(Path(args.root), dt.date.fromisoformat(args.date) if args.date else None), ensure_ascii=False, indent=2))
    elif args.command == "list":
        for task in TASKS:
            print(task.id, "operator-run" if task.operator_run else "automatic", task.prompt, task.review, sep="\t")
    elif args.command == "run":
        report = run(load(args.config), args.out, args.tasks, args.operator_notified)
        return 0 if report["release_accepted"] else 1
    else:
        report = grade(args.report, args.reviews)
        return 0 if report["release_accepted"] else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
