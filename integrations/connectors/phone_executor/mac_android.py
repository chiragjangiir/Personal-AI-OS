"""ADB over the paired owner-Mac SSH visitor; the host owns the persistent device."""
import contextlib
import json
import os
from pathlib import Path
import re
import shlex
import socket
import subprocess
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

OFFLINE = "手机执行器不在线。"
UNREACHABLE = "Mac 不可达，无法连接安卓执行手机。"


class Unavailable(RuntimeError):
    def __init__(self, answer=OFFLINE):
        super().__init__(answer)


def _run(argv):
    try:
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired as exc:
        raise Unavailable(UNREACHABLE if argv[0] == 'ssh' else OFFLINE) from exc
    if result.returncode == 255:
        raise Unavailable(UNREACHABLE)
    if result.returncode:
        raise RuntimeError(f"Mac Android command failed ({result.returncode}): {result.stderr.strip()[:240]}")
    return result.stdout.strip()


@contextlib.contextmanager
def channel(binding):
    root = Path(os.environ.get('PAIOS_OWNER_MAC_ROOT', '/run/owner-mac')) / binding['device_id']
    with tempfile.TemporaryDirectory(prefix='paios-adb-', dir='/tmp') as folder:
        control = str(Path(folder) / 'ssh')
        ssh = ['ssh', '-F', '/dev/null', '-T', '-S', control, '-p', str(binding['visitor_port']),
            '-i', str(root / 'client_key'), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
            '-o', 'StrictHostKeyChecking=yes', '-o', f'UserKnownHostsFile={root / "known_hosts"}',
            '-o', f'HostKeyAlias=owner-mac-{binding["device_id"]}', '-o', 'ConnectTimeout=10',
            '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=1', '-o', 'ExitOnForwardFailure=yes']
        target = binding['ssh_user'] + '@127.0.0.1'
        try:
            _run([*ssh, '-M', '-fN', target])
            yield ssh, target, str(Path(binding['home']) / 'Library/Application Support/Yimi/Android/control')
        finally:
            if Path(control).exists():
                _run([*ssh, '-O', 'exit', target])


def _request(connection, action):
    ssh, target, command = connection
    reply = json.loads(_run([*ssh, target, shlex.quote(command) + ' ' + action]))
    if (reply.get('schema') != 'paios.mac-android.v1' or
            reply.get('state') not in {'running', 'starting', 'stopped', 'not_installed'} or
            type(reply.get('adb_port')) is not int or not 1 <= reply['adb_port'] <= 65535):
        raise ValueError('Invalid Mac Android host response')
    return reply


def request(context, action='status'):
    try:
        token = Path('/run/secrets/hermes-internal.key').read_text().strip()
        request = Request(f"http://127.0.0.1:{os.environ['PAIOS_INTEGRATION_PORT']}/internal/owner-mac/resolve",
            data=json.dumps({'_context': context}).encode(), headers={
                'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
        try:
            with urlopen(request, timeout=10) as response:
                binding = json.load(response)
        except HTTPError as exc:
            if exc.code != 409:
                raise
            raise Unavailable() from exc
        except (URLError, TimeoutError) as exc:
            raise Unavailable() from exc
        if not re.fullmatch(r'[A-Za-z0-9_-]+', binding['device_id']):
            raise ValueError('Invalid paired device ID')
        with channel(binding) as connection:
            reply = _request(connection, action)
    except Unavailable:
        return None, {'provider': 'mac-android', 'status': 'unavailable', 'answer': UNREACHABLE}
    status = 'ready' if reply['state'] == 'running' else 'starting' if reply['state'] == 'starting' else 'unavailable'
    label = {'running': '已就绪', 'starting': '正在启动', 'stopped': '已停止', 'not_installed': '未安装'}[reply['state']]
    return binding, {**reply, 'provider': 'mac-android', 'status': status,
        'answer': f"Mac 安卓执行手机{label}（状态：{reply['state']}）。" + (reply.get('last_error') or '')}


@contextlib.contextmanager
def phone(binding):
    with channel(binding) as connection:
        reply = _request(connection, 'status')
        if reply['state'] in {'stopped', 'starting'}:
            deadline = time.monotonic() + 90
            try:
                reply = _request(connection, 'start')
            except Unavailable:
                raise
            except RuntimeError as exc:
                raise Unavailable(f"Mac 安卓执行手机启动失败（状态：{reply['state']}）：{exc}") from exc
            while reply['state'] == 'starting' and time.monotonic() < deadline:
                time.sleep(1)
                reply = _request(connection, 'status')
        if reply['state'] != 'running':
            raise Unavailable(f"Mac 安卓执行手机启动失败（状态：{reply['state']}）。" + (reply.get('last_error') or ''))
        with socket.socket() as local:
            local.bind(('127.0.0.1', 0))
            port = local.getsockname()[1]
        ssh, target, _ = connection
        _run([*ssh, '-O', 'forward', '-L', f'127.0.0.1:{port}:127.0.0.1:{reply["adb_port"]}', target])
        serial, adb = f'127.0.0.1:{port}', os.environ.get('PAIOS_ADB', 'adb')
        try:
            try:
                _run([adb, 'connect', serial])
            except RuntimeError as exc:
                raise Unavailable() from exc
            yield serial
        finally:
            _run([adb, 'disconnect', serial])
