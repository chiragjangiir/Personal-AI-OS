"""Expose Hermes hub discovery and its native quarantine/install path."""
import io
import json
import os
import re
import ssl
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, HTTPSHandler, HTTPRedirectHandler, build_opener


class _NoBuilderRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Builder redirects are not allowed')


def builder_request(path, body, config=None, timeout=660):
    if __package__:
        from .model_task_admission import require_new_task
        from .model_usage import _context
    else:
        from model_task_admission import require_new_task
        from model_usage import _context
    if path in {'/build', '/repair'}:
        require_new_task('build')
        if os.environ.get('PAIOS_MODEL_SETTINGS_PROJECTION'):
            source = _context()
            body = {**body, '_model_context': {key: source[key] for key in ('run_id', 'session_id')}}
    from hermes_cli.config import load_config
    config = config if config is not None else load_config()['personal_aios']
    if not config.get('builder_url'):
        raise ValueError('Remote builder is not configured')
    if urlsplit(config['builder_url']).scheme != 'https':
        raise ValueError('The builder requires pinned HTTPS')
    context = ssl.create_default_context(cafile=config['builder_ca_file'])
    request = Request(config['builder_url'].rstrip('/') + path, json.dumps(body).encode(),
        headers={'Content-Type': 'application/json',
                 'Authorization': 'Bearer ' + Path(config['builder_token_file']).read_text().strip()})
    opener = build_opener(HTTPSHandler(context=context), _NoBuilderRedirect())
    try:
        with opener.open(request, timeout=timeout) as response:
            payload = response.read()
    except HTTPError as error:
        try:
            failure = json.loads(error.read(8192))
        except ValueError:
            raise error
        message = failure.get('error') if isinstance(failure, dict) else None
        if error.code == 503 and message == 'busy':
            raise RuntimeError('the builder is busy') from error
        if isinstance(message, str):
            raise RuntimeError('The builder failed: ' + message) from error
        raise
    return json.loads(payload)


def local_hub(action, value):
    from rich.console import Console
    from hermes_cli.skills_hub import do_search, do_inspect, do_install
    output = io.StringIO()
    console = Console(file=output, force_terminal=False, width=100)
    if action == 'search':
        do_search(value, console=console)
    elif action == 'inspect':
        do_inspect(value, console=console)
    elif action == 'install':
        from gateway.run_scope import current_scope
        if current_scope() != 'build':
            raise ValueError('Hub installs run only inside a background build task: create one with cronjob_manage(action="create", build=true)')
        do_install(value, category='workshop', console=console, skip_confirm=True)
    else:
        raise ValueError('Unknown hub action')
    return {'output': output.getvalue()}


def register(ctx, provider=None, registry_factory=None):
    def find(args, **kwargs):
        from .workshop_capability import registry_client, local_discovery
        if provider is not None and registry_factory is None:
            raise ValueError('Capability registry is not bound; use the existing skills_hub search')
        result = (registry_factory(kwargs)('find', {'query': args['query']}) if registry_factory
                  else local_discovery(args['query']))
        return json.dumps(result, ensure_ascii=False)

    if registry_factory is not None or provider is None:
        ctx.register_tool('capability_find', 'skills_hub', {
            'name': 'capability_find', 'description': 'Find reusable capabilities in installed packages, the Hermes skills hub, then the official MCP registry.',
            'parameters': {'type': 'object', 'properties': {'query': {'type': 'string', 'minLength': 1}},
                           'required': ['query'], 'additionalProperties': False}}, find)

    def hub(args, **kwargs):
        from hermes_cli.config import load_config
        action, value = args['action'], args['value']
        service = load_config().get('personal_aios', {})
        if action == 'find':
            return find({'query': value}, **kwargs)
        if action in {'search', 'inspect', 'install'}:
            if not service.get('builder_url'):
                return json.dumps(local_hub(action, value), ensure_ascii=False)
            if action != 'install':
                return json.dumps(builder_request('/hub', {'action': action, 'value': value}, service), ensure_ascii=False)
        from gateway.run_scope import current_scope
        if action == 'approve':
            if current_scope() != 'owner':
                raise ValueError('Budget approval requires an owner conversation; return the pending_id to the main agent')
            from .tool_lifecycle import ToolLifecycle
            return json.dumps(ToolLifecycle(None).approve(value), ensure_ascii=False)
        spool = Path(os.environ['PAIOS_RELEASE_SPOOL']) if os.environ.get('PAIOS_RELEASE_SPOOL') else None
        if action == 'release_decide':
            from .release_consent import release_decide
            return json.dumps(release_decide(spool, value, provider, kwargs.get('session_id', '')), ensure_ascii=False)
        if action == 'release_status':
            from .self_observe import scrub_value
            from .release_status import read_status
            receipt = read_status(spool, value) if spool and (value == 'runtime' or re.fullmatch(r'(rollback-)?[0-9a-f]{12}', value)) else None
            if receipt is None:
                receipt = builder_request('/release-status', {'request_id': value}, service)
            return json.dumps(scrub_value(receipt), ensure_ascii=False)
        if action == 'release_rollback':
            if spool is None:
                raise ValueError('Product rollback runs only on the production host')
            from gateway.session_context import get_api_run_id
            from tools.approval_context import _approval_tool_call_id
            session_id = kwargs.get('session_id', '')
            context = {'run_id': get_api_run_id(session_id), 'session_id': session_id,
                       'tool_call_id': _approval_tool_call_id.get()}
            if current_scope() != 'owner' or provider is None or not all(context.values()):
                raise ValueError('Product rollback requires a bound owner conversation')
            owner = provider._request('/internal/hermes/schedule-context', {'context': context})
            words = owner['owner_request_text']
            if owner['allow_owner_mutation'] is not True or words is None:
                raise ValueError('Product rollback requires the current owner request')
            # Admission owns the utterance and attribution, including delegated tool calls and voice turns.
            request_id = uuid.uuid4().hex[:12]
            (spool / 'rollback' / (request_id + '.json')).write_text(json.dumps(
                {'request_id': request_id, 'reason': words, 'requested_at': time.time()}, ensure_ascii=False), encoding='utf-8')
            return json.dumps({'request_id': 'rollback-' + request_id, 'status': 'queued'})
        if action == 'repair':
            if current_scope() != 'build':
                raise ValueError('Product repairs run only inside a background build task: create one with cronjob_manage(action="create", build=true) carrying the owner\'s data-free request')
            # The coding run, its tests and the patch export happen on the build host; staging follows there.
            from gateway.run_scope import current_build_origin
            origin = current_build_origin()
            if origin is None:
                raise ValueError('Product repairs require an admitted build origin')
            return json.dumps(builder_request('/repair', {'input': value, 'origin': origin}, service, timeout=3600), ensure_ascii=False)
        from hermes_constants import get_hermes_home, set_hermes_home_override, reset_hermes_home_override
        from .tool_lifecycle import ToolLifecycle, _files
        if registry_factory is not None and action in {'build', 'test', 'promote', 'monitor', 'status', 'revert'} and (
                action not in {'test', 'promote'} or len(value) == 64):
            client = registry_factory(kwargs)
            lifecycle = ToolLifecycle(None, registry=client)
            if action == 'build':
                if current_scope() != 'build':
                    raise ValueError('Capabilities are built only inside an isolated background build task')
                existing = lifecycle.status(args['name'])
                candidate = builder_request('/capability-build', {'input': value, 'name': args['name'],
                    'files': existing.get('files', {})}, service)
                return json.dumps({**candidate, **lifecycle.stage(candidate['name'], candidate['files'])}, ensure_ascii=False)
            return json.dumps(getattr(lifecycle, action)(value), ensure_ascii=False)
        if current_scope() != 'build':
            raise ValueError('Tools are built only inside a background build task: create one with cronjob_manage(action="create", build=true) carrying the owner\'s data-free request, then build, test and promote there')
        home = get_hermes_home()
        if home.name != 'workshop':
            raise ValueError('Tool releases require the isolated build profile')
        def verify(root):
            return builder_request('/test', _files(root), service)
        token = set_hermes_home_override(home.parent)
        try:
            lifecycle = ToolLifecycle(verify)
            if action in {'build', 'install'}:
                files = _files(lifecycle._skill(args['name'])) if action == 'build' else {}
            else:
                result = getattr(lifecycle, action)(value)
        finally:
            reset_hermes_home_override(token)
        if action in {'build', 'install'}:
            route, body = ('/build', {'input': value, 'name': args['name'], 'files': files}) if action == 'build' else (
                '/hub', {'action': 'install', 'value': value})
            candidate = builder_request(route, body, service)
            token = set_hermes_home_override(home.parent)
            try:
                result = {**{key: candidate[key] for key in ('run_id', 'output') if key in candidate},
                          **lifecycle.stage(candidate['name'], candidate['files'], expected_previous=files)}
            finally:
                reset_hermes_home_override(token)
        return json.dumps(result, ensure_ascii=False)

    ctx.register_tool('skills_hub', 'skills_hub', {
        'name': 'skills_hub', 'description': 'Discover reusable skills; build a standard capability package with the isolated builder, then test and promote the checked candidate. Package registration validates manifests, secrets, receipts, effects and offline egress before direct publication. status and monitor read platform package evidence; revert restores the most recent package version without restarting Hermes. Legacy skill candidates retain their existing budget approval path. repair, release_decide, release_status and release_rollback use the separate protected product release flow.',
        'parameters': {'type': 'object', 'properties': {
            'action': {'type': 'string', 'enum': ['find', 'search', 'inspect', 'install', 'build', 'approve', 'test', 'promote', 'monitor', 'status', 'revert', 'repair', 'release_status', 'release_decide', 'release_rollback']},
            'name': {'type': 'string', 'description': 'Bare reusable skill name for build.'},
            'value': {'type': 'string', 'description': 'Search query, skill identifier, data-free build or repair request, pending_id for approve/test/promote, skill name for status/revert, request_id for release_status, or a summary for release_rollback (owner words come from the admitted run).'}},
            'required': ['action', 'value'], 'additionalProperties': False}}, hub)
