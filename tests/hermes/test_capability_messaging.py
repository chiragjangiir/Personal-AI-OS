"""Package contracts, shared MCP wire and the unchanged native messaging engine."""
import asyncio
import importlib
import json
import os
from pathlib import Path
import sys
from unittest.mock import Mock

import jsonschema
import pytest
import yaml

from capability.hosts.python import Host
from capability.packages.messaging.server.delivery import Delivery
from capability.packages.messaging.server.receipt import mapped
from capability.packages.messaging.server.server import prepare, register

ROOT = Path(__file__).parents[2]
CONTRACTS = ROOT / 'capability/contracts'
SCHEMA = json.loads((CONTRACTS / 'receipt.v1.schema.json').read_text())
PACKAGES = ROOT / 'capability/packages'


@pytest.fixture(autouse=True)
def home(monkeypatch, tmp_path):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    token = set_hermes_home_override(tmp_path)
    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    yield tmp_path
    reset_hermes_home_override(token)


@pytest.mark.parametrize('package', ['messaging', 'wechat-mac'])
def test_manifest_and_tool_inventory(package, tmp_path):
    plugin = json.loads((PACKAGES / package / 'plugin.json').read_text())
    jsonschema.validate(plugin, json.loads((CONTRACTS / 'upstream/plugin-1.0.0.schema.json').read_text()))
    extension = plugin['extensions']['ai.yimi.capability']
    jsonschema.validate(extension, json.loads((CONTRACTS / 'manifest.v1.schema.json').read_text()))
    host = Host()
    server = importlib.import_module(f'capability.packages.{package}.server.server')
    if package == 'messaging':
        server.register(host, sender=Mock(return_value={'success': True}), directory=tmp_path)
    else:
        server.register(host, transport=Mock(), directory=tmp_path)
    assert set(host.tools) == set(extension['tools'])
    assert extension['runtime']['host'] == 'shared'
    for _, tool in host.tools.values():
        assert tool.output_schema == SCHEMA
        assert 'effect' not in tool.input_schema['properties']
        assert 'requested' not in tool.input_schema['properties']
        assert 'owner_requested' in tool.input_schema['properties']


CASES = yaml.safe_load((PACKAGES / 'messaging/tests/contract.yaml').read_text())['fixtures']
WECHAT_CASES = yaml.safe_load((PACKAGES / 'wechat-mac/tests/contract.yaml').read_text())['fixtures']


@pytest.mark.parametrize('fixture', CASES, ids=lambda fixture: fixture['name'])
def test_native_shapes_match_real_adapter_contract(fixture, tmp_path):
    sender = Mock(return_value=fixture['native'])
    delivery = Delivery(tmp_path / 'execution.sqlite', sender)
    body = delivery.invoke(idempotency_key='frozen-call', **fixture['args'])
    jsonschema.validate(body, SCHEMA)
    assert body['status']['state'] == fixture['state']
    assert body.get('novelty') is None
    if body['effects']:
        assert body['effects'][0]['verification'] == 'service_ack'
    if fixture['state'] == 'unknown':
        assert body['next']['retry'] == 'after_check' and body['next']['check_with'] == 'message_status'


def test_frozen_delivery_idempotency_survives_new_process_and_rejects_changed_args(tmp_path):
    sender = Mock(return_value={'success': True, 'message_id': 'fixture-id'})
    path = tmp_path / 'calls.sqlite'
    call = {'target': 'email:fixture@example.com', 'message': '冻结正文'}
    first = Delivery(path, sender).invoke(idempotency_key='original', **call)
    assert Delivery(path, sender).invoke(idempotency_key='original', **call) == first
    assert Delivery(path, sender).status('original') == first
    changed = Delivery(path, sender).invoke(idempotency_key='original', **{**call, 'message': '改正文'})
    assert changed['status']['reason_code'] == 'IDEMPOTENCY_CONFLICT'
    sender.assert_called_once_with(call)


def test_timeout_and_interrupted_claim_never_send_twice(tmp_path):
    sender = Mock(side_effect=TimeoutError('private detail'))
    delivery = Delivery(tmp_path / 'calls.sqlite', sender)
    args = {'target': 'email:fixture@example.com', 'message': 'fixture'}
    result = delivery.invoke(idempotency_key='timeout', **args)
    assert result['status']['state'] == 'unknown'
    assert delivery.invoke(idempotency_key='timeout', **args) == result
    assert 'private detail' not in json.dumps(result)
    sender.assert_called_once()


def test_execution_connections_close_without_waiting_for_garbage_collection(tmp_path,monkeypatch):
    from capability.packages.messaging.server import delivery as module
    import sqlite3
    connections=[];connect=sqlite3.connect
    class Observed(sqlite3.Connection):
        closed=False
        def close(self):
            self.closed=True
            super().close()
    def tracked(*args,**kw):
        db=connect(*args,**kw,factory=Observed);connections.append(db);return db
    monkeypatch.setattr(module.sqlite3,'connect',tracked)
    delivery=Delivery(tmp_path/'calls.sqlite',Mock(return_value={'success':True}))
    for index in range(20):
        delivery.invoke(idempotency_key=str(index),target='email:fixture@example.com',message='fixture')
        delivery.status(str(index))
        assert all(db.closed for db in connections)


@pytest.mark.parametrize('target', ['telegram:12345678', 'email:fixture@example.com', 'slack:U12345678'])
def test_package_preparation_reuses_legacy_resolver_and_first_send_scope(target):
    from integrations.hermes.personal_aios.effects import prepare_message
    args = {'target': target, 'message': '原文', 'owner_requested': True}
    pinned, effect = prepare(args)
    legacy_args, legacy_effect = prepare_message({**args, 'action': 'send'}, True)
    assert effect == legacy_effect
    assert pinned['target'] == legacy_args['target']
    assert 'owner_requested' not in pinned


@pytest.mark.parametrize('target', ['', 'email:昵称', 'telegram:妈妈', 'dingtalk:12345678'])
def test_invalid_or_unattested_recipient_still_refused(target):
    with pytest.raises(ValueError):
        prepare({'target': target, 'message': 'fixture', 'owner_requested': True})


@pytest.mark.parametrize('tool', ['wechat_send_text', 'wechat_send_file', 'wechat_reply'])
def test_wechat_reuses_frozen_owner_mac_batch_and_does_not_invent_delivery(tool, tmp_path):
    server = importlib.import_module('capability.packages.wechat-mac.server.server')
    transport = Mock(return_value={'returncode': 0, 'output': '{"posted":true}'})
    host = Host();server.register(host, transport=transport, directory=tmp_path)
    args = {'command': 'existing-prepared-batch', 'recipient': 'wechat:fixture-account',
            'context': {'run_id': 'run', 'session_id': 'session', 'tool_call_id': 'call'}, 'idempotency_key': 'frozen'}
    body = host.tools[tool][0](**args)
    assert body['status']['state'] == 'unknown'
    assert body['next']['check_with'] == 'wechat_read_recent'
    assert transport.call_args.args[0]['command'] == args['command']
    assert host.tools[tool][0](**args) == body
    transport.assert_called_once()
    jsonschema.validate(body, SCHEMA)


@pytest.mark.parametrize('backend', ['real', 'fake'])
@pytest.mark.parametrize('fixture', WECHAT_CASES, ids=lambda row:row['name'])
def test_wechat_contract_runs_against_real_adapter_and_fake(backend,fixture,tmp_path):
    host=Host()
    module=importlib.import_module(f'capability.packages.wechat-mac.{"server" if backend=="real" else "fake"}.server')
    if backend=='real':
        module.register(host,transport=Mock(return_value={'returncode':0,'output':'{"content_exposed":true,"messages":[]}'}),directory=tmp_path)
    else:
        module.register(host)
    args={'recipient':'wechat:fixture','context':{}}
    if fixture['tool']!='wechat_read_recent':
        args.update(command='existing-prepared-batch',idempotency_key='original')
    body=host.tools[fixture['tool']][0](**args)
    assert body['status']['state']==fixture['state']
    jsonschema.validate(body,SCHEMA)


@pytest.mark.parametrize('package', ['messaging', 'wechat-mac'])
def test_fake_stdio_wire_is_receipt_v1_in_one_text_and_structured_content(package, tmp_path):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    async def run():
        params = StdioServerParameters(command=sys.executable, args=['-m', 'capability.hosts.python',
            f'capability.packages.{package}.fake.server'], env={**os.environ, 'HERMES_HOME': str(tmp_path),
                'PYTHONPATH': os.pathsep.join([str(ROOT), os.environ.get('PYTHONPATH', '')])})
        async with stdio_client(params) as (reader, writer):
            async with ClientSession(reader, writer) as session:
                await session.initialize()
                tools = await session.list_tools()
                assert all(tool.output_schema == SCHEMA for tool in tools.tools)
                if package == 'messaging':
                    body = await session.call_tool('send_message', {'action': 'send', 'target': 'email:fixture@example.com',
                        'message': 'fixture', 'idempotency_key': 'frozen', 'owner_requested': True})
                    assert body.structured_content['status']['state'] == 'succeeded'
                else:
                    body = await session.call_tool('wechat_send_text', {'command': 'fixture', 'recipient': 'wechat:fixture',
                        'context': {}, 'idempotency_key': 'frozen', 'owner_requested': True})
                    assert body.structured_content['status']['state'] == 'unknown'
                    read=await session.call_tool('wechat_read_recent',{'recipient':'wechat:fixture','context':{}})
                    assert read.structured_content['status']['state']=='succeeded'
                    assert 'content_exposed' in read.structured_content['content'][0]['text']
                    assert len(read.content)==1
                assert len(body.content) == 1 and body.content[0].type == 'text'
                jsonschema.validate(body.structured_content, SCHEMA)
    asyncio.run(run())


def test_adapters_stay_below_200_lines():
    paths = list((PACKAGES / 'messaging/server').glob('*.py')) + list((PACKAGES / 'wechat-mac/server').glob('*.py'))
    paths += [ROOT / 'capability/hosts/python.py', ROOT / 'integrations/hermes/personal_aios/packaged_messaging.py']
    assert all(len(path.read_text().splitlines()) <= 200 for path in paths)


@pytest.mark.parametrize('enabled', [
    {'messaging'}, {'messaging', 'wechat-mac'},
    {'messaging', 'wechat-mac', 'phone'}, {'messaging', 'wechat-mac', 'owner-mac'},
    {'messaging', 'wechat-mac', 'phone', 'owner-mac'}])
def test_package_switch_retires_only_migrated_middleware_and_consumes_owner_judgment(monkeypatch, enabled):
    from types import SimpleNamespace
    from integrations.hermes.personal_aios import effects
    from tools import send_message_tool
    sender=Mock(return_value='{"success":true}')
    monkeypatch.setattr(send_message_tool,'send_message_tool',sender)
    tools, hooks, middleware = {}, {}, []
    def add(name, group, schema, function, **kw):
        tools[name]=(schema,function)
        return object()
    effects.register(SimpleNamespace(register_tool=add,register_hook=lambda name,fn:hooks.update({name:fn}),
        register_middleware=lambda *args:middleware.append(args)),SimpleNamespace(capability_enabled=lambda name:name in enabled))
    assert middleware == []
    assert ('paios_effect_check' in tools) == (enabled != {'messaging','wechat-mac','phone','owner-mac'})
    schema, handler=tools['send_message']
    assert 'effect' not in schema['parameters']['properties'] and 'requested' not in schema['parameters']['properties']
    args={'target':'email:fixture@example.com','message':'fixture','owner_requested':True,'idempotency_key':'fixture'}
    pinned=hooks['pre_tool_call']('send_message',args)['args']
    result=json.loads(handler(pinned))
    assert result['structuredContent']['status']['state']=='succeeded'
    assert 'owner_requested' not in sender.call_args.args[0]


def test_two_packages_share_one_host_without_sharing_execution_identifiers(tmp_path):
    host=Host()
    importlib.import_module('capability.packages.messaging.fake.server').register(host)
    importlib.import_module('capability.packages.wechat-mac.fake.server').register(host)
    assert len(host.tools)==6
    with pytest.raises(ValueError,match='Duplicate'):
        importlib.import_module('capability.packages.messaging.fake.server').register(host)


def test_family_switch_reads_existing_gateway_catalog_projection_and_rolls_back_without_rpc(tmp_path):
    from integrations.hermes.personal_aios import PersonalAIOSProvider
    config=tmp_path/'config.yaml'
    config.write_text(json.dumps({'personal_aios':{'capability_tools':['mcp__messaging__send_message']}}))
    provider=PersonalAIOSProvider()
    assert provider.capability_enabled('messaging') is True
    assert provider.capability_enabled('wechat-mac') is False
    config.write_text(json.dumps({'personal_aios':{'capability_tools':[]}}))
    assert PersonalAIOSProvider().capability_enabled('messaging') is False
