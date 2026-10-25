"""Live package projection into the existing shared MCP host; no package code runs here."""
import hashlib
import json
from pathlib import Path
import threading
import time

_LOCK = threading.RLock()


def request(path, body):
    from hermes_constants import get_hermes_home
    from .workshop import builder_request
    import yaml
    service = yaml.safe_load((get_hermes_home() / 'workshop/config.yaml').read_text())['personal_aios']
    return builder_request(path, body, service)


def paths():
    from hermes_constants import get_hermes_home
    root = get_hermes_home() / 'capability'
    root.mkdir(parents=True, exist_ok=True)
    return root, root / 'installed.json'


def read_installed():
    _, path = paths()
    return json.loads(path.read_text()) if path.is_file() else {}


def namespace(principal, name):
    return hashlib.sha256(json.dumps(principal, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()[:8] + '_' + name


def identity(version, name):
    from tools.mcp_tool_schema import mcp_prefixed_tool_name
    return mcp_prefixed_tool_name('yimi_shared', version['namespace'] + '__' + name)


def prepare(body):
    version, files = body['version'], body['files']
    result = request('/capability-invoke', {'files': files, 'call': {'method': 'tools/list'}})
    tools = result['result']['tools']
    cap = version['manifest']['extensions']['ai.yimi.capability']
    if set(tool['name'] for tool in tools) != set(cap['tools']):
        raise ValueError('CAPABILITY_PRELOAD_TOOL_MISMATCH')
    root, _ = paths()
    directory = root / 'versions' / namespace(body['principal_id'], version['name']) / version['digest']
    directory.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    for tool in tools:
        tool['inputSchema'].setdefault('properties', {})['owner_requested'] = {'type': 'boolean'}
    prepared = {**version, 'root': str(directory), 'files': list(files), 'tools': tools,
                'namespace': namespace(body['principal_id'], version['digest'] + '_' + version['name']), 'principal_id': body['principal_id']}
    (directory / 'host.json').write_text(json.dumps(prepared))
    return {'tools': [{'identity': identity(prepared, tool['name']), 'name': tool['name']} for tool in tools]}


def staged(principal, version):
    root, _ = paths()
    return json.loads((root / 'versions' / namespace(principal, version['name']) / version['digest'] / 'host.json').read_text())


def activate(body):
    from tools.mcp_tool_discovery import _get_connected_server_for_call
    from tools.registry import registry
    from utils import atomic_json_write
    principal = body['principal_id']
    with _LOCK:
        root, path = paths()
        installed = read_installed()
        prior = {key: row for key, row in installed.items() if row['principal_id'] == principal}
        if body.get('sync'):
            for key in prior:
                del installed[key]
            for version in body['versions']:
                installed[namespace(principal, version['name'])] = staged(principal, version)
        else:
            name = body['name']
            key = namespace(principal, name)
            current = installed.get(key)
            if (current or {}).get('digest') != body['expected']:
                raise ValueError('CAPABILITY_HOST_CAS_CONFLICT')
            if body['next'] is None:
                installed.pop(key, None)
            else:
                installed[key] = staged(principal, body['next'])
        atomic_json_write(path, installed)
        from hermes_constants import get_hermes_home
        from hermes_cli.skills_hub import _clear_skills_cache
        from tools.skills_tool import clear_skills_cache
        import yaml
        config_path = get_hermes_home() / 'config.yaml'
        config = yaml.safe_load(config_path.read_text())
        dirs = config.setdefault('skills', {}).setdefault('external_dirs', [])
        dynamic_root = str(root / 'versions') + '/'
        config['skills']['external_dirs'] = [p for p in dirs if not p.startswith(dynamic_root)] + [
            str(Path(row['root']) / 'skills') for row in installed.values()]
        temporary = config_path.with_suffix('.yaml.capability-tmp')
        temporary.write_text(yaml.safe_dump(config, sort_keys=False))
        temporary.replace(config_path)
        clear_skills_cache()
        _clear_skills_cache()
        # A lazy host connects with this selection; a live one emits tools/list_changed on the same session.
        host = _get_connected_server_for_call('yimi_shared')
        wanted = {identity(row, tool['name']) for row in installed.values() if row['principal_id'] == principal for tool in row['tools']}
        removed = {identity(row, tool['name']) for row in prior.values() for tool in row['tools']} - wanted
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            versions = {row['namespace'] + '__' + tool['name']: row['digest']
                        for row in installed.values() if row['principal_id'] == principal for tool in row['tools']}
            loaded = {tool.name: (tool.meta or {}).get('yimi.version') for tool in host._tools} if host else {}
            if (all(registry.get_entry(name) for name in wanted) and not any(registry.get_entry(name) for name in removed)
                    and all(loaded.get(name) == version for name, version in versions.items())):
                import shutil
                for row in installed.values():
                    directory = Path(row['root']).parent
                    keep = {row['digest'], (prior.get(namespace(row['principal_id'], row['name'])) or {}).get('digest')}
                    for old in directory.iterdir():
                        if old.name not in keep:
                            shutil.rmtree(old)
                return {'active': True}
            time.sleep(0.05)
        raise ValueError('CAPABILITY_HOST_REFRESH_PENDING')


def lookup(tool):
    for row in read_installed().values():
        for name in row['manifest']['extensions']['ai.yimi.capability']['tools']:
            if identity(row, name) == tool:
                cap = row['manifest']['extensions']['ai.yimi.capability']
                return cap, name, {}, tool, row['digest']
    return None


def healthy(body):
    version = staged(body['principal_id'], body['version'])
    files = {name: (Path(version['root']) / name).read_text() for name in version['files']}
    try:
        result = request('/capability-invoke', {'files': files, 'call': {'method': 'tools/list'}})
        return {'healthy': set(row['name'] for row in result['result']['tools']) == set(version['manifest']['extensions']['ai.yimi.capability']['tools'])}
    except RuntimeError as error:
        if str(error) != 'The builder failed: Capability execution sandbox failed':
            raise
        return {'healthy': False}
