"""Owner lifecycle changes while the native watch query is in flight."""
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
import json
from pathlib import Path
import sys
from threading import Event
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / "integrations/hermes"))


@pytest.fixture
def cron_tool(monkeypatch, tmp_path):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from gateway.platform_registry import PlatformEntry, platform_registry
    from personal_aios import cron

    monkeypatch.delenv("PAIOS_STAGE", raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    owner = {"principal_id": "fixture-owner", "device_id": "fixture-phone",
             "allow_owner_mutation": True, "allow_reasoning_create": True}
    handlers = {}
    def register(name, toolset, schema, handler, **kwargs):
        handlers[name] = handler
        return True
    ctx = SimpleNamespace(register_tool=register,
        register_platform=lambda name, label, factory, check, **kw: platform_registry.register(
            PlatformEntry(name=name, label=label, adapter_factory=factory, check_fn=check, **kw)),
        register_platform_handler=lambda *a, **kw: None)
    token = set_hermes_home_override(tmp_path)
    try:
        cron.register(ctx, SimpleNamespace(_request=lambda path, body: owner))
        yield handlers["cronjob_manage"]
    finally:
        platform_registry.unregister("personal_aios")
        reset_hermes_home_override(token)


@pytest.mark.parametrize("stage", ["production", "staging"])
@pytest.mark.parametrize("paused", [False, True])
def test_product_watch_result_matches_persisted_reasoning_job(cron_tool, monkeypatch, stage, paused):
    from cron.jobs import get_job
    monkeypatch.setenv("PAIOS_STAGE", stage)
    watch = {"query_tool": "fixture_parcel_query", "query_args": {}, "status_field": "status",
             "from_status": "pending", "to_status": "arrived", "message": "Fixture parcel arrived"}
    created = json.loads(cron_tool({"action": "create", "schedule": "every 1m", "paused": paused,
        "prompt": "Use paios_watch_check for the saved watch", "skills": ["fixture-watch"], "standing_watch": watch}))
    assert created["success"], created
    assert "standing_watch" in created["job"]
    guidance = " ".join(created.get("guidance", []))
    assert "prompt/skills are ignored" not in guidance
    assert "Gateway" in guidance and "prompt and skills" in guidance
    assert ":thread_id" not in guidance
    job_id = created["job_id"]
    updated = json.loads(cron_tool({"action": "update", "job_id": job_id, "name": "Renamed fixture watch"}))
    assert updated["success"], updated
    listed = json.loads(cron_tool({"action": "list", "include_disabled": True}))
    assert listed["success"] and listed["count"] == 1, listed
    saved = get_job(job_id)
    for readback in (created["job"], updated["job"], listed["jobs"][0]):
        assert readback["standing_watch"] == saved["standing_watch"]
        assert readback["standing_watch"]["definition"] == watch
        assert readback["execution_mode"] == "gateway_admitted"
        assert readback["no_agent"] is True and readback["script"] == "personal-aios-task.py"
        assert readback["schedule"] == saved["schedule_display"]
        assert readback["next_run_at"] == saved["next_run_at"]
        assert readback["enabled"] is (not paused)
        assert readback["skills"] == ["fixture-watch"]
    assert "prompt/skills are ignored" not in " ".join(updated.get("guidance", []))


@pytest.mark.parametrize("script,deliver", [
    ("raw.py", "local"), ("personal-aios-task.py", "local"),
    ("raw.py", "personal_aios:fixture-owner"), ("personal-aios-task.py", "telegram:123"),
])
def test_raw_no_agent_keeps_native_guidance(cron_tool, tmp_path, script, deliver):
    from tools.cronjob_tools import _cronjob_handler
    (tmp_path / "scripts" / script).write_text('print("fixture")\n')
    result = json.loads(_cronjob_handler({"action": "create", "schedule": "every 5m",
        "script": script, "no_agent": True, "deliver": deliver}))
    assert result["success"], result
    guidance = " ".join(result["guidance"])
    assert "no_agent mode: stdout is delivered verbatim" in guidance
    assert "prompt/skills are ignored" in guidance
    assert "execution_mode" not in result["job"]
    assert (":thread_id" in guidance) is deliver.startswith("telegram:")


def test_native_watch_dispatch_decodes_real_mcp_results(tmp_path):
    from standing_watch_fixture import exercise
    message = '包裹到了。regression-native-watch-fixture'
    result = exercise(tmp_path, mcp=True, message=message)
    assert result['query_calls'] == 7
    assert result['state']['delivered_sequence'] == 2
    assert all(delivery['text'] == message for delivery in result['deliveries'])


@pytest.mark.parametrize("mutation", ["pause", "remove", "replace_state"])
def test_watch_does_not_deliver_or_overwrite_after_owner_change(monkeypatch, tmp_path, mutation):
    from cron.jobs import create_job, get_job, pause_job, remove_job, update_job
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from personal_aios.cron import target, TASK_SCRIPT
    from personal_aios.watch import definition, register
    from tools import personal_aios_dispatch

    started, release = Event(), Event()
    owner = {"principal_id": "owner", "device_id": "phone", "scheduled_captured_at": "2026-10-17T21:00:00.000Z"}
    state = definition({"query_tool": "fixture_query", "query_args": {}, "status_field": "status",
                        "from_status": "pending", "to_status": "arrived", "message": "包裹到了"})
    state["last_status"] = "pending"
    notifications, handlers = [], []

    def query(*args, **kwargs):
        started.set()
        assert release.wait(5), "fixture query was not released"
        return {"status": "arrived"}

    monkeypatch.setattr(personal_aios_dispatch, "dispatch_nested_tool", query)
    token = set_hermes_home_override(tmp_path)
    try:
        job = create_job(prompt="Watch fixture", schedule="every 5m", deliver=target(owner), script=TASK_SCRIPT, no_agent=True)
        update_job(job["id"], {"standing_watch": state})
        owner["scheduled_job_id"] = job["id"]
        provider = SimpleNamespace(_request=lambda path, body: owner if path.endswith("schedule-context") else
                                   notifications.append(body) or {"status": "delivered"})
        ctx = SimpleNamespace(register_tool=lambda *args, **kwargs: handlers.append(args[3]) or True)
        register(ctx, provider)
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(copy_context().run, handlers[0], {})
            try:
                assert started.wait(5), "watch query did not start"
                if mutation == "pause":
                    pause_job(job["id"])
                elif mutation == "remove":
                    assert remove_job(job["id"])
                else:
                    update_job(job["id"], {"standing_watch": {**state, "sequence": 9}})
            finally:
                release.set()
            result = json.loads(future.result(timeout=5))
        assert result == {"status": "silent", "reason": "watch_changed_during_query"}
        assert notifications == []
        current = get_job(job["id"])
        if mutation == "pause":
            assert not current["enabled"] and current["standing_watch"] == state
        elif mutation == "remove":
            assert current is None
        else:
            assert current["standing_watch"]["sequence"] == 9
    finally:
        reset_hermes_home_override(token)


def test_first_target_observation_notifies_once_and_restart_keeps_receipt(monkeypatch, tmp_path):
    import importlib
    from cron.jobs import create_job, get_job, update_job
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from personal_aios.cron import target, TASK_SCRIPT
    from personal_aios import watch
    from tools import personal_aios_dispatch

    owner = {"principal_id": "owner", "device_id": "phone", "scheduled_captured_at": "2026-10-17T21:00:00.000Z"}
    notifications, handlers, queries = [], [], []
    monkeypatch.setattr(personal_aios_dispatch, "dispatch_nested_tool", lambda *args, **kwargs:
                        queries.append(args) or {"status": "arrived"})
    token = set_hermes_home_override(tmp_path)
    try:
        job = create_job(prompt="Watch fixture", schedule="every 5m", deliver=target(owner), script=TASK_SCRIPT, no_agent=True)
        state = watch.definition({"query_tool": "fixture_query", "query_args": {}, "status_field": "status",
                                  "from_status": "pending", "to_status": "arrived", "message": "包裹到了"})
        assert state["last_status"] is None
        update_job(job["id"], {"standing_watch": state})
        owner["scheduled_job_id"] = job["id"]
        provider = SimpleNamespace(_request=lambda path, body: owner if path.endswith("schedule-context") else
                                   notifications.append(body) or {"status": "delivered"})
        ctx = SimpleNamespace(register_tool=lambda *args, **kwargs: handlers.append(args[3]) or True)
        watch.register(ctx, provider)
        assert json.loads(handlers[-1]({}))["status"] == "delivered"
        assert json.loads(handlers[-1]({}))["status"] == "silent"
        importlib.reload(watch)
        watch.register(ctx, provider)
        assert json.loads(handlers[-1]({}))["status"] == "silent"
        assert len(notifications) == 1 and len(queries) == 3
        saved = get_job(job["id"])["standing_watch"]
        assert saved["last_status"] == "arrived" and saved["delivered_sequence"] == 1
    finally:
        reset_hermes_home_override(token)
