"""Native delegated experience review, with a scripted model and real skill storage."""
import json
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
    monkeypatch.setattr('run_agent.threading.Thread', DeferredThread)
    try:
        yield root, child, queue, clock, targets
    finally:
        child.close()
        root.close()
        reset_hermes_home_override(token)


def finish(child):
    from agent.turn_finalizer import finalize_turn
    return finalize_turn(child, final_response='work done', api_call_count=10,
        interrupted=False, failed=False, messages=[
            {'role': 'user', 'content': 'learn from this work'},
            {'role': 'tool', 'tool_call_id': 'work', 'content': 'verified task evidence'},
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
