"""Trusted contract driver; package tests never supply their own monitoring evidence."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import selectors
import time

import yaml

HERE = Path(__file__).resolve().parent
SDK = Path(os.environ.get('PAIOS_CAPABILITY_SDK', '/opt/yimi/capability'))
if not SDK.is_dir():
    SDK = HERE.parents[6] / 'capability'


def run(package, command, requests, fixtures=None, dependencies=None):
    for name in fixtures or {}:
        if Path(name).is_absolute() or any(part in ('..', '.') for part in name.split('/')):
            raise ValueError('fixture_path_invalid: files keys must be relative to /work (sample-a.pdf); tool args may use /work/sample-a.pdf')
    with tempfile.TemporaryDirectory(prefix='capability-contract-') as directory:
        scratch = Path(directory)
        (scratch / 'fixtures.json').write_text(json.dumps(fixtures or {}))
        launch = ['unshare', '--user', '--map-root-user', '--net', '--mount', '--pid', '--fork',
                  '--kill-child', '--mount-proc', sys.executable, '-B', str(HERE / 'isolate.py'), str(package),
                  str(scratch), str(SDK), json.dumps(command)]
        if dependencies:
            launch.append(str(dependencies))
        process = subprocess.Popen(launch, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=True)
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        selector.register(process.stderr, selectors.EVENT_READ)
        messages, raw_stdout, stderr, partial = [], bytearray(), bytearray(), bytearray()
        iterator, awaiting, exhausted = iter(requests), None, False
        deadline = time.monotonic() + 45
        try:
            while selector.get_map():
                if awaiting is None and not exhausted:
                    for row in iterator:
                        process.stdin.write((json.dumps(row) + '\n').encode())
                        process.stdin.flush()
                        if 'id' in row:
                            awaiting = row['id']
                            break
                    else:
                        process.stdin.close()
                        exhausted = True
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(launch, 45)
                for key, _ in selector.select(remaining):
                    data = os.read(key.fd, 65536)
                    if not data:
                        selector.unregister(key.fileobj)
                    elif key.fileobj is process.stderr:
                        stderr.extend(data)
                        stderr[:] = stderr[-2000:]
                    else:
                        raw_stdout.extend(data)
                        if len(raw_stdout) > 4 << 20:
                            raise ValueError('registration_response_budget_exceeded')
                        if requests:
                            partial.extend(data)
                            while b'\n' in partial:
                                line, _, rest = partial.partition(b'\n')
                                partial[:] = rest
                                if not line.strip():
                                    continue
                                message = json.loads(line)
                                if not isinstance(message, dict):
                                    raise ValueError('mcp_frame_object_required')
                                messages.append(message)
                                if message.get('id') == awaiting:
                                    awaiting = None
            code = process.wait(timeout=max(.1, deadline - time.monotonic()))
        finally:
            selector.close()
            if process.poll() is None:
                process.kill()
                process.wait()
            for pipe in (process.stdin, process.stdout, process.stderr):
                pipe.close()
        # Complete tracing is mandatory, including unsuccessful / malicious servers.
        audit_file = scratch / 'audit.json'
        if not audit_file.exists():
            raise ValueError('sandbox_evidence_missing:' + stderr.decode('utf8', 'replace')[-300:])
        audit = json.loads(audit_file.read_text())
        audit['stdout'] = raw_stdout.decode('utf8')
        audit['stderr'] = stderr.decode('utf8', 'replace')
        return messages, audit, code


def request(id, method, params=None):
    return {'jsonrpc': '2.0', 'id': id, 'method': method, **({'params': params} if params is not None else {})}


def check(package, dependencies=None, native_validation=True):
    if native_validation:
        source = os.environ.get('PAIOS_HERMES_UPSTREAM_SOURCE', '/opt/hermes')
        sys.path.insert(0, source)
        from hermes_cli.plugin_validate import validate_plugin_dir
        validation = validate_plugin_dir(package)
        if not validation.ok:
            raise ValueError('hermes_plugins_validate_failed:' + json.dumps(validation.to_dict()))
    manifest = json.loads((package / 'plugin.json').read_text())
    cap = manifest['extensions']['ai.yimi.capability']
    contract = yaml.safe_load((package / cap['tests']['contract']).read_text())
    if contract.get('version') != 1 or not contract.get('cases') or len(contract['cases']) > 32:
        raise ValueError('contract_cases_required')
    server = json.loads((package / 'mcp.json').read_text())['mcpServers'][cap['runtime']['server']]
    evidence = {'success': True, 'cases': [], 'errors': []}
    for implementation, entry in [('fake', cap['staging']['fake']), ('server', server)]:
        command = [entry['command'], *entry['args']]
        # Packages execute from the writable work directory; their code stays read-only.
        command[1] = '/package/' + command[1]
        for case in contract['cases']:
            rows = [request(1, 'initialize', {'protocolVersion': '2024-11-05', 'capabilities': {},
                      'clientInfo': {'name': 'registration', 'version': '1'}}),
                    {'jsonrpc': '2.0', 'method': 'notifications/initialized'}, request(2, 'tools/list'),
                    request(3, 'tools/call', {'name': case['tool'], 'arguments': case.get('args', {})})]
            messages, audit, code = run(package, command, rows, case.get('files'), dependencies)
            by_id = {row.get('id'): row for row in messages if 'id' in row}
            result = by_id.get(3, {}).get('result')
            if not isinstance(result, dict):
                raise ValueError('mcp_tool_result_invalid')
            evidence['cases'].append(dict(implementation=implementation, tool=case['tool'], args=case.get('args', {}),
                                          result=result, writes=audit['writes'], network=audit['network']))
            listed = by_id.get(2, {}).get('result', {}).get('tools', [])
            if code or set(tool['name'] for tool in listed) != set(cap['tools']):
                evidence['errors'].append(implementation + ':server_or_catalog_failed')
            mismatches = []
            for path, expected in case['expect'].items():
                missing = object()
                value = result.get('structuredContent') if result else None
                for part in path.split('.'):
                    if isinstance(value, list):
                        index = int(part) if part.isdecimal() else -1
                        value = value[index] if 0 <= index < len(value) else missing
                    else:
                        value = value.get(part, missing) if isinstance(value, dict) else missing
                if value != expected:
                    mismatches.append(path + ':expected=' + json.dumps(expected) +
                                      ':actual=' + ('missing' if value is missing else json.dumps(value)))
            if mismatches:
                body = result.get('structuredContent', {}) if result else {}
                evidence['errors'].append(implementation + ':assertion:' + ','.join(mismatches) +
                    ':status=' + json.dumps(body.get('status')) + ':unknowns=' + json.dumps(body.get('unknowns')))
    # A separate regression script must pass in the same isolated filesystem/network.
    _, audit, code = run(package, ['python3', '/package/scripts/test.py'], [], dependencies=dependencies)
    if code or audit['network']:
        evidence['errors'].append('regression_failed')
    evidence['success'] = not evidence['errors']
    return evidence


def invoke(package, call, dependencies=None, raw=False):
    manifest = json.loads((package / 'plugin.json').read_text())
    cap = manifest['extensions']['ai.yimi.capability']
    entry = json.loads((package / 'mcp.json').read_text())['mcpServers'][cap['runtime']['server']]
    messages, audit, code = run(package, [entry['command'], '/package/' + entry['args'][0], *entry['args'][1:]],
        [request(1, 'initialize', {'protocolVersion': '2024-11-05', 'capabilities': {},
                                 'clientInfo': {'name': 'host', 'version': '1'}}),
         {'jsonrpc': '2.0', 'method': 'notifications/initialized'}, request(2, call['method'], call.get('params', {}))],
        call.get('files'), dependencies)
    if raw:
        return {'messages': messages, 'audit': audit, 'exit': code}
    if code or audit['network']:
        raise ValueError('capability_runtime_isolation_failed')
    if call['method'] == 'tools/call':
        policy = cap['tools'][call['params']['name']]
        kind = policy.get('effect')
        if not kind:
            selector, branches = next(iter(policy['effect_by_arg'].items()))
            kind = branches[call['params'].get('arguments', {}).get(selector[2:])]
        if kind == 'observe' and audit['writes']:
            raise ValueError('capability_runtime_observe_write')
    reply = next((row for row in messages if row.get('id') == 2), {})
    if 'result' not in reply:
        raise ValueError('capability_runtime_result_missing')
    return {'result': reply['result'], 'artifacts': audit.get('artifacts', {})}


if __name__ == '__main__':
    try:
        if sys.argv[1] in ('--files', '--invoke-files'):
            # Only the trusted workshop bridge invokes this mode, after upstream validation.
            payload = json.load(sys.stdin)
            files = payload['files'] if sys.argv[1] == '--invoke-files' else payload
            with tempfile.TemporaryDirectory(prefix='capability-upload-') as directory:
                for name, content in files.items():
                    if Path(name).is_absolute() or any(part in ('..', '.', '') for part in name.split('/')):
                        raise ValueError('package_path_invalid')
                    path = Path(directory) / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(content)
                result = (invoke(Path(directory), payload['call'], os.environ.get('PAIOS_CAPABILITY_TEST_DEPS'))
                          if sys.argv[1] == '--invoke-files' else check(Path(directory), native_validation=False))
                print(json.dumps(result))
            sys.exit(0)
        package = Path(sys.argv[1]).resolve()
        dependencies = os.environ.get('PAIOS_CAPABILITY_TEST_DEPS')
        if len(sys.argv) > 2 and sys.argv[2] == 'invoke':
            call = json.load(sys.stdin)
            print(json.dumps(invoke(package, call, dependencies, raw=True)))
        else:
            print(json.dumps(check(package, dependencies)))
    except (ValueError, OSError, subprocess.SubprocessError, KeyError, TypeError) as error:
        print(json.dumps({'success': False, 'cases': [], 'errors': [str(error)]}))
        sys.exit(1)
