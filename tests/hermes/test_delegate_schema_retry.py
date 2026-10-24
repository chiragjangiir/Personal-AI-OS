"""Schema repair cannot replay work, including calls emitted despite an empty tool list."""
import copy
import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from hermes_state import SessionDB
from tools.delegate_tool_child_run import _build_result_entry, _validate_child_output_schema
from tools.personal_aios_task_outcome import task_outcome_schema


ANSWER = json.dumps({'outcome': 'succeeded', 'reason': '', 'summary': '已完成一次'})
TOOL = {'type': 'function', 'function': {'name': 'fixture_effect', 'description': 'Synthetic effect',
        'parameters': {'type': 'object', 'properties': {}}}}


@pytest.fixture
def child(tmp_path, monkeypatch):
    from openai.types.chat import ChatCompletion
    from run_agent import AIAgent
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    (tmp_path / 'config.yaml').write_text('model:\n  context_length: 64000\n'
        'agent:\n  api_max_retries: 1\n  auto_recovery_cycles: 0\n'
        'auxiliary:\n  title_generation:\n    enabled: false\n')
    token = set_hermes_home_override(tmp_path)
    monkeypatch.setattr('agent.model_metadata.fetch_model_metadata', lambda *a, **kw: {})
    monkeypatch.setattr('model_tools.get_tool_definitions', lambda **kw: [copy.deepcopy(TOOL)])
    monkeypatch.setattr('model_tools.check_toolset_requirements', lambda **kw: {})
    db = SessionDB(tmp_path / 'state.db')
    state = SimpleNamespace(db=db, replies=[], requests=[], effects=[])

    def complete(**kwargs):
        state.requests.append(copy.deepcopy(kwargs))
        reply = state.replies.pop(0)
        message = {'role': 'assistant', 'content': reply}
        if reply is None:
            message['tool_calls'] = [{'id': f'call-{len(state.requests)}', 'type': 'function',
                                     'function': {'name': 'fixture_effect', 'arguments': '{}'}}]
        return ChatCompletion(id='fixture', object='chat.completion', created=0, model='fixture',
            choices=[{'index': 0, 'message': message, 'finish_reason': 'tool_calls' if reply is None else 'stop'}])

    def effect(name, args, *a, **kw):
        state.effects.append(name)
        return '{"success":true,"receipt":"synthetic-once"}'

    client = MagicMock()
    client.chat.completions.create.side_effect = complete
    monkeypatch.setattr('agent.process_bootstrap.OpenAI', lambda **kw: client)
    monkeypatch.setattr('model_tools.handle_function_call', effect)
    agent = AIAgent(api_key='fixture', base_url='http://127.0.0.1:1/v1', provider='custom', model='fixture',
        session_id='schema-child', session_db=db, platform='subagent', max_iterations=8, quiet_mode=True,
        enabled_toolsets=[], skip_context_files=True, skip_memory=True, skip_background_review=True,
        load_soul_identity=False, save_trajectories=False)
    agent._disable_streaming = True
    agent.compression_enabled = False
    state.agent = agent
    try:
        yield state
    finally:
        agent.close()
        db.close()
        reset_hermes_home_override(token)


@pytest.mark.parametrize('retry', ['tool_call', 'invalid', 'exception'])
def test_schema_repair_has_no_tools_and_normal_turn_restores_them(child, monkeypatch, retry):
    agent = child.agent
    agent._delegate_output_schema = task_outcome_schema()
    child.replies = [None, '已执行，但不是合同 JSON']
    result = agent.run_conversation('执行一次，然后报告')
    assert result['completed'] and child.effects == ['fixture_effect'], result
    original_pin = child.db.get_session(agent.session_id)['tool_names']
    original_tools = copy.deepcopy(agent.tools)
    retry_start = len(child.requests)
    child.replies = [None, ANSWER] if retry == 'tool_call' else ['仍然不是 JSON']
    with monkeypatch.context() as patch:
        if retry == 'exception':
            def fail(**kwargs):
                raise RuntimeError('synthetic repair interruption')
            patch.setattr(agent, 'run_conversation', fail)
        outcome = _validate_child_output_schema(agent, result, 0, 'task', None)
    assert child.effects == ['fixture_effect'], 'format repair repeated a completed effect'
    assert outcome.retries == 1 and outcome.valid == (retry == 'tool_call')
    assert all(not request.get('tools') for request in child.requests[retry_start:])
    if retry == 'tool_call':
        assert result['final_response'] == ANSWER
        assert 'synthetic-once' in json.dumps(child.requests[retry_start]['messages'])
        assert sum('synthetic-once' in str(message.get('content'))
                   for message in result['messages'] if message['role'] == 'tool') == 1
    assert agent.tools == original_tools and agent.valid_tool_names == {'fixture_effect'}
    assert child.db.get_session(agent.session_id)['tool_names'] == original_pin
    assert not getattr(agent, '_delegate_schema_repair', False)
    child.replies = [None, ANSWER]
    normal = agent.run_conversation('新的正常任务')
    assert normal['completed'] and child.effects == ['fixture_effect', 'fixture_effect']
    assert child.requests[-2]['tools'] == original_tools


@pytest.mark.parametrize('schema', [None, task_outcome_schema()])
def test_valid_and_schema_less_children_preserve_the_original_result(child, schema):
    agent = child.agent
    if schema is not None:
        agent._delegate_output_schema = schema
    child.replies = [None, ANSWER if schema else '原样保留\n  spaces  \n']
    result = agent.run_conversation('执行一次')
    before = json.dumps(result, ensure_ascii=False).encode()
    outcome = _validate_child_output_schema(agent, result, 0, 'task', None)
    assert json.dumps(result, ensure_ascii=False).encode() == before
    assert len(child.requests) == 2 and child.effects == ['fixture_effect']
    assert outcome.retries == 0 and outcome.valid is (True if schema else None)
    if schema is None:
        entry = _build_result_entry(agent, result, 0, 1, outcome)
        assert not {'schema_valid', 'schema_errors', 'schema_retries', 'schema_note'} & entry.keys()
