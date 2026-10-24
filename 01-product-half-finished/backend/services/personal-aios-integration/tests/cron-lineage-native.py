"""Real cron producer for the TypeScript runtime-to-native lineage regression."""
import asyncio
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
from types import SimpleNamespace

from cron.jobs import create_job, get_job
from gateway.config import PlatformConfig
from gateway.platform_registry import PlatformEntry, platform_registry
from hermes_constants import set_hermes_home_override

inputs = json.loads(sys.stdin.read())
set_hermes_home_override(Path(inputs["home"]))
sys.path.insert(0, str(Path(inputs["cron"]).parents[1]))
from personal_aios import cron
current = inputs["owner"]
deliveries = []


def request(path, body):
    if path.endswith("schedule-context"):
        return current
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
manage = lambda args: json.loads(handlers[0](args))
created = manage({"action": "create", "schedule": "every 5m", "prompt": "Owner documents"})
assert created["success"], created
job = get_job(created["job_id"])
current = inputs["observation"]
assert current["allow_reasoning_create"] is False and current["allow_owner_mutation"] is False
refused = manage({"action": "update", "job_id": job["id"], "prompt": "Observation hijack"})
assert not refused["success"] and get_job(job["id"]) == job, refused
adapter = platform_registry.create_adapter("personal_aios", PlatformConfig(enabled=True))


def deliver(job, occurrence):
    occurrence = (datetime.now(timezone.utc) + timedelta(seconds=occurrence)).isoformat()
    result = asyncio.run(adapter.send(job["deliver"].split(":", 1)[1], "personal-aios-task",
        metadata={"job_id": job["id"], "occurrence_id": occurrence}))
    assert result.success, result


deliver(job, 0)
# Reproduce the old unattributed job destination, through the same store and Delivery.
legacy_owner = {key: inputs["owner"][key] for key in ("principal_id", "device_id")}
legacy = create_job(prompt="Legacy owner work", schedule="every 5m", deliver=cron.target(legacy_owner),
                    script=cron.TASK_SCRIPT, no_agent=True, enabled_toolsets=cron.STAGING_TOOLSETS)
legacy_refused = manage({"action": "update", "job_id": legacy["id"], "prompt": "Observation replacement"})
assert not legacy_refused["success"] and get_job(legacy["id"]) == legacy, legacy_refused
deliver(legacy, 1)
current = inputs["observation"]
# This is the original reviewer's compromised continuation. It must receive zero grants.
compromised = create_job(prompt="Observation replacement", schedule="every 5m", deliver=cron.target(current),
                         script=cron.TASK_SCRIPT, no_agent=True, enabled_toolsets=cron.STAGING_TOOLSETS)
deliver(compromised, 2)
current = inputs["owner_update"]
updated = manage({"action": "update", "job_id": legacy["id"], "prompt": "New explicit owner work"})
assert updated["success"], updated
rebound = get_job(legacy["id"])
assert cron.job_owner(rebound)["origin_processed_event_id"] == current["origin_processed_event_id"]
deliver(rebound, 3)
print("LINEAGE_RESULT=" + json.dumps({"refused": refused, "legacy_refused": legacy_refused, "deliveries": deliveries}))
