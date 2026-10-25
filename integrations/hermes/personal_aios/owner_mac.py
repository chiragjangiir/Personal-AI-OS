"""Expose Hermes native SSH and file operations for the authenticated owner's Mac."""
import base64
from contextlib import contextmanager
from dataclasses import asdict
import json
import os
from pathlib import Path
import re
import shlex
import sys
import time
import uuid
from urllib.request import Request, urlopen

from mcp.server import MCPServer

sys.path.insert(0, os.environ.get('PAIOS_HERMES_SOURCE', '/opt/hermes'))
from hermes_constants import get_hermes_home
from tools.environments.ssh import SSHEnvironment
from tools.file_operations import ShellFileOperations


MAX_COPY = 25 * 1024 * 1024


def resolve(context, device_id, read_only=False):
    port = os.environ['PAIOS_INTEGRATION_PORT']
    token = Path('/run/secrets/hermes-internal.key').read_text().strip()
    request = Request(f'http://127.0.0.1:{port}/internal/owner-mac/resolve',
        data=json.dumps({'_context': context, **({'device_id': device_id} if device_id else {}),
                         **({'read_only': True} if read_only else {})}).encode(),
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
    with urlopen(request, timeout=10) as response:
        binding = json.load(response)
    if not re.fullmatch(r'[A-Za-z0-9_-]+', binding['device_id']):
        raise ValueError('Invalid paired device ID')
    return binding


@contextmanager
def environment(context, device_id, read_only=False):
    binding = resolve(context, device_id, read_only=True) if read_only else resolve(context, device_id)
    root = Path(os.environ.get('PAIOS_OWNER_MAC_ROOT', '/run/owner-mac')) / binding['device_id']
    env = SSHEnvironment(host=os.environ.get('PAIOS_OWNER_MAC_HOST', '127.0.0.1'),
        user=binding['ssh_user'], port=binding['visitor_port'], cwd=binding['home'],
        key_path=str(root / 'client_key'), terminal_config={
            'ssh_isolated': False, 'ssh_forward_credentials': False, 'ssh_sync': False,
            'ssh_shared_connection': False,
            'ssh_known_hosts': str(root / 'known_hosts'),
            'ssh_host_key_alias': 'owner-mac-' + binding['device_id']})
    try:
        yield env
    finally:
        env.cleanup()


def create_server(observe=False):
    mcp = MCPServer('owner_mac')

    @mcp.tool()
    def exec(command: str, context: dict, device_id: str = '', cwd: str = '', timeout: int = 60) -> dict:
        """Run a shell command on the paired owner Mac. Specify device_id when several Macs are active."""
        if not 1 <= timeout <= 300:
            raise ValueError('timeout must be between 1 and 300 seconds')
        with environment(context, device_id) as env:
            return env.execute(command, cwd=cwd, timeout=timeout, bounded_capture=True)

    @mcp.tool()
    def read(path: str, context: dict, device_id: str = '', offset: int = 1, limit: int = 2000) -> dict:
        """Read a text file on the paired owner Mac using native Hermes file operations."""
        with (environment(context, device_id, read_only=True) if observe else environment(context, device_id)) as env:
            return asdict(ShellFileOperations(env).read_file(path, offset=offset, limit=limit))

    @mcp.tool()
    def write(path: str, content: str, context: dict, device_id: str = '') -> dict:
        """Write a text file on the paired owner Mac with the owner's account permissions."""
        with environment(context, device_id) as env:
            return asdict(ShellFileOperations(env).write_file(path, content))

    @mcp.tool()
    def fetch(path: str, context: dict, device_id: str = '') -> dict:
        """Copy a file (at most 25 MB) from the paired owner Mac into this cloud host; returns the cloud path for
        native tools such as vision_analyze. The bytes never pass through the conversation."""
        with (environment(context, device_id, read_only=True) if observe else environment(context, device_id)) as env:
            done = env.execute(f'test -f {shlex.quote(path)} && head -c {MAX_COPY + 1} < {shlex.quote(path)} | base64', timeout=120)
        if done['returncode'] != 0:
            raise RuntimeError(done['output'][-500:])
        data = base64.b64decode(done['output'])
        if len(data) > MAX_COPY:
            raise ValueError('file larger than 25 MB')
        # vision_analyze reads host files only under Hermes media cache roots when the terminal backend is remote.
        folder = Path(os.environ.get('PAIOS_OWNER_MAC_FILES') or get_hermes_home() / 'cache/owner-mac')
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        for old in folder.iterdir():
            if old.stat().st_mtime < time.time() - 86400:
                old.unlink(missing_ok=True)
        local = folder / f'{uuid.uuid4().hex[:12]}-{Path(path).name}'
        local.write_bytes(data)
        return {'path': str(local), 'bytes': len(data)}

    @mcp.tool()
    def put(source: str, path: str, context: dict, device_id: str = '') -> dict:
        """Copy a cloud file (at most 25 MB) to an absolute path on the paired owner Mac."""
        data = Path(source).read_bytes()
        if len(data) > MAX_COPY:
            raise ValueError('file larger than 25 MB')
        staged = f'{path}.{uuid.uuid4().hex[:8]}.b64'
        with environment(context, device_id) as env:
            written = ShellFileOperations(env).write_file(staged, base64.b64encode(data).decode())
            if written.error:
                raise RuntimeError(written.error)
            done = env.execute(f'base64 -D -i {shlex.quote(staged)} -o {shlex.quote(path)}; s=$?; rm -f {shlex.quote(staged)};'
                               f' [ $s -eq 0 ] && stat -f %z {shlex.quote(path)}', timeout=120)
        if done['returncode'] != 0 or done['output'].strip() != str(len(data)):
            raise RuntimeError(done['output'][-500:])
        return {'path': path, 'bytes': len(data)}

    return mcp


if __name__ == '__main__':
    os.environ.pop('HERMES_WRITE_SAFE_ROOT', None)
    create_server().run('stdio')
