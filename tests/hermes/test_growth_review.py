"""Native delegated experience review, with a scripted model and real skill storage."""
import json
from pathlib import Path
import threading
from types import SimpleNamespace
import weakref

import pytest

from agent import background_review as review
from agent.review_idle_queue import ReviewIdleQueue
from gateway.run_scope import restrict_agent
from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from run_agent import AIAgent
from tests.agent.test_skip_background_review import _make_agent, _stub_agent_for_finalize


@pytest.fixture
def run(tmp_path, monkeypatch):
    token = set_hermes_home_override(tmp_path)
    root, child = _make_agent(), _make_agent()
    root._paios_delegate_toolsets = child._paios_delegate_toolsets = ['skills']
    child._delegate_depth = 1
    child._delegate_parent_ref = weakref.ref(root)
    _stub_agent_for_finalize(child)
    child._spawn_background_review = AIAgent._spawn_background_review.__get__(child)
    child._iters_since_skill = 10
    queue, clock, targets = ReviewIdleQueue(), [0.0], []
    queue._now = lambda: clock[0]
    queue._server_idle = lambda: True
    queue._ensure_thread = lambda: None
    monkeypatch.setattr('agent.review_idle_queue.QUEUE', queue)
    monkeypatch.setattr(review, 'load_background_review_settings', lambda: (True, {}))
    monkeypatch.setattr('agent.review_idle_queue.review_targets_managed_local', lambda *_: False)
    class DeferredThread:
        def __init__(self, *, target, **kwargs):
            targets.append(target)
        def start(self):
            pass
    monkeypatch.setattr('run_agent.threading', SimpleNamespace(**(vars(threading) | {'Thread': DeferredThread})))
    try:
        yield root, child, queue, clock, targets
    finally:
        child.close()
        root.close()
        reset_hermes_home_override(token)


def finish(child, evidence='verified task evidence'):
    from agent.turn_finalizer import finalize_turn
    return finalize_turn(child, final_response='work done', api_call_count=10,
        interrupted=False, failed=False, messages=[
            {'role': 'user', 'content': 'learn from this work'},
            {'role': 'tool', 'tool_call_id': 'work', 'content': evidence},
            {'role': 'assistant', 'content': 'work done'}],
        conversation_history=[], effective_task_id='work', turn_id='turn',
        user_message='work', original_user_message='work', _should_review_memory=False,
        _turn_exit_reason='text_response(10)')


def dispatch(queue, clock):
    queue.note_turn_finished()
    clock[0] += 16
    item = queue._pop_dispatchable()
    assert item is not None, 'eligible delegated work never entered native review'
    item.agent._spawn_background_review_now(**item.kwargs)


@pytest.fixture
def product_review_context(run, monkeypatch):
    from hermes_cli import plugins
    from hermes_constants import get_hermes_home
    monkeypatch.syspath_prepend(str(Path(__file__).parents[2] / 'integrations/hermes'))
    import personal_aios
    manager = plugins.PluginManager()
    manager._discovered = True
    monkeypatch.delenv('PAIOS_WORKSHOP_HOST', raising=False)
    monkeypatch.setattr(plugins, '_plugin_manager', manager)
    (get_hermes_home() / 'config.yaml').write_text(
        'plugins:\n  allow_deprecated_imports: true\n  entries:\n    personal_aios:\n      allow_tool_override: true\n')
    try:
        from plugins.memory import _load_provider_from_dir
        source = Path(personal_aios.__file__).parent
        assert _load_provider_from_dir(source) is not None
        manager._load_plugin(plugins.PluginManifest(
            name='personal_aios', key='personal_aios', source='user', path=str(source)))
        assert manager._plugins['personal_aios'].enabled
        yield personal_aios.EXPERIENCE_REVIEW_CONTEXT
    finally:
        manager.unload()


@pytest.mark.parametrize('routed', [False, True], ids=['same-model', 'routed'])
@pytest.mark.parametrize('case, facts, target', [
    ('qualifying', {'seconds': 75, 'calls': 8, 'verified': True,
                    'owner_rescue': False, 'repeated_trials': False, 'safe': True}, 'mac-messaging'),
    ('slow', {'seconds': 1800, 'calls': 90, 'verified': True}, 'engineering-handbook'),
    ('unverified', {'seconds': 75, 'calls': 8, 'verified': False}, 'engineering-handbook'),
    ('owner-rescued', {'seconds': 75, 'calls': 8, 'owner_rescue': True}, 'engineering-handbook'),
    ('trial-and-error', {'seconds': 75, 'calls': 8, 'repeated_trials': True}, 'engineering-handbook'),
    ('unsafe', {'seconds': 75, 'calls': 8, 'safe': False}, 'engineering-handbook'),
    ('unknown-measurement', {'seconds': None, 'calls': None}, 'engineering-handbook'),
])
def test_review_receives_product_bar_and_persists_scripted_learning(
        run, monkeypatch, product_review_context, routed, case, facts, target):
    """Transport/storage contract with prescribed model replies; live brain replay tests judgment."""
    from agent.system_prompt import build_system_prompt
    from tools.skill_manager_tool import skill_manage
    from tools.skill_provenance import set_current_write_origin, reset_current_write_origin
    from tools.skills_tool import skill_view
    root, child, queue, clock, targets = run
    origin = set_current_write_origin('background_review')
    try:
        for name in ('mac-messaging', 'engineering-handbook'):
            result = json.loads(skill_manage('create', name, content=(
                f'---\nname: {name}\ndescription: Reusable execution guidance.\n---\nBaseline.\n')))
            assert result['success'], result
    finally:
        reset_current_write_origin(origin)
    baseline = json.loads(skill_view('mac-messaging'))['content']
    facts = {'family': 'Mac WeChat text', 'date': '2026-10-23',
             'device': 'Mac', 'app_version': 'WeChat 4.1.15', **facts}
    evidence = json.dumps(facts, sort_keys=True)
    # The fixture supplies a model response, rather than implementing a second success classifier.
    replacements = {
        'mac-messaging': 'Fast path: prepare → consent → send → verify. 75s, 8 calls; '
                         '2026-10-23; Mac; WeChat 4.1.15; visible message evidence.',
        'engineering-handbook': f'Lesson ({case}): keep the failed qualification evidence; '
                                'do not reuse this run as a successful how-to.',
    }
    operation = {'action': 'patch', 'name': target, 'old_string': 'Baseline.',
                 'new_string': replacements[target]}
    child._cached_system_prompt = build_system_prompt(child)
    assert product_review_context in child._cached_system_prompt
    monkeypatch.setattr(review, '_parent_can_emit_tool_calls', lambda _: True)
    monkeypatch.setattr(review, '_resolve_review_runtime', lambda *_: {
        'model': 'test-review' if routed else child.model, 'provider': child.provider,
        'base_url': child.base_url, 'api_key': 'test-key', 'routed': routed})
    received = []
    def scripted_review(self, *, user_message, conversation_history):
        from hermes_cli.plugins import get_pre_tool_call_block_message
        prompt = self._cached_system_prompt or build_system_prompt(self)
        assert prompt.count(product_review_context) == 1
        assert 'Mac WeChat text' in str(conversation_history)
        assert get_pre_tool_call_block_message('terminal', {}) is not None
        received.append(prompt)
        origin = set_current_write_origin(self._memory_write_origin)
        try:
            assert json.loads(skill_view(target))['success']
            saved = skill_manage(**operation)
            assert json.loads(saved)['success'], saved
        finally:
            reset_current_write_origin(origin)
        self._session_messages = conversation_history + [
            {'role': 'tool', 'name': 'skill_manage', 'content': saved}]
    monkeypatch.setattr(AIAgent, 'run_conversation', scripted_review)
    finish(child, evidence)
    dispatch(queue, clock)
    targets.pop()()
    assert len(received) == 1
    assert replacements[target] in json.loads(skill_view(target))['content']
    if target == 'engineering-handbook':
        assert json.loads(skill_view('mac-messaging'))['content'] == baseline
    assert root._background_review_run is None


def test_child_experience_survives_close_and_native_review_saves_skill(run, monkeypatch):
    root, child, queue, clock, targets = run
    notifications, forks = [], []
    root.background_review_callback = notifications.append
    monkeypatch.setattr(review, '_parent_can_emit_tool_calls', lambda _: True)
    def scripted_review(self, *, user_message, conversation_history):
        from hermes_cli.plugins import get_pre_tool_call_block_message
        from tools.skill_manager_tool import skill_manage
        from tools.skill_provenance import set_current_write_origin, reset_current_write_origin
        forks.append(self)
        assert self in root._active_children and self not in child._active_children
        assert 'verified task evidence' in str(conversation_history)
        assert get_pre_tool_call_block_message('terminal', {}) is not None
        assert get_pre_tool_call_block_message('skill_manage', {}) is None
        origin = set_current_write_origin(self._memory_write_origin)
        try:
            saved = skill_manage('create', 'verified-lesson', content=(
                '---\nname: verified-lesson\ndescription: Reuse verified work evidence.\n---\n'
                '# Verified lesson\nKeep the observed result when summarizing a task.\n'))
        finally:
            reset_current_write_origin(origin)
        assert json.loads(saved)['success'], saved
        self._session_messages = conversation_history + [
            {'role': 'tool', 'name': 'skill_manage', 'content': saved}]
    monkeypatch.setattr(AIAgent, 'run_conversation', scripted_review)
    finish(child)
    assert queue.pending_count() == 1 and not targets
    queue.note_turn_started()
    clock[0] += 31 * 60  # Aged reviews still yield to live conversation turns.
    assert queue._pop_dispatchable() is None
    child.close()
    dispatch(queue, clock)
    assert root._background_review_run is not None and child._background_review_run is None
    targets.pop()()
    from tools.skills_tool import skill_view
    assert json.loads(skill_view('verified-lesson'))['success']
    assert len(forks) == 1 and notifications
    assert root._background_review_run is None and not root._active_children


def test_new_parent_turn_cancels_queued_child_review_before_model_call(run, monkeypatch):
    root, child, queue, clock, targets = run
    finish(child)
    dispatch(queue, clock)
    monkeypatch.setattr(review, '_BACKGROUND_REVIEW_CANCEL_TIMEOUT_SECONDS', 0)
    review.cancel_background_review_for_live_turn(root)
    assert root._background_review_run.cancel_requested.is_set()
    monkeypatch.setattr(AIAgent, 'run_conversation', lambda *_a, **_k: pytest.fail('cancelled review ran'))
    targets.pop()()
    assert root._background_review_run is None


def test_sibling_reviews_wait_in_native_queue_for_the_same_conversation(run, monkeypatch):
    root, child, queue, clock, targets = run
    second = _make_agent()
    _stub_agent_for_finalize(second)
    second._paios_delegate_toolsets, second._delegate_depth = ['skills'], 1
    second._delegate_parent_ref = weakref.ref(root)
    second._spawn_background_review = AIAgent._spawn_background_review.__get__(second)
    second.session_id = 'second-execution'
    reviewed = []
    def worker(agent, *args, review_run, **kwargs):
        reviewed.append(agent.session_id)
        review.finish_background_review_run(agent, review_run)
    monkeypatch.setattr(review, '_run_review_in_thread', worker)
    try:
        finish(child)
        dispatch(queue, clock)
        finish(second)
        assert queue._pop_dispatchable() is None
        assert len(targets) == 1 and queue.pending_count() == 1
        targets.pop()()
        dispatch(queue, clock)
        targets.pop()()
        assert reviewed == [child.session_id, second.session_id]
    finally:
        second.close()


@pytest.mark.parametrize('boundary', ['below_threshold', 'ordinary_child', 'guest', 'owner_uncertain', 'disabled'])
def test_native_review_boundaries_stay_closed(run, monkeypatch, boundary):
    root, child, queue, clock, targets = run
    if boundary == 'below_threshold':
        child._iters_since_skill = 9
    elif boundary == 'ordinary_child':
        del child._paios_delegate_toolsets
    elif boundary == 'disabled':
        monkeypatch.setattr(review, 'load_background_review_settings', lambda: (False, {}))
    else:
        restrict_agent(child, boundary)
    finish(child)
    assert queue.pending_count() == 0 and not targets
