"""The main prompt uses native steering and preserves both delivery outcomes."""
import json
from pathlib import Path
import weakref

import pytest

from gateway.run_scope import tool_block
from run_agent import AIAgent
from tools.delegate_tool_child_run import _build_result_entry, _merge_late_steer, _SchemaOutcome
from tools.delegate_tool_registry import _handle_control_action, _register_subagent, _unregister_subagent

PRODUCT = Path(__file__).resolve().parents[2] / 'integrations/hermes/personal_aios'


@pytest.mark.parametrize('path', ['persona/yimi.md', 'skills/personal-aios-main/SKILL.md'])
def test_main_guidance_names_available_steer_and_its_receipt_limits(path):
    text = (PRODUCT / path).read_text()
    assert 'paios_task_amend' not in text
    assert 'list/status/cancel/rebrief' not in text
    assert 'delegate_task(action="steer"' in text
    assert 'subagent_id' in text and 'missed_steer' in text
    assert 'queued' in text and '下一次工具结果' in text


@pytest.mark.parametrize('finishes_first', [False, True])
def test_native_main_steer_delivered_at_boundary_or_returned_as_missed(finishes_first):
    main, child = AIAgent.__new__(AIAgent), AIAgent.__new__(AIAgent)
    main._paios_delegate_toolsets, main._delegate_depth = ['skills'], 0
    main.session_id = 'growth-main'
    child._delegate_parent_ref = weakref.ref(main)
    child.session_id, child.model, child._delegate_role = 'growth-child', 'fixture', 'leaf'
    child._interrupt_requested = False
    sid, addition = 'growth-steer-fixture', '补充：保留原来的 Sheet1 和 Sheet2。'
    _register_subagent({'subagent_id': sid, 'agent': child, 'goal': 'edit sheet', 'status': 'running'})
    try:
        assert tool_block(main, 'paios_task_amend') is not None
        assert tool_block(main, 'delegate_task') is None
        listing = json.loads(_handle_control_action('list', None, None, main))
        assert sid in {entry['subagent_id'] for entry in listing['subagents']}
        receipt = json.loads(_handle_control_action('steer', sid, addition, main))
        assert receipt['status'] == 'queued' and not child._interrupt_requested
        result = {'final_response': 'original work complete', 'completed': True, 'messages': [], 'api_calls': 1}
        if finishes_first:
            _merge_late_steer(result, sid, child)
            entry = _build_result_entry(child, result, 0, 1, _SchemaOutcome(None, None, [], 0))
            assert entry['missed_steer'] == addition
            assert addition in entry['summary']
            assert 'error' in json.loads(_handle_control_action('steer', sid, 'too late', main))
        else:
            messages = [{'role': 'tool', 'tool_call_id': 'work', 'content': 'unchanged tool evidence'}]
            child._apply_pending_steer_to_tool_results(messages, 1)
            assert messages[0]['content'] == 'unchanged tool evidence'
            assert messages[-1]['role'] == 'user' and addition in messages[-1]['content']
            _merge_late_steer(result, sid, child)
            assert 'pending_steer' not in result
        assert child._drain_pending_steer() is None
    finally:
        _unregister_subagent(sid, agent=child)
