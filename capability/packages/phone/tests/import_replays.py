"""Import retained narration manifests; never execute a recorded action or read production config."""
import argparse
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))
from capability.packages.phone.server.receipts import project


def decode(value):
    if isinstance(value, str):
        start = value.find("{")
        if start < 0:
            return None
        try:
            value = json.JSONDecoder().raw_decode(value[start:])[0]
        except ValueError:
            return None
    if not isinstance(value, dict):
        return None
    for key in ("structuredContent", "structured_content", "result"):
        if key in value:
            return decode(value[key])
    return value


def import_cases(cases):
    sys.path.insert(0, os.environ["PAIOS_NATIVE_SOURCE_TEST_ROOT"])
    from gateway.platforms.api_run_reporting import request_report_facts
    samples = []
    for case in cases:
        native = json.loads(Path(case["native"]).read_text())
        rows = native.get("native", native)["trace"]["messages"]
        target = next(row for row in rows if row["id"] == case["message_id"])
        prior = [dict(row) for row in rows if row["id"] < target["id"] and row["session_id"] == target["session_id"]]
        for row in prior:
            if isinstance(row.get("tool_calls"), str):
                row["tool_calls"] = json.loads(row["tool_calls"])
        principal = case.get("principal_id") or case.get("launch", {}).get("principal_id")
        if not principal:
            raise ValueError("Recorded replay principal identity is required")
        message = request_report_facts(SimpleNamespace(_paios_principal_id=principal, session_id=target["session_id"]), prior)
        packet = decode(message["content"]) if message else {}
        source_records = list(packet.get("errand_records", []))
        calls = list(packet.get("task_records", []))
        for completion in packet.get("completion_records", []):
            calls.extend(completion.get("task_records", []))
        for call in calls:
            if call["tool"] not in {"phone_task", "phone_status", "mcp__phone__phone_task", "mcp__phone__phone_status"}:
                continue
            raw, args = decode(call["result"]), call["request"]
            if raw is not None:
                source_records.extend({**record, "task_type": args.get("effect", {}).get("task_type", "phone_operation")}
                                      for record in raw.get("jobs", [raw]))
        receipts = []
        for record in source_records:
            if record.get("receipt") == 1:
                receipts.append(record)
            elif record.get("job_id"):
                receipts.append(project(record, job_id=record["job_id"], revision=record.get("receipt_revision", 1)))
        if receipts:
            # Keep the latest retained snapshot of each source job for the final response.
            latest = {receipt["job"]["id"]: receipt for receipt in receipts}
            owner = next((row.get("content", "") for row in reversed(prior)
                          if row["session_id"] == target["session_id"] and row["role"] == "user"), "")
            samples.append({"id": case["id"], "text": target.get("content", ""), "owner_input": owner,
                            "receipts": list(latest.values()), "source": f'{case["native"]}#{case["message_id"]}'})
    return samples


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest")
    parser.add_argument("output")
    args = parser.parse_args()
    samples = import_cases(json.loads(Path(args.manifest).read_text()))
    with os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as stream:
        json.dump(samples, stream, ensure_ascii=False, indent=2)
    print(json.dumps({"imported": len(samples)}))
