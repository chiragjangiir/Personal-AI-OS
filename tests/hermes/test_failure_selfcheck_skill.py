"""Failure recovery uses native skill authority and the existing repair boundary."""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from test_skill_authority import profile, manage, PRODUCT


def test_selfcheck_is_native_product_skill(profile):
    from tools.skills_tool import skill_view
    from tools.delegate_tool_progress import _build_child_system_prompt
    result = json.loads(skill_view('failure-selfcheck'))
    assert result['success'], result
    assert Path(result['_source_path']) == PRODUCT / 'errands/failure-selfcheck/SKILL.md'
    child = _build_child_system_prompt('自检：查店铺', context=result['content'])
    for required in ('phone_status', 'session_search', 'CheckoutStop', 'build_input_ref',
                     'cancelled_by_user', '只读核对', 'skill_manage', 'applied=false'):
        assert required in child


def test_delivery_failure_selfcheck_reads_the_recorded_cause_not_log_channel(profile):
    from tools.skills_tool import skill_view
    from tools.delegate_tool_progress import _build_child_system_prompt
    from gateway.platforms.api_run_delegation import RunDelegation
    app = {'kind': 'errand_delivery_failed', 'job_id': 'job-63e081726062', 'title': '在 fixture 微信中给联系人', 'task': '发送文本',
           'terminal_reason': 'failed', 'error_code': 'ERRAND_REPORT_NOT_DELIVERED', 'stage': 'report_run',
           'reason': 'report run run-1 ended failed before recipient selection',
           'evidence_ref': {'tool': 'phone_status', 'job_id': 'job-63e081726062'}}
    failure = RunDelegation.failure_metadata({'delegation_id': app['job_id'], 'source': 'errand', 'goal': app['title'],
        'status': app['terminal_reason'], 'error': app['error_code'], 'task': app['task'], 'evidence_ref': app['evidence_ref']}, {})
    content = json.loads(skill_view('failure-selfcheck'))['content']
    child = _build_child_system_prompt('自检：' + failure['title'], context=content + '\nFailure evidence:\n' + json.dumps(failure, ensure_ascii=False))
    assert 'execution、delivery、task_retry_allowed' in child
    assert '只报告记录支持的事实' in child
    main = (PRODUCT / 'skills/personal-aios-main/SKILL.md').read_text()
    assert '只报告记录支持的事实' in main
    assert '活动自检接收其结果，不开启独立主人汇报' in main
    assert '进入本轮的 errand_result 都须用 text/voice 汇报' in main
    assert 'ERRAND_REPORT_REQUIRED' in main



def test_recovery_tools_are_registered_native_contracts(profile):
    from tools import skills_tool, skill_manager_tool, session_search_tool
    from tools.registry import registry
    for name in ('skill_view', 'skill_manage', 'session_search'):
        assert registry.get_entry(name), name
    schema = registry.get_schema('session_search')['parameters']['properties']
    assert 'session_id' in schema  # Native session-read mode; no invented session_read tool.
    assert registry.get_entry('skill_product.propose') is None
    assert registry.get_entry('session_read') is None


def test_selfcheck_product_lesson_is_candidate_and_repair_rejects_child(profile, monkeypatch):
    from tools.skills_tool import skill_view
    from integrations.hermes.personal_aios import workshop
    from gateway import run_scope
    result = json.loads(skill_view('failure-selfcheck'))
    assert result['success'], result
    original = result['content']
    proposal = manage('patch', 'failure-selfcheck', old_string='# 失败自检',
                      new_string='# 失败自检\n已验证的通用经验。')
    assert proposal['success'] and proposal['applied'] is False, proposal
    assert Path(proposal['release_candidate']).is_file()
    assert json.loads(skill_view('failure-selfcheck'))['content'] == original
    registered = {}
    workshop.register(SimpleNamespace(register_tool=lambda name, toolset, schema, handler:
                                      registered.update({name: (schema, handler)})))
    schema, hub = registered['skills_hub']
    assert 'repair' in schema['parameters']['properties']['action']['enum']
    monkeypatch.setattr(run_scope, 'current_scope', lambda: 'child')
    with pytest.raises(ValueError, match='background build task'):
        hub({'action': 'repair', 'value': 'Data-free executor timeout defect.'})
