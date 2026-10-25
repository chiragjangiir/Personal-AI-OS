"""Checked packages share the MCP host; their code executes only in the existing offline workshop."""
import json
from pathlib import Path


def register(host):
    from hermes_constants import get_hermes_home
    from integrations.hermes.personal_aios.capability_packages import request
    path = get_hermes_home() / 'capability/installed.json'
    generation = None
    dynamic = set()

    def invoke(version, tool, args):
        import base64
        import mimetypes
        files = {name: (Path(version['root']) / name).read_text() for name in version['files']}
        response = request('/capability-invoke', {'files': files,
            'call': {'method': 'tools/call', 'params': {'name': tool, 'arguments': args}}})
        result = response['result']
        for name, data in response.get('artifacts', {}).items():
            result.setdefault('content', []).append({'type': 'resource', 'resource': {
                'uri': 'capability://' + version['namespace'] + '/' + name,
                'mimeType': mimetypes.guess_type(name)[0] or 'application/octet-stream', 'blob': data}})
        return result

    def refresh():
        nonlocal generation
        wire = path.read_bytes() if path.is_file() else b'{}'
        if wire == generation:
            return False
        versions = json.loads(wire)
        for name in dynamic:
            host.tools.pop(name, None)
        dynamic.clear()
        for version in versions.values():
            host.namespace = version['namespace'] + '__'
            for tool in version['tools']:
                name = tool['name']
                def bound(version, name):
                    def execute(**args):
                        return invoke(version, name, args)
                    return execute
                execute = bound(version, name)
                host.add(name, execute, tool['inputSchema'], version['name'] + '.' + name + ': ' + tool.get('description', name))
                host.tools[host.namespace + name][1].meta = {'yimi.version': version['digest']}
                dynamic.add(host.namespace + name)
        host.namespace = ''
        generation = wire
        return True
    host.refresh = refresh
    refresh()
