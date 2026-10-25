"""A real native cron job, created by the product cron tool from a platform schedule context, then fired once.

Input (argv[1], JSON): home, root, context (the platform's schedule-context answer for the creating run), prompt.
Output: one line CRON_DELIVERY=<the body the personal_aios adapter posts to /internal/hermes/scheduled-task>.
"""
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from types import SimpleNamespace

from cron.jobs import get_job
from gateway.config import PlatformConfig
from gateway.platform_registry import PlatformEntry, platform_registry
from hermes_constants import set_hermes_home_override

inputs = json.loads(Path(sys.argv[1]).read_text())
set_hermes_home_override(Path(inputs["home"]))
sys.path.insert(0, str(Path(inputs["root"]) / "integrations/hermes"))
from personal_aios import cron  # noqa: E402

deliveries = []


def request(path, body):
    if path.endswith("schedule-context"):
        return inputs["context"]
    if path.endswith("scheduled-task"):
        deliveries.append(body)
        return {"status": "admitted"}
    return {}


handlers = []
ctx = SimpleNamespace(register_tool=lambda *args, **kwargs: handlers.append(args[3]) or True,
    register_platform=lambda name, label, factory, check, **kwargs: platform_registry.register(
        PlatformEntry(name=name, label=label, adapter_factory=factory, check_fn=check, **kwargs)),
    register_platform_handler=lambda *args, **kwargs: None)
cron.register(ctx, SimpleNamespace(_request=request))
created = json.loads(handlers[0]({"action": "create", "schedule": "every 1d", "prompt": inputs["prompt"]}))
assert created["success"], created
job = get_job(created["job_id"])
adapter = platform_registry.create_adapter("personal_aios", PlatformConfig(enabled=True))
result = asyncio.run(adapter.send(job["deliver"].split(":", 1)[1], "personal-aios-task",
    metadata={"job_id": job["id"], "occurrence_id": datetime.now(timezone.utc).isoformat()}))
assert result.success and len(deliveries) == 1, (result, deliveries)
print("CRON_DELIVERY=" + json.dumps({**deliveries[0], "native_job": {"id": job["id"], "prompt": job["prompt"],
    "script": job.get("script"), "deliver": job["deliver"]}}, ensure_ascii=False))
