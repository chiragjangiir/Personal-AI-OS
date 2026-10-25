"""Read authority transport projections and register a private native secret source."""
import copy
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen

TRANSPORT_FIELDS = frozenset({
    'model', 'providers', 'custom_providers', 'fallback_providers', 'fallback_model',
    'fallback', 'credential_pool_strategies', 'model_catalog', 'model_overrides',
    'models_dev', 'openrouter', 'bedrock', 'vertex', 'nous', 'local_runtime',
    'smart_model_routing', 'delegation', 'auxiliary', 'cron', 'workshop',
})


def read_projection(path):
    projection = json.loads(Path(path).read_text())
    if not projection['configured'] and projection['config']['model'].get('enabled') is not False:
        raise ValueError('Model credentials must be configured in 模型与密钥')
    if (not isinstance(projection['revision'], int) or projection['revision'] < (1 if projection['configured'] else 0)
            or projection['group'] not in {'brain', 'build'}
            or not isinstance(projection['config'], dict)
            or not isinstance(projection['credentials'], list)
            or not {'model', 'fallback_providers'} <= projection['config'].keys()
            or set(projection['config']) - TRANSPORT_FIELDS):
        raise ValueError('Invalid model settings projection')
    return projection


def retire_generation(path):
    """Remove an authority generation so a build from before the settings authority composes its own
    product transport, whose keys its own start loads from the legacy key files."""
    import yaml
    path = Path(path)
    if not path.exists():
        return False
    config = yaml.safe_load(path.read_text()) or {}
    if 'model_settings' not in config:
        return False
    for field in TRANSPORT_FIELDS | {'model_settings', 'secrets'}:
        config.pop(field, None)
    path.write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True))
    return True


def projected_config(config, path):
    """Replace the entire transport generation; retain product tool and runtime policy."""
    projection = read_projection(path)
    from hermes_cli.runtime_provider import validate_agent_route_contexts
    validate_agent_route_contexts(projection['config'])
    result = copy.deepcopy(config)
    for field in TRANSPORT_FIELDS - {'delegation', 'auxiliary', 'cron', 'workshop'}:
        result.pop(field, None)
    for section in ('delegation', 'auxiliary', 'cron', 'workshop'):
        result.pop(section, None)
    result.update(copy.deepcopy(projection['config']))
    result['model_settings'] = {key: projection[key] for key in ('environment_id', 'profile', 'revision', 'group')}
    result['secrets'] = {'environment': 'profile', 'personal_aios': {
        'enabled': projection['configured'], 'projection': str(Path(path).resolve())}}
    return result


def credential(projection, handle):
    """The service credential and provider value remain in the inference process."""
    token = Path(os.environ['PAIOS_MODEL_SETTINGS_TOKEN_FILE']).read_text().strip()
    request = Request(os.environ['PAIOS_MODEL_SETTINGS_SERVICE_URL'].rstrip('/') + '/internal/model-settings/credential',
        data=json.dumps({**{key: projection[key] for key in ('environment_id', 'profile', 'revision')},
                         'handle': handle}).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
    with urlopen(request, timeout=15) as response:
        value = json.loads(response.read(65536))['key']
    if not isinstance(value, str) or not value:
        raise ValueError('Model credential unavailable')
    return value


def register_source():
    from agent.secret_sources.base import SecretSource, FetchResult, ErrorKind
    from agent.secret_sources.registry import register_source as native_register

    class AuthoritySource(SecretSource):
        name, label, shape = 'personal_aios', 'Model Settings', 'bulk'
        override_existing_default = True

        def fetch(self, cfg, home_path):
            result = FetchResult()
            try:
                projection = read_projection(cfg['projection'])
                result.secrets = {binding['name']: credential(projection, binding['handle'])
                                 for binding in projection['credentials']}
                if not result.secrets:
                    return result.fail('Model credentials are not configured', ErrorKind.NOT_CONFIGURED)
                return result
            except (OSError, ValueError, KeyError):
                return result.fail('Model credential authority unavailable', ErrorKind.NOT_CONFIGURED)

    native_register(AuthoritySource(), replace=True)


def initialize_credentials(home):
    """Fail before startup if this generation cannot hydrate its own credentials."""
    from hermes_cli.env_loader import hydrate_profile_secret_sources
    register_source()
    from hermes_cli.auth import PROVIDER_REGISTRY
    from dotenv import dotenv_values, unset_key
    names = {name for provider in PROVIDER_REGISTRY.values() for name in provider.api_key_env_vars}
    names.update({'PAIOS_DEEPSEEK_API_KEY', 'PAIOS_SILICONFLOW_API_KEY', 'PAIOS_BUILDER_API_KEY'})
    projection = read_projection(os.environ['PAIOS_MODEL_SETTINGS_PROJECTION'])
    names.update(binding['name'] for binding in projection['credentials'])
    names.update(name for name in os.environ if name.startswith('PAIOS_MODEL_KEY_'))
    for name in names:
        os.environ.pop(name, None)
    for file in (Path(home) / '.env', Path(home) / '.op.env'):
        if file.exists():
            stored = dotenv_values(file, interpolate=False)
            for name in names.intersection(stored) | {key for key in stored if key.startswith('PAIOS_MODEL_KEY_')}:
                unset_key(file, name)
    if projection['configured']:
        values = hydrate_profile_secret_sources(Path(home))
    else:
        from hermes_cli.env_loader import install_profile_secret_source_values
        install_profile_secret_source_values(Path(home), {})
        values = {}
    if any(not values.get(binding['name']) for binding in projection['credentials']):
        raise ValueError('Model credentials must be configured in 模型与密钥')
    try:
        from .model_usage import install
    except ImportError:
        from model_usage import install
    install()
    try:
        from .model_task_admission import install as install_admission
    except ImportError:
        from model_task_admission import install as install_admission
    install_admission()


def activate(home, projections):
    """Install a prepared generation while the caller holds the native idle gates."""
    import yaml
    from hermes_cli.env_loader import get_secret_source_values, install_profile_secret_source_values
    from agent.auxiliary_client import shutdown_cached_clients
    prepared = []
    for projection in projections:
        target = Path(home) if projection['group'] == 'brain' else Path(home) / 'workshop'
        current = target / 'config.yaml'
        old = current.read_bytes()
        revision = target / 'model-settings/revisions' / str(projection['revision']) / (projection['profile'] + '.json')
        revision.parent.mkdir(parents=True, exist_ok=True)
        if revision.exists():
            if json.loads(revision.read_text()) != projection:
                raise ValueError('Model revision is immutable')
        else:
            revision.write_text(json.dumps(projection))
            revision.chmod(0o400)
        config = projected_config(yaml.safe_load(old), revision)
        values = {binding['name']: credential(projection, binding['handle']) for binding in projection['credentials']}
        prepared.append((target, current, old, config, values, get_secret_source_values(target)))
    try:
        for target, current, old, config, values, _ in prepared:
            pending = current.with_suffix('.model-settings-pending')
            pending.write_text(yaml.safe_dump(config, allow_unicode=True, sort_keys=False))
            pending.chmod(0o600)
            pending.replace(current)
            install_profile_secret_source_values(target, values)
        shutdown_cached_clients()
    except Exception:
        # Restore both resources before releasing admission; retain the old private key snapshot.
        for target, current, old, _, _, values in prepared:
            current.write_bytes(old)
            install_profile_secret_source_values(target, values)
        raise
    return {'status': 'effective', 'revision': projections[0]['revision']}


async def activation_request(adapter, request):
    """Service-only IPC; agents have neither this token nor this endpoint schema."""
    import hmac
    from aiohttp import web
    from cron import scheduler
    from tools import async_delegation
    token = Path(os.environ['PAIOS_MODEL_SETTINGS_TOKEN_FILE']).read_text().strip()
    if not hmac.compare_digest(request.headers.get('Authorization', ''), 'Bearer ' + token):
        raise web.HTTPUnauthorized()
    body = await request.json()
    projections = body['projections']
    if (not isinstance(projections, list) or not 1 <= len(projections) <= 2
            or any(item['revision'] != body['revision'] for item in projections)
            or len({item['group'] for item in projections}) != len(projections)):
        raise web.HTTPBadRequest(text='Invalid model generation')
    with scheduler._running_lock, async_delegation._records_lock:
        if (getattr(adapter, '_model_settings_aux', 0) or adapter.active_agent_work_count()
                or scheduler._running_job_ids or scheduler._running_fire_owners
                or any(record.get('status') in async_delegation._LIVE_STATES
                       for record in async_delegation._records.values())):
            return web.json_response({'status': 'pending', 'revision': body['revision']}, status=409)
        try:
            result = activate(Path(os.environ['HERMES_HOME']), projections)
        except (ValueError, OSError, KeyError):
            return web.json_response({'status': 'failed', 'revision': body['revision']}, status=422)
    return web.json_response(result)


if __name__ == '__main__':
    import sys
    if sys.argv[1] != 'retire':
        raise SystemExit('usage: model_transport.py retire <config.yaml>...')
    for name in sys.argv[2:]:
        retire_generation(name)
