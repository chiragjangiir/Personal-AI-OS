"""The workshop's thin adapters to platform registration and read-only discovery."""
import json
from urllib.parse import urlencode
from urllib.request import urlopen
from pathlib import Path


def draft_files(name, files=None):
    from gateway.run_scope import current_scope
    from hermes_constants import get_hermes_home
    from .tool_lifecycle import _files
    home = get_hermes_home()
    if current_scope() != 'build' or home.name != 'workshop':
        raise ValueError('Package drafts belong to the isolated build profile')
    root = home / 'skills/workshop' / name
    if files is None:
        return {'files': _files(root) if root.exists() else {}}
    if not isinstance(files, dict) or not files or len(files) > 32:
        raise ValueError('Expected package files to write')
    for path, content in files.items():
        if (not isinstance(path, str) or not isinstance(content, str) or Path(path).is_absolute()
                or any(part in ('', '.', '..') for part in path.split('/')) or '\\' in path):
            raise ValueError('Invalid draft file')
    files = {**(_files(root) if root.exists() else {}), **files}
    if len(files) > 32 or any(len(text.encode()) > 131072 for text in files.values()) or sum(len(text.encode()) for text in files.values()) > 524288:
        raise ValueError('Reduce the package to fit its budget')
    root.mkdir(parents=True, exist_ok=True)
    files = {'SKILL.md': '---\nname: ' + name + '\ndescription: Isolated capability draft.\nadapter_modules: []\n---\n', **files}
    for path, content in files.items():
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    return {'success': True, 'files_written': len(files)}


def registry_client(provider, kwargs):
    from gateway.session_context import get_api_run_id
    from tools.approval_context import _approval_tool_call_id
    session = kwargs.get('session_id', '')
    context = {'session_id': session, 'run_id': get_api_run_id(session),
               'tool_call_id': kwargs.get('tool_call_id') or _approval_tool_call_id.get()}
    if not all(context.values()):
        raise ValueError('Capability registration requires a bound admitted run')

    def request(action, body):
        return provider._request('/internal/hermes/gateway/' + action, {**body, 'context': context}, max_bytes=4 << 20)
    return request


def local_discovery(query, source=None):
    from .workshop import local_hub
    results = [] if source else [{'source': 'installed', 'matches': [], 'scope': 'isolated_builder'}]
    if source in (None, 'hermes_hub'):
        try:
            results.append({'source': 'hermes_hub', 'matches': local_hub('search', query)})
        except (OSError, ValueError, RuntimeError):
            results.append({'source': 'hermes_hub', 'error': 'discovery_unavailable'})
    # The builder's existing egress policy/proxy is the only network path.
    if source in (None, 'official_mcp'):
        try:
            with urlopen('https://registry.modelcontextprotocol.io/v0.1/servers?' +
                         urlencode({'search': query, 'limit': 10}), timeout=15) as response:
                data = json.load(response)
            results.append({'source': 'official_mcp', 'matches': data['servers']})
        except (OSError, ValueError, KeyError):
            results.append({'source': 'official_mcp', 'error': 'discovery_unavailable'})
    return results[0].get('matches', results[0]) if source else {'results': results}
