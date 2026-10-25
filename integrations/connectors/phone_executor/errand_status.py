"""The executor's durable terminal reader, shared by deduplication and status queries."""
import json
import re
import time
import step_trace
from datetime import datetime
from pathlib import Path

SPOOL_CONTRACT = json.loads((Path(__file__).resolve().parents[2] / "contracts/errand-spool.v1.json").read_text())
TERMINAL_STATES = SPOOL_CONTRACT["states"]
RECENT_S = 600  # Goal deduplication and status window; targeted job identity never expires.


def _terminal_record(folder: Path, job_id: str, now: float, *, recent_only: bool = True) -> tuple[float, dict | None, bool]:
    # An open descriptor pins one record across the gateway's atomic state transitions.
    # Resolve the entire family twice; a vanished identity is unknown, never evidence of absence.
    finished, record = now, None
    for _ in range(2):
        for state in TERMINAL_STATES.values():
            try:
                path = folder / f"{job_id}.{state}.json"
                with path.open() as stream:
                    record = json.load(stream)
                # Restores and report-delivery transitions change mtime, not when the phone finished.
                if (not isinstance(record, dict) or not isinstance(record.get("finished_at"), str) or
                    not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", record["finished_at"])):
                    return finished, record if isinstance(record, dict) else None, False
                finished = datetime.fromisoformat(record["finished_at"].replace("Z", "+00:00")).timestamp()
                if recent_only and now - finished > RECENT_S:
                    return finished, None, True
                # Gateway report failure does not invalidate the executor's completed action or permit another dispatch.
                if (state == TERMINAL_STATES["quarantined"] and not isinstance(record.get("delivery_failure"), dict) or record.get("job_id") != job_id or
                    not isinstance(record.get("principal_id"), str) or not record["principal_id"] or
                    not isinstance(record.get("task"), str) or type(record.get("success")) is not bool or
                    not isinstance(record.get("answer"), str) or
                    "terminal_reason" in record and record["terminal_reason"] not in SPOOL_CONTRACT["terminal_reasons"] or
                    record.get("app") is not None and not isinstance(record["app"], str)):
                    return finished, record, False
                return finished, record, True
            except FileNotFoundError:
                continue
            except (OSError, ValueError):
                return finished, record if isinstance(record, dict) else None, False
    return finished, None, False

def terminal_records(folder: Path, now: float, *, job_id: str | None = None) -> list:
    identities = set()
    # Keep the existing dedup reader's union across the gateway's finite rename family.
    for _ in TERMINAL_STATES:
        identities.update(path.name.rsplit(".", 2)[0] for path in folder.iterdir()
                          if path.name.startswith("job-") and any(path.name.endswith(f".{state}.json") for state in TERMINAL_STATES.values()))
    if job_id is not None:
        identities.intersection_update({job_id})
    return [(jid, _terminal_record(folder, jid, now, recent_only=job_id is None)) for jid in identities]


def job_status(spool: str | None, running: dict, principal_id: str, *, job_id: str | None = None) -> dict:
    if not isinstance(principal_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}", principal_id):
        raise ValueError("ERRAND_PRINCIPAL_REQUIRED")
    if job_id is not None and (not isinstance(job_id, str) or not re.fullmatch(r"job-[a-f0-9]{12}", job_id)):
        raise ValueError("ERRAND_JOB_ID_INVALID")
    now = time.time()
    jobs = {jid: {"job_id": jid, "app": job["app"], "task": job["goal"][:120], "state": job["state"],
                  "seconds": int(now - job["since"]), **step_trace.snapshot(job),
                  **{key: job[key] for key in ("capability_receipt", "receipt_revision", "task_type") if key in job},
                  **({"self_check_of": job["self_check_of"]} if "self_check_of" in job else {})}
            for jid, job in running.items() if job["principal_id"] == principal_id and (job_id is None or jid == job_id)}
    if spool and Path(spool).exists():
        for jid, (_, record, verified) in sorted(terminal_records(Path(spool), now, job_id=job_id), key=lambda item: item[1][0], reverse=True):
            if not verified:
                raise ValueError("ERRAND_TERMINAL_UNREADABLE")
            if record is not None and record["principal_id"] == principal_id:
                reason = record.get("terminal_reason")  # Legacy records can omit the reason.
                jobs[jid] = {"job_id": jid, "app": record.get("app"), "task": record["task"][:120],
                             "state": reason or "finished", "success": record["success"], "terminal_reason": reason,
                             "answer": record["answer"][:300], "finished_at": record["finished_at"],
                             **{key: record[key] for key in ("title", "evidence_ref", "trace", "self_check_of", "partial_findings", "capability_receipt", "receipt_revision", "task_type") if key in record}}
    return {"jobs": list(jobs.values())}
