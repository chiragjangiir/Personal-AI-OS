#!/usr/bin/python3
"""Root-only SSH dispatcher. Namespace PID1 is the complete job lifetime boundary."""
import ctypes
import errno
import fcntl
import json
import os
from pathlib import Path
import re
import select
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time
from workshop_snapshot import acquire as acquire_snapshot, release as release_snapshot, reclaim as reclaim_snapshots

ROOT = Path('/run/workshop-scopes')
LEASE_SECONDS = 15
OWNER = Path('/srv/owner')
WORKSHOP = Path('/workshop')
SNAPSHOTS = Path('/srv/workshop-snapshots')


def owner_files():
    config = Path(os.environ.get('PAIOS_PRODUCT_CONFIG', '/srv/owner/config.json'))
    return json.loads(config.read_text()).get('desktop', {}).get('files', {})


def owner_outputs(token=None, uid=None):
    """Broker-owned storage admission; starts and startup share one lock."""
    files = owner_files()
    ttl = 30 * 86400 if files.get('keep_workshop_copies', False) else files.get('inbox_ttl_s', 7200)
    cap = files.get('out_total_bytes', 256 * 1024 ** 2)
    output = OWNER / 'out'
    receipts = output / '.issued'  # Root-only, persistent; task mtimes never establish age.
    with (ROOT / 'outputs.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        receipts.mkdir(mode=0o700, exist_ok=True)
        now = time.time()
        for path in output.iterdir():
            if not re.fullmatch('[0-9a-f]{32}', path.name):
                continue
            receipt = receipts / path.name
            if not receipt.exists():
                # Pre-receipt outputs get one bounded migration window, never their task-owned mtime.
                receipt.write_text(str(now))
                receipt.chmod(0o600)
            if now - float(receipt.read_text()) > ttl:
                if path.is_symlink():
                    path.unlink()
                else:
                    shutil.rmtree(path)
                receipt.unlink()
        for receipt in receipts.iterdir():
            if not (output / receipt.name).exists():
                receipt.unlink()
        if token is not None:
            used = sum((Path(base) / name).lstat().st_size
                       for base, _, names in os.walk(output, followlinks=False)
                       if Path(base) != receipts for name in names)
            if used > cap:
                raise ValueError(f'OWNER_OUTPUT_CAP_EXCEEDED: {used} bytes exceeds {cap}; retry after outputs expire')
            path = output / token
            path.mkdir(mode=0o755)
            receipt = receipts / token
            receipt.write_text(str(now))
            receipt.chmod(0o600)
            os.chown(path, uid, 10001)
            path.chmod(0o755)


def offline_mounts(token, snapshot):
    # All changes stay inside this scope's private mount namespace.
    mount = lambda *args: subprocess.run(['/usr/bin/mount', *args], check=True)
    mount('--make-rprivate', '/')
    mount('-t', 'mqueue', '-o', 'nosuid,nodev,noexec', 'mqueue', '/dev/mqueue')
    for temporary in ('/tmp', '/dev/shm'):
        mount('-t', 'tmpfs', '-o', 'mode=1777,nosuid,nodev', 'tmpfs', temporary)
    mount('--bind', str(snapshot), '/workshop')
    mount('-o', 'remount,bind,ro', '/workshop')
    mount('--bind', str(OWNER / 'in'), '/owner/in')
    mount('-o', 'remount,bind,ro', '/owner/in')
    mount('-t', 'tmpfs', '-o', 'mode=0755,nosuid,nodev', 'tmpfs', '/owner/out')
    destination = Path('/owner/out') / token
    destination.mkdir(mode=0o755)
    mount('--bind', str(OWNER / 'out' / token), str(destination))


def offline_socket_policy():
    """Inherited kernel policy at the task launch boundary; broker IPC stays open."""
    library = ctypes.CDLL('libseccomp.so.2', use_errno=True)
    library.seccomp_init.argtypes = [ctypes.c_uint32]
    library.seccomp_init.restype = ctypes.c_void_p
    library.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    library.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    library.seccomp_load.argtypes = [ctypes.c_void_p]
    library.seccomp_release.argtypes = [ctypes.c_void_p]
    context = library.seccomp_init(0x7fff0000)  # SCMP_ACT_ALLOW
    if not context:
        raise OSError('cannot initialize offline socket policy')
    try:
        # Keep ordinary local sockets; prevent asynchronous kernel IO from bypassing the boundary.
        for name in (b'io_uring_setup',):
            number = library.seccomp_syscall_resolve_name(name)
            if number == -1:
                raise OSError(f'unknown socket-policy syscall: {name!r}')
            status = library.seccomp_rule_add(context, 0x00050000 | errno.EPERM, number, 0)
            if status < 0:
                raise OSError(-status, 'cannot configure offline socket policy')
        status = library.seccomp_load(context)  # libseccomp sets no_new_privs before loading.
        if status < 0:
            raise OSError(-status, 'cannot enforce offline socket policy')
    finally:
        library.seccomp_release(context)


def serve(token, uid, offline=False, snapshot=None):
    if offline:
        if snapshot is None:
            raise ValueError('offline scope requires a broker snapshot')
        offline_mounts(token, snapshot)
    scope = ROOT / token
    home = Path('/tmp/hermes-workshop-' + token)
    home.mkdir(mode=0o700)
    os.chown(home, uid, 10001)
    server = socket.socket(socket.AF_UNIX)
    server.bind(str(scope / 'control.pending'))
    server.listen()
    os.replace(scope / 'control.pending', scope / 'control')
    signal.signal(signal.SIGCHLD, signal.SIG_IGN)
    deadline = time.monotonic() + LEASE_SECONDS
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return  # Linux kills ALL namespace descendants when PID1 exits.
        ready, _, _ = select.select([server, sys.stdin.buffer], [], [], remaining)
        if time.monotonic() >= deadline:
            return
        # Heartbeats use the root-only SSH stdin lease, never task-owned state.
        if sys.stdin.buffer in ready:
            pulse = os.read(0, 4096)
            if not pulse or pulse.strip(b'\0'):
                return
            deadline = time.monotonic() + LEASE_SECONDS
        if server not in ready:
            continue
        connection, _ = server.accept()
        request_deadline = time.monotonic() + LEASE_SECONDS
        header, data, descriptors = b'', b'', []
        try:
            try:
                # Request expiry drops only this transfer; the lease keeps renewing.
                while len(header) < 4 or len(data) < int.from_bytes(header, 'big'):
                    remaining = min(deadline, request_deadline) - time.monotonic()
                    if remaining <= 0:
                        break
                    ready, _, _ = select.select([connection, sys.stdin.buffer], [], [], remaining)
                    if time.monotonic() >= deadline:
                        return
                    if sys.stdin.buffer in ready:
                        pulse = os.read(0, 4096)
                        if not pulse or pulse.strip(b'\0'):
                            return
                        deadline = time.monotonic() + LEASE_SECONDS
                    if connection not in ready:
                        continue
                    if len(header) < 4:
                        part, received, flags, _ = socket.recv_fds(connection, 4 - len(header), 3)
                        descriptors.extend(received)
                        header += part
                        if flags & socket.MSG_CTRUNC:
                            break
                    else:
                        part = connection.recv(int.from_bytes(header, 'big') - len(data))
                        data += part
                    if not part:
                        break
            except OSError:
                continue  # Drop this local transfer without ending other owned commands.
            if (len(header) != 4 or len(data) != int.from_bytes(header, 'big')
                    or len(descriptors) != 3):
                continue
            pid = os.fork()
            if pid == 0:
                server.close()
                signal.signal(signal.SIGCHLD, signal.SIG_DFL)
                command = ['/usr/bin/setpriv', '--bounding-set=-all', '--inh-caps=-all',
                           '--ambient-caps=-all', '--no-new-privs', f'--reuid={uid}',
                           '--regid=10001', '--clear-groups', '/usr/bin/env', '-i',
                           f'HOME={home}', 'USER=yimi', 'PATH=/usr/local/bin:/usr/bin:/bin',
                           *([f'OUT=/owner/out/{token}'] if offline else []),
                           '/bin/bash', '-c', data.decode()]
                if offline:
                    offline_socket_policy()
                process = subprocess.Popen(command, stdin=descriptors[0], stdout=descriptors[1],
                                           stderr=descriptors[2], umask=0o002)
                child = os.pidfd_open(process.pid)
                if connection in select.select([connection, child], [], [])[0]:
                    process.terminate()
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                    os._exit(0)
                connection.sendall(str(process.wait()).encode())
                os._exit(0)
        finally:
            connection.close()
            for descriptor in descriptors:
                os.close(descriptor)


def dispatch():
    arguments = sys.argv[1:]
    offline = '--offline' in arguments
    if offline:
        arguments.remove('--offline')
    if arguments == ['--sweep']:
        owner_outputs()
        with (ROOT / 'outputs.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            return reclaim_snapshots(SNAPSHOTS)
    if len(arguments) in (3, 4) and arguments[0] == '--serve':
        return serve(arguments[1], int(arguments[2]), offline, Path(arguments[3]) if len(arguments) == 4 else None)
    if arguments:
        raise ValueError('invalid broker arguments')
    parts = shlex.split(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    if len(parts) < 3 or parts[0] != 'workshop-scope':
        raise ValueError('only workshop-scope protocol is accepted')
    action, token = parts[1:3]
    if not re.fullmatch('[0-9a-f]{32}', token):
        raise ValueError('invalid scope identity')
    scope = ROOT / token
    if action == 'wait' and len(parts) == 3:
        # Only start removes this root-owned directory, after namespace wait().
        deadline = time.monotonic() + LEASE_SECONDS + 10
        while scope.exists():
            if time.monotonic() >= deadline:
                raise TimeoutError('workshop namespace has not ended')
            time.sleep(0.02)
        return 0
    if action == 'start' and len(parts) == 3:
        scope.mkdir(mode=0o700)
        mode = scope / 'mode.tmp'
        mode.write_text('offline' if offline else 'online')
        mode.replace(scope / 'mode')
        # Root-owned monotonic allocation prevents concurrent jobs sharing an identity.
        with (ROOT / 'uid').open('a+') as counter:
            fcntl.flock(counter, fcntl.LOCK_EX)
            counter.seek(0)
            uid = int(counter.read() or '20000') + 1
            counter.seek(0)
            counter.truncate()
            counter.write(str(uid))
        lease = None
        try:
            owner_outputs(token if offline else None, uid)
            snapshot = None
            if offline:
                with (ROOT / 'outputs.lock').open('a') as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX)
                    snapshot, lease = acquire_snapshot(WORKSHOP, SNAPSHOTS, owner_files().get('snapshot_total_bytes', 256 * 1024 ** 2))
            return subprocess.call(['/usr/bin/unshare', *(['--net', '--ipc'] if offline else []), '--mount', '--pid', '--fork',
                                    '--mount-proc', '--kill-child=KILL',
                                    '/usr/bin/python3', __file__, *(['--offline'] if offline else []), '--serve', token, str(uid),
                                    *([str(snapshot)] if snapshot else [])], pass_fds=(() if lease is None else (lease,)))
        finally:
            if lease is not None:
                with (ROOT / 'outputs.lock').open('a') as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX)
                    release_snapshot(SNAPSHOTS, lease)
            # wait() above completes only after namespace PID1 has exited.
            home = Path('/tmp/hermes-workshop-' + token)
            if home.is_symlink():
                home.unlink()
            elif home.exists():
                shutil.rmtree(home)
            shutil.rmtree(scope)
    if action != 'exec' or len(parts) != 4:
        raise ValueError('invalid scope operation')
    client = socket.socket(socket.AF_UNIX)
    deadline = time.monotonic() + 10
    while True:
        try:
            if (scope / 'mode').read_text() != ('offline' if offline else 'online'):
                raise ValueError('scope mode mismatch')
            client.connect(str(scope / 'control'))
            break
        except FileNotFoundError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.02)
    data = parts[3].encode()
    socket.send_fds(client, [len(data).to_bytes(4, 'big')], [0, 1, 2])
    client.sendall(data)
    status = client.recv(32)
    if not status:
        raise RuntimeError('scope terminated before command completion')
    return int(status)


if __name__ == '__main__':
    sys.exit(dispatch())
