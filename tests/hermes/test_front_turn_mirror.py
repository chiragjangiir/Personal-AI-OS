"""Front-only speech enters the existing native session authority without invoking an agent."""
import importlib.util
import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from aiohttp import web
from hermes_state import SessionDB
from gateway.platforms.api_server import APIServerAdapter


def bridge():
    path = Path(__file__).parents[2] / 'integrations/hermes/personal_aios/run_api.py'
    spec = importlib.util.spec_from_file_location('isolated_front_turn_bridge', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.asyncio
@pytest.mark.parametrize("assistant", ["好，你刚吃了面条。", "这是完整的长篇讲解。" * 8000], ids=["ordinary", "long_form"])
async def test_front_mirror_survives_restart_is_native_readable_and_does_not_touch_active_brain(tmp_path, assistant):
    module = bridge()
    db = SessionDB(tmp_path / 'state.db')
    db.create_session('conversation', 'api_server')
    db.append_message('conversation', 'user', 'slow task')
    holder = 'pid=1:turn=slow:platform=api_server'
    assert db.acquire_session_turn_lease('conversation', holder, wait_seconds=0)
    d = {'processed_event_id': 'front-event', 'principal_id': 'owner', 'user_identity': 'owner',
        'origin': 'device_observation', 'media_type': 'app_event', 'captured_at': '2026-10-17T12:00:00Z',
        'content': {'app_event': {'kind': 'voice_turn', 'user': '记住我刚吃了面条。', 'assistant': assistant, 'speaker': 'owner'}}}
    body = {'session_id': 'conversation', 'processed_event_id': 'front-event',
        'input': json.dumps(d, ensure_ascii=False), 'captured_at': d['captured_at']}
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: module.mirror_front_turn(db, body), range(2)))
        front = results[0]['session_id']
        assert front != 'conversation'
        assert sorted(r['replayed'] for r in results) == [False, True]
        assert [m['content'] for m in db.get_messages('conversation')] == ['slow task']
        assert db.resolve_resume_session_id('conversation') == 'conversation'
        assert db.get_session(front)['session_key'] == 'conversation'
        assert db.get_session(front)['source'] == 'voice_front'
        assert db.get_session(front)['message_count'] == 1
        conflict = json.loads(body['input'])
        conflict['content']['app_event']['assistant'] = 'changed'
        with pytest.raises(web.HTTPConflict):
            module.mirror_front_turn(db, {**body, 'input': json.dumps(conflict, ensure_ascii=False)})
    finally:
        db.release_session_turn_lease('conversation', holder)
        db.close()
    db = SessionDB(tmp_path / 'state.db')
    try:
        assert module.mirror_front_turn(db, body)['replayed'] is True
        # Exercise the official native messages API used by HermesClient.messages on the next call.
        adapter = object.__new__(APIServerAdapter)
        adapter._check_auth = lambda request: None
        adapter._ensure_session_db_async = AsyncMock(return_value=db)
        request = SimpleNamespace(match_info={'session_id': front}, query={'order': 'latest', 'limit': '40'})
        response = await adapter._handle_session_messages(request)
        payload = json.loads(response.text)
        listed = await adapter._handle_list_sessions(SimpleNamespace(query={'limit': '8'}))
        sessions = json.loads(listed.text)['data']
        assert any(row['id'] == front and row['source'] == 'voice_front' for row in sessions)
        payload['sessions'] = sessions
        assert payload['session_id'] == front
        assert [(m['role'], m['content']) for m in payload['data']] == [('user', body['input'])]
        assert db.get_messages_as_conversation(front)[0]['content'] == body['input']
        # The real next-call projection consumes the native D envelope and emits BOTH spoken sides.
        root = Path(__file__).parents[2]
        project = subprocess.run(['node', '--input-type=module', '-e', """
            import {history} from './01-product-half-finished/backend/services/personal-aios-integration/src/call-context.ts';
            import {readFileSync} from 'node:fs';
            const page=JSON.parse(readFileSync(0,'utf8'));
            const lines=await history({sessionOwner:async id=>id===page.session_id?'owner':undefined,native:{
                sessions:async()=>page.sessions,messages:async()=>page.data}},'owner','next-call');
            console.log(JSON.stringify(lines.map(line=>[line.who,line.text])));
        """], input=json.dumps(payload), text=True, capture_output=True, cwd=root,
            env=os.environ,  # the caller's NODE_OPTIONS resolver, never a private workspace path
            timeout=15)
        assert project.returncode == 0, project.stderr
        assert json.loads(project.stdout) == [['主人', d['content']['app_event']['user']], ['依米', d['content']['app_event']['assistant']]]

    finally:
        db.close()
