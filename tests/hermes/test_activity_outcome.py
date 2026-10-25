"""The native child owns its task outcome; activity events preserve that contract."""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from tools.delegate_tool_child_run import _build_result_entry, _SchemaOutcome
from test_activity_phase2 import native_run

SCHEMA = {"$id": "paios.task-outcome.v1", "type": "object"}


@pytest.mark.parametrize("outcome,reason", [
    ("succeeded", ""), ("partial", "报表已完成；发送已停止"),
    ("failed", "无法生成报表"), ("cancelled", "主人已取消"),
])
def test_native_business_outcome_is_not_summary_presence(outcome, reason):
    result = {"completed": True, "final_response": json.dumps({
        "outcome": outcome, "reason": reason, "summary": "synthetic evidence"})}
    entry = _build_result_entry(SimpleNamespace(), result, 0, 61, _SchemaOutcome(SCHEMA, True, [], 0))
    assert entry["outcome"] == outcome
    assert entry["outcome_reason"] == reason
    from tools.delegate_tool_child_run import _ChildRun
    emitted = []
    run = _ChildRun.__new__(_ChildRun)
    run.child, run.child_task_id, run.wall_start = SimpleNamespace(), "synthetic", 0
    run.child_progress_cb = lambda event, **fields: emitted.append((event, fields))
    run.emit_complete(result, entry, 61)
    assert emitted[0][0] == "subagent.complete"
    assert emitted[0][1]["outcome"] == outcome
    assert emitted[0][1]["outcome_reason"] == reason


@pytest.mark.parametrize("fields,valid,expected", [
    ({"completed": False}, True, "partial"),
    ({"completed": True}, False, "failed"),
    ({"completed": True, "failed": True, "error": "provider rejected"}, True, "failed"),
    ({"interrupted": True}, True, "cancelled"),
])
def test_native_exit_and_schema_failure_dominate_a_claim_of_success(fields, valid, expected):
    result = {**fields, "final_response": json.dumps({"outcome": "succeeded", "reason": "", "summary": "evidence"})}
    entry = _build_result_entry(SimpleNamespace(), result, 0, 61, _SchemaOutcome(SCHEMA, valid, [], 0))
    assert entry["outcome"] == expected
    assert entry["outcome_reason"]


@pytest.mark.parametrize("fields", [{"failed": True, "error": "provider rejected"}, {"completed": False}])
def test_verified_partial_work_keeps_its_actual_reason_after_a_runtime_failure(fields):
    result = {**fields, "final_response": json.dumps({
        "outcome": "partial", "reason": "报表已完成；发送已停止", "summary": "synthetic evidence"})}
    entry = _build_result_entry(SimpleNamespace(), result, 0, 61, _SchemaOutcome(SCHEMA, True, [], 0))
    assert entry["outcome"] == "partial" and entry["outcome_reason"] == "报表已完成；发送已停止"


def test_watchdog_interruption_is_not_an_owner_cancellation():
    entry = _build_result_entry(SimpleNamespace(_tool_interrupt_reason="watchdog timeout"),
        {"interrupted": True, "final_response": "Operation interrupted."}, 0, 61, _SchemaOutcome(SCHEMA, False, [], 0))
    assert entry["cancelled_by_user"] is False
    assert entry["outcome"] == "failed" and "中断" in entry["outcome_reason"]


def test_native_product_delegation_attaches_result_contract_and_keeps_short_goal(monkeypatch):
    from tools import delegate_tool
    from tools.delegate_tool_routes import TaskRoute
    built = []
    def build(**kwargs):
        built.append(kwargs)
        return SimpleNamespace()
    monkeypatch.setattr(delegate_tool, "_build_child_preserving_parent_tools", build)
    title, task = "计算报表并发送", "生成测试报表，保存结果，再通过已授权渠道发送。"
    children, error = delegate_tool._build_children(
        task_list=[{"goal": title, "context": task}], task_schemas=[None],
        routes=[TaskRoute(
            dict.fromkeys(["provider", "base_url", "api_key", "api_mode", "model"]), {})],
        top_role="leaf", max_iterations=10,
        parent_agent=SimpleNamespace(_paios_delegate_toolsets=["skills"]),
        live_deleg_id=None, live_writers=[])
    assert error is None and len(children) == 1
    assert built[0]["goal"] == title and task in built[0]["context"]
    assert "paios.task-outcome.v1" in built[0]["context"]
    schema = children[0][2]._delegate_output_schema
    child = children[0][2]
    entry = _build_result_entry(child, {"completed": True, "final_response": json.dumps({
        "outcome": "partial", "reason": "发送已停止", "summary": "报表已完成"})}, 0, 61, _SchemaOutcome(schema, True, [], 0))
    from gateway.platforms.api_run_delegation import RunDelegation
    failure = RunDelegation.failure_metadata({"delegation_id": "synthetic", "goals": [title]}, entry)
    assert failure["title"] == title and failure["task"] == task
    from tools.delegation_output_schema import validate_output
    assert validate_output(json.dumps({"outcome": "partial", "reason": "发送已停止", "summary": "报表已完成"}), schema)[0]
    assert not validate_output(json.dumps({"outcome": "partial", "reason": "", "summary": "报表已完成"}), schema)[0]
    assert not validate_output(json.dumps({"outcome": "succeeded", "reason": "发送未完成", "summary": "报表已完成"}), schema)[0]


def test_main_skill_supplies_short_titles_in_the_owners_language():
    text = (Path(__file__).resolve().parents[2] / "integrations/hermes/personal_aios/skills/personal-aios-main/SKILL.md").read_text()
    assert "goal" in text and "短标题" in text and "主人的语言" in text
    assert "phone_task" in text and "title" in text


@pytest.mark.asyncio
async def test_native_activity_publishes_authoritative_outcome_without_cutting_the_goal(native_run):
    from test_activity_phase2 import reserve
    adapter = native_run()
    reserve(adapter)
    callback = adapter._make_run_event_callback("run", asyncio.get_running_loop())
    goal = "生成测试报表并保存结果，然后通过指定渠道发送，最后核对收件记录和所有输出文件是否完整，确认全部目标完成再汇总报告"
    assert len(goal) > 48
    callback("subagent.start", goal=goal, subagent_id="child")
    callback("subagent.complete", subagent_id="child", status="completed", exit_reason="completed",
             outcome="partial", outcome_reason="报表已完成；发送已停止")
    await asyncio.sleep(0)
    events = adapter._run_statuses["run"]["activity_events"]
    assert events[0]["goal"] == goal
    assert events[1]["outcome"] == "partial" and events[1]["outcome_reason"] == "报表已完成；发送已停止"
    assert events[1]["exit_reason"] == "completed"


@pytest.mark.parametrize("resource_id", [None, "urn:fixture:custom-result"])
def test_custom_result_schema_keeps_its_reference_resource(resource_id):
    from tools.delegation_output_schema import validate_output
    from tools.personal_aios_task_outcome import task_outcome_schema
    custom = {"type": "object", "$defs": {"number": {"type": "integer"}},
              "properties": {"value": {"$ref": "#/$defs/number"}}, "required": ["value"]}
    if resource_id is not None:
        custom["$id"] = resource_id
    assert validate_output('{"value":1}', custom)[0]
    wrapped = task_outcome_schema(custom)
    assert validate_output(json.dumps({"outcome": "succeeded", "reason": "", "summary": "synthetic",
                                       "result": {"value": 1}}), wrapped)[0]
    assert custom.get("$id") == resource_id
