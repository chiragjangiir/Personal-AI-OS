#!/usr/bin/env python3
"""Root-only Linux/Docker probe of the watchdog's synthetic 10000:0600 key access."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--runtime-json', required=True, type=Path)
    parser.add_argument('--expect', required=True, choices=('denied', 'read'))
    args = parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0:
        parser.error('Run as root on Linux with Docker')
    runtime = json.loads(args.runtime_json.read_text())
    allowed = {'user', 'cap_drop', 'cap_add', 'security_opt', 'mem_limit', 'memswap_limit'}
    if not isinstance(runtime, dict) or set(runtime) - allowed:
        parser.error('runtime-json must contain only the selected Compose runtime fields')
    name = 'paios-watchdog-key-probe-' + uuid.uuid4().hex
    code = """import json
from pathlib import Path
try:
    Path('/run/secrets/hermes-internal.key').read_bytes()
except PermissionError:
    print(json.dumps({'read':False,'error_type':'PermissionError'}))
else:
    print(json.dumps({'read':True}))
"""
    with tempfile.TemporaryDirectory(prefix='paios-watchdog-key-') as temporary:
        key = Path(temporary) / 'synthetic.key'
        key.write_bytes(b'watchdog-synthetic-probe-only\n')
        os.chown(key, 10000, 10000)
        key.chmod(0o600)
        command = ['docker', 'run', '--rm', '--pull=never', '--name', name, '--network', 'none', '--read-only',
                   '--user', runtime.get('user') or '0:0', '--memory', str(runtime['mem_limit']),
                   '--memory-swap', str(runtime['memswap_limit'])]
        for field, flag in (('cap_drop', '--cap-drop'), ('cap_add', '--cap-add'), ('security_opt', '--security-opt')):
            for value in runtime.get(field) or []:
                command += [flag, value]
        command += ['--mount', f'type=bind,src={key},dst=/run/secrets/hermes-internal.key,readonly',
                    '--entrypoint', 'python3', args.image, '-c', code]
        try:
            result = subprocess.run(command, check=True, capture_output=True, text=True)
            observed = json.loads(result.stdout)
            passed = observed == ({'read': True} if args.expect == 'read' else {'read': False, 'error_type': 'PermissionError'})
            print(json.dumps({'image': args.image, 'runtime': runtime, 'expected': args.expect,
                              'observed': observed, 'passed': passed}))
            return 0 if passed else 1
        finally:
            subprocess.run(['docker', 'rm', '--force', name], capture_output=True, check=False)


if __name__ == '__main__':
    raise SystemExit(main())
