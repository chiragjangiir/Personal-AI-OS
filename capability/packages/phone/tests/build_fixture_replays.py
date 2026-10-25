"""Source regression fixtures, explicitly distinct from retained production replay evidence."""
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))
from capability.packages.phone.server.receipts import project
import yaml


def fixtures():
    cases = yaml.safe_load(Path(__file__).with_name("contract.yaml").read_text())["fixtures"]
    bad = {"accepted": "已经成功了。", "running": "已完成。", "succeeded": "还在办。我们再执行一次。已记下。",
           "unknown": "失败了。", "waiting": "办好了。", "cancelled": "正在办。", "failed": "办好了。", "partial": "已完成。"}
    return [{"id": case["id"], "text": bad[case["state"]], "owner_input": "根据执行结果回复。",
             "receipts": [project(case["input"], job_id=f"job-{i:012x}", revision=1)],
             "source": "source-regression:capability/packages/phone/tests/contract.yaml#" + case["id"]}
            for i, case in enumerate(cases)]


if __name__ == "__main__":
    samples=fixtures()
    if len(sys.argv)>2:
        delivered=json.loads(Path(sys.argv[2]).read_text())
        samples.append({"id":"acked_followup","text":delivered["rendered_text"],"owner_input":"跟进同一任务。",
                        "receipts":[delivered["receipt"]],"acknowledged_fact_ids":delivered["acknowledged_fact_ids"],
                        "source":"source-regression:P1-ledger-rendered-fixture"})
    Path(sys.argv[1]).write_text(json.dumps(samples, ensure_ascii=False, indent=2) + "\n")
