"""Offline transport fixtures through the same package host and executor spool."""
from pathlib import Path
import asyncio
import json
import os
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))
from capability.packages.phone.server.host import executor, mcp


async def run_task(**task):
    await asyncio.sleep(0)
    configured = os.environ.get("PAIOS_PHONE_FAKE_RESULT")
    kind = executor._jobs[executor._job_id.get()]["effect_kind"]
    return json.loads(Path(configured).read_text()) if configured else {
        "success": True, "answer": "屏幕显示订单。", "observed_values": [
            {"key": "价格", "value": "16.60", "unit": "CNY", "provenance": "observed", "source": "fake_screen"}],
        "effect_evidence": [{"kind": kind, "action": "读取页面" if kind == "observe" else "提交订单", "verification": "verified",
                             "evidence": "假屏幕回读同一订单", "ref": "fake:order"}]}


def configure():
    executor.PHONE_PROVIDER = "fake"
    executor._online = lambda *_: True
    executor._errand_task = run_task


if __name__ == "__main__":
    configure()
    executor._recover_interrupted()
    mcp.run(transport="stdio")
