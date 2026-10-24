"""Control-transfer failures cannot consume an independently renewed job lease."""
import os
import importlib.util
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import select
import shlex
import socket
import subprocess
import sys
import threading
import time
from types import SimpleNamespace

import pytest

SCOPE = Path(__file__).parents[2] / 'deploy/cloud/workshop-scope.py'


@pytest.fixture
def publication_broker(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(SCOPE.parent))
    spec = importlib.util.spec_from_file_location('scope_publication', SCOPE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(module, 'ROOT', Path('.'))
    monkeypatch.setattr(sys, 'argv', [str(SCOPE)])
    original_sigchld = module.signal.getsignal(module.signal.SIGCHLD)
    try:
        yield module
    finally:
        module.signal.signal(module.signal.SIGCHLD, original_sigchld)


def test_control_path_is_published_only_after_the_real_socket_listens(publication_broker, tmp_path, monkeypatch):
    broker = publication_broker
    token = 'd' * 32
    Path(token).mkdir()
    control = Path(token) / 'control'
    original_socket, original_select = socket.socket, select.select

    class Listener(original_socket):
        def listen(self, *args, **kwargs):
            assert not control.exists(), 'exec must not see a bound but unlistened socket'
            return super().listen(*args, **kwargs)

    def observe_ready(readable, *args):
        assert control.exists()
        with original_socket(socket.AF_UNIX) as client:
            client.connect(str(control))
        return original_select(readable, *args)

    monkeypatch.setattr(broker.socket, 'socket', Listener)
    monkeypatch.setattr(broker.select, 'select', observe_ready)
    monkeypatch.setattr(broker, 'Path', lambda p: tmp_path / 'home' if str(p).startswith('/tmp/hermes-workshop-') else Path(p))
    monkeypatch.setattr(broker.os, 'chown', lambda *args: None)
    read_fd, write_fd = os.pipe()
    os.close(write_fd)
    with os.fdopen(read_fd, 'rb', buffering=0) as lease:
        monkeypatch.setattr(sys, 'stdin', SimpleNamespace(buffer=lease))
        broker.serve(token, 20001)  # Real listener publication, then EOF ends this synthetic lease.


def test_exec_during_mode_publication_never_reads_partial_mode(publication_broker, monkeypatch):
    broker = publication_broker
    token = 'a' * 32
    writing, reading, publish = threading.Event(), threading.Event(), threading.Event()
    write_text, read_text = Path.write_text, Path.read_text

    def paused_write(path, text, *args, **kwargs):
        if path.parent.name == token:
            write_text(path, '')  # The old publisher exposes these incomplete bytes.
            writing.set()
            assert publish.wait(5)
        return write_text(path, text, *args, **kwargs)

    def observed_read(path, *args, **kwargs):
        try:
            return read_text(path, *args, **kwargs)
        finally:
            if path.name == 'mode':
                reading.set()

    def serve(*args, **kwargs):
        with socket.socket(socket.AF_UNIX) as server:
            server.bind(token + '/control')
            server.listen()
            server.settimeout(5)
            client, _ = server.accept()
            with client:
                header, descriptors, _, _ = socket.recv_fds(client, 4, 3)
                try:
                    assert len(descriptors) == 3
                    assert client.recv(int.from_bytes(header, 'big')) == b'true'
                    client.sendall(b'0')
                finally:
                    for descriptor in descriptors:
                        os.close(descriptor)
        return 0

    monkeypatch.setattr(Path, 'write_text', paused_write)
    monkeypatch.setattr(Path, 'read_text', observed_read)
    monkeypatch.setattr(broker, 'owner_outputs', lambda *args: None)
    monkeypatch.setattr(broker.subprocess, 'call', serve)
    monkeypatch.setenv('SSH_ORIGINAL_COMMAND', f'workshop-scope start {token}')
    with ThreadPoolExecutor(max_workers=2) as pool:
        start = pool.submit(broker.dispatch)
        try:
            assert writing.wait(5)
            monkeypatch.setenv('SSH_ORIGINAL_COMMAND', f'workshop-scope exec {token} true')
            execute = pool.submit(broker.dispatch)
            assert reading.wait(5)
        finally:
            publish.set()
        assert execute.result(timeout=5) == 0
        assert start.result(timeout=5) == 0
    assert not Path(token).exists()


@pytest.mark.parametrize('mode', ['offline', ''])
def test_exec_rejects_published_mode_mismatch(publication_broker, monkeypatch, mode):
    token = 'b' * 32
    Path(token).mkdir()
    (Path(token) / 'mode').write_text(mode)
    monkeypatch.setenv('SSH_ORIGINAL_COMMAND', f'workshop-scope exec {token} true')
    with pytest.raises(ValueError, match='scope mode mismatch'):
        publication_broker.dispatch()


@pytest.mark.parametrize('ended', [False, True])
def test_wait_ack_requires_broker_scope_removal(publication_broker, monkeypatch, ended):
    token = 'c' * 32
    scope = Path(token)
    scope.mkdir()
    monkeypatch.setenv('SSH_ORIGINAL_COMMAND', f'workshop-scope wait {token}')
    clock = [0]
    monkeypatch.setattr(publication_broker.time, 'monotonic', lambda: clock[0])

    def advance(_seconds):
        clock[0] += 30
        if ended:
            scope.rmdir()  # Simulate the start broker completing namespace wait().

    monkeypatch.setattr(publication_broker.time, 'sleep', advance)
    if ended:
        assert publication_broker.dispatch() == 0
    else:
        with pytest.raises(TimeoutError, match='namespace has not ended'):
            publication_broker.dispatch()
        assert scope.exists()


DRIVER = '''import importlib.util, os, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).parent))
spec = importlib.util.spec_from_file_location('scope', sys.argv[1])
scope = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scope)
root, namespace = Path(sys.argv[2]), sys.argv[3] == 'namespace'
scope.ROOT = root
scope.Path = lambda path: root / 'home' if str(path).startswith('/tmp/hermes-workshop-') else Path(path)
if not namespace:
    scope.os.chown = lambda *args: None
    scope.os.fork = lambda: os.write(1, b'accepted\\n')
    scope.LEASE_SECONDS = 1
scope.serve('test', 20001)
'''


@pytest.fixture
def dispatcher(tmp_path, monkeypatch, request):
    namespace = getattr(request, 'param', '') == 'namespace'
    if namespace:
        if sys.platform != 'linux' or os.geteuid() != 0:
            pytest.skip('PID-namespace proof requires Linux root and CAP_SYS_ADMIN')
        check = subprocess.run(['unshare', '--mount', '--pid', '--fork', '--mount-proc', 'true'],
                               capture_output=True)
        if check.returncode:
            pytest.skip(check.stderr.decode())
    (tmp_path / 'test').mkdir()
    monkeypatch.chdir(tmp_path)  # Keep the Unix socket address below macOS's path limit.
    command = [sys.executable, '-u', '-c', DRIVER, str(SCOPE), '.',
               'namespace' if namespace else 'loop']
    if namespace:
        command = ['unshare', '--mount', '--pid', '--fork', '--mount-proc', '--kill-child=KILL'] + command
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    stop = threading.Event()

    def pulses():
        while not stop.is_set():
            try:
                os.write(process.stdin.fileno(), b'\0')
            except BrokenPipeError:
                return
            stop.wait(0.05)

    writer = threading.Thread(target=pulses)
    writer.start()
    path = Path('test/control')
    try:
        deadline = time.monotonic() + 5
        while not path.exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.01)
        assert path.exists(), process.stderr.read().decode() if process.poll() is not None else 'no control socket'
        yield process, path, stop, writer
    finally:
        stop.set()
        writer.join()
        process.stdin.close()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()  # Only this test's verified child, not any shared service.
            process.wait()
        assert process.returncode == 0, process.stderr.read().decode()


def failed_transfer(path, stage, failure, lease):
    client = socket.socket(socket.AF_UNIX)
    read_fd, write_fd = os.pipe()
    try:
        client.connect(str(path))
        header = (100).to_bytes(4, 'big')
        socket.send_fds(client, [header[:2] if stage == 'header' else header], [read_fd] * 3)
        os.close(read_fd)
        read_fd = None
        if stage == 'body':
            client.sendall(b'x')
        if failure == 'cancel':
            client.shutdown(socket.SHUT_WR)
        client.settimeout(lease + 3)
        assert client.recv(1) == b''
        # Each SCM_RIGHTS copy must be closed, including after partial-header EOF.
        deadline = time.monotonic() + 2
        while True:
            try:
                os.write(write_fd, b'x')
            except BrokenPipeError:
                break
            assert time.monotonic() < deadline, 'failed transfer leaked a received descriptor'
            time.sleep(0.01)
    finally:
        client.close()
        if read_fd is not None:
            os.close(read_fd)
        os.close(write_fd)


@pytest.mark.parametrize('stage', ['header', 'body'])
@pytest.mark.parametrize('failure', ['timeout', 'cancel'])
def test_transfer_failure_preserves_live_lease_and_closes_descriptors(dispatcher, stage, failure):
    process, path, stop, writer = dispatcher
    failed_transfer(path, stage, failure, 1)
    time.sleep(1.2)  # Continue pulses past the original lease deadline.
    assert process.poll() is None
    with socket.socket(socket.AF_UNIX) as client, open(os.devnull, 'rb') as null:
        client.connect(str(path))
        socket.send_fds(client, [b'\0\0'], [null.fileno()] * 3)
        client.sendall(b'\0\x01x')  # A fragmented but complete next request still dispatches.
        assert select.select([process.stdout], [], [], 3)[0]
        assert process.stdout.readline() == b'accepted\n'
    stop.set()
    writer.join()
    process.wait(timeout=2)  # Leave stdin open: actual lease expiry, not EOF.


@pytest.mark.parametrize('dispatcher', ['namespace'], indirect=True)
def test_live_namespace_survives_failed_transfers_then_expires(dispatcher):
    process, path, stop, writer = dispatcher
    command = "import os,time; child=os.fork(); os.setsid() if child==0 else None; " \
              "print('running',flush=True); time.sleep(300)"
    with socket.socket(socket.AF_UNIX) as client, open(os.devnull, 'rb') as null:
        read_fd, write_fd = os.pipe()
        try:
            client.connect(str(path))
            data = ('python3 -u -c ' + shlex.quote(command)).encode()
            socket.send_fds(client, [len(data).to_bytes(4, 'big')], [null.fileno(), write_fd, write_fd])
            client.sendall(data)
            os.close(write_fd)
            write_fd = None
            assert select.select([read_fd], [], [], 5)[0] and os.read(read_fd, 8) == b'running\n'
            owned = set()
            for status in Path('/proc').glob('[0-9]*/status'):
                try:
                    if int(status.read_text().split('Uid:')[1].split()[0]) == 20001:
                        owned.add(status.parent)
                except FileNotFoundError:
                    continue
            assert len(owned) >= 2
            for stage in ('header', 'body'):
                for failure in ('timeout', 'cancel'):
                    failed_transfer(path, stage, failure, 15)
                    assert process.poll() is None and all(pid.exists() for pid in owned)
            stop.set()
            writer.join()
            started = time.monotonic()
            process.wait(timeout=17)
            while any(pid.exists() for pid in owned) and time.monotonic() - started < 17:
                time.sleep(0.01)
            assert not any(pid.exists() for pid in owned)
            print(f'lease expiry removed all descendants in {time.monotonic() - started:.3f}s')
        finally:
            os.close(read_fd)
            if write_fd is not None:
                os.close(write_fd)


@pytest.fixture
def broker(tmp_path, monkeypatch):
    import importlib.util
    import json
    monkeypatch.syspath_prepend(str(SCOPE.parent))
    spec = importlib.util.spec_from_file_location('workshop_broker', SCOPE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.ROOT = tmp_path / 'scopes'
    module.ROOT.mkdir()
    module.OWNER = tmp_path / 'owner'
    module.OWNER.mkdir()
    (module.OWNER / 'out').mkdir()
    module.WORKSHOP = tmp_path / 'workshop'
    module.WORKSHOP.mkdir()
    module.SNAPSHOTS = tmp_path / 'snapshots'
    module.SNAPSHOTS.mkdir(mode=0o700)
    config = module.OWNER / 'config.json'
    config.write_text(json.dumps({'desktop': {'files': {'inbox_ttl_s': 10, 'out_total_bytes': 16}}}))
    monkeypatch.setenv('PAIOS_PRODUCT_CONFIG', str(config))
    monkeypatch.setattr(module.os, 'chown', lambda *args: None)
    return module


def test_I16_scope_mode_is_recorded_propagated_and_mismatched_exec_refused(broker, monkeypatch):
    token = 'a' * 32
    monkeypatch.setattr(sys, 'argv', ['workshop-scope', '--offline'])
    monkeypatch.setenv('SSH_ORIGINAL_COMMAND', f'workshop-scope start {token}')
    def run(command, **kwargs):
        assert '--ipc' in command and len(kwargs['pass_fds']) == 1
        assert '--net' in command and '--offline' in command
        assert (broker.ROOT / token / 'mode').read_text() == 'offline'
        assert (broker.OWNER / 'out' / token).stat().st_mode & 0o777 == 0o755
        monkeypatch.setattr(sys, 'argv', ['workshop-scope'])
        monkeypatch.setenv('SSH_ORIGINAL_COMMAND', f'workshop-scope exec {token} true')
        with pytest.raises(ValueError, match='scope mode mismatch'):
            broker.dispatch()
        return 0
    monkeypatch.setattr(broker.subprocess, 'call', run)
    assert broker.dispatch() == 0
    assert not (broker.ROOT / token).exists()
    assert (broker.OWNER / 'out' / token).is_dir()  # Survives lease for gateway download.


def test_I16_online_start_has_no_owner_output_or_network_namespace(broker, monkeypatch):
    token = 'b' * 32
    monkeypatch.setattr(sys, 'argv', ['workshop-scope'])
    monkeypatch.setenv('SSH_ORIGINAL_COMMAND', f'workshop-scope start {token}')
    def run(command, **kwargs):
        assert '--ipc' not in command and kwargs['pass_fds'] == ()
        assert '--net' not in command and '--offline' not in command
        assert (broker.ROOT / token / 'mode').read_text() == 'online'
        assert not (broker.OWNER / 'out' / token).exists()
        monkeypatch.setattr(sys, 'argv', ['workshop-scope', '--offline'])
        monkeypatch.setenv('SSH_ORIGINAL_COMMAND', f'workshop-scope exec {token} true')
        with pytest.raises(ValueError, match='scope mode mismatch'):
            broker.dispatch()
        return 0
    monkeypatch.setattr(broker.subprocess, 'call', run)
    assert broker.dispatch() == 0


def test_output_sweep_uses_broker_receipt_despite_task_forged_mtime(broker, monkeypatch):
    import json
    clock = [time.time()]
    monkeypatch.setattr(broker.time, 'time', lambda: clock[0])
    token = 'c' * 32
    broker.owner_outputs(token, 20001)
    old = broker.OWNER / 'out' / token
    receipt = broker.OWNER / 'out/.issued' / token
    assert receipt.stat().st_mode & 0o777 == 0o600
    assert receipt.parent.stat().st_mode & 0o777 == 0o700
    (old / 'large').write_bytes(b'x' * 20)
    os.utime(old, (clock[0] + 86400,) * 2)  # Task can alter this, never the broker's receipt.
    clock[0] += 11
    broker.owner_outputs('d' * 32, 20002)
    assert not old.exists() and not receipt.exists()
    kept = broker.OWNER / 'out' / ('d' * 32)
    (kept / 'large').write_bytes(b'x' * 20)
    (broker.OWNER / 'config.json').write_text(json.dumps({'desktop': {'files': {
        'keep_workshop_copies': True, 'inbox_ttl_s': 1, 'out_total_bytes': 16}}}))
    clock[0] += 3600
    with pytest.raises(ValueError, match='OWNER_OUTPUT_CAP_EXCEEDED: 20 bytes exceeds 16'):
        broker.owner_outputs('e' * 32, 20003)
    assert not (broker.OWNER / 'out' / ('e' * 32)).exists()
    clock[0] += 30 * 86400
    broker.owner_outputs('e' * 32, 20003)
    assert not kept.exists()


def test_pre_receipt_outputs_get_one_bounded_migration_window(broker, monkeypatch):
    clock = [time.time()]
    monkeypatch.setattr(broker.time, 'time', lambda: clock[0])
    token = 'a' * 32
    legacy = broker.OWNER / 'out' / token
    legacy.mkdir()
    os.utime(legacy, (clock[0] + 86400,) * 2)
    broker.owner_outputs()
    receipt = broker.OWNER / 'out/.issued' / token
    assert float(receipt.read_text()) == clock[0]
    # Reload the broker as after a restart; only its persisted root receipt establishes age.
    import importlib.util
    spec = importlib.util.spec_from_file_location('restarted_broker', SCOPE)
    restarted = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(restarted)
    restarted.ROOT, restarted.OWNER = broker.ROOT, broker.OWNER
    clock[0] += 11
    restarted.owner_outputs()
    assert not legacy.exists() and not receipt.exists()


def test_output_cap_waits_for_concurrent_admission_lock(broker):
    import fcntl
    script = '''import importlib.util, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).parent))
spec = importlib.util.spec_from_file_location('broker', sys.argv[1])
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)
broker.OWNER = Path(sys.argv[2])
broker.ROOT = broker.OWNER.parent / 'scopes'
print('ready', flush=True)
broker.owner_outputs('f' * 32, 20001)
'''
    with (broker.ROOT / 'outputs.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        process = subprocess.Popen([sys.executable, '-c', script, str(SCOPE), str(broker.OWNER)],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            assert select.select([process.stdout], [], [], 5)[0]
            assert process.stdout.readline() == b'ready\n'
            assert not select.select([process.stdout, process.stderr], [], [], 0.2)[0]
            # A concurrent writer charges bytes before admitting another scope.
            (broker.OWNER / 'out' / 'charged').write_bytes(b'x' * 17)
            assert process.poll() is None
            fcntl.flock(lock, fcntl.LOCK_UN)
            _, stderr = process.communicate(timeout=5)
            assert process.returncode != 0 and b'OWNER_OUTPUT_CAP_EXCEEDED' in stderr
            assert not (broker.OWNER / 'out' / ('f' * 32)).exists()
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()


def test_I16_offline_mounts_hide_other_outputs_and_make_inputs_read_only(broker, monkeypatch):
    commands = []
    monkeypatch.setattr(broker.subprocess, 'run', lambda command, **kwargs: commands.append(command))
    # Redirect only the mountpoint mkdir; mount destinations retain their Linux paths.
    original_mkdir = Path.mkdir
    monkeypatch.setattr(Path, 'mkdir', lambda self, **kwargs: None if str(self).startswith('/owner/out/')
                        else original_mkdir(self, **kwargs))
    snapshot = broker.SNAPSHOTS / 'fixture/tree'
    broker.offline_mounts('a' * 32, snapshot)
    assert ['/usr/bin/mount', '--bind', str(snapshot), '/workshop'] in commands
    assert ['/usr/bin/mount', '--bind', '/workshop', '/workshop'] not in commands
    assert commands[0] == ['/usr/bin/mount', '--make-rprivate', '/']
    assert ['/usr/bin/mount', '-t', 'mqueue', '-o', 'nosuid,nodev,noexec', 'mqueue', '/dev/mqueue'] in commands
    for temporary in ('/tmp', '/dev/shm'):
        assert ['/usr/bin/mount', '-t', 'tmpfs', '-o', 'mode=1777,nosuid,nodev', 'tmpfs', temporary] in commands
    assert ['/usr/bin/mount', '-o', 'remount,bind,ro', '/workshop'] in commands
    assert ['/usr/bin/mount', '-o', 'remount,bind,ro', '/owner/in'] in commands
    assert ['/usr/bin/mount', '-t', 'tmpfs', '-o', 'mode=0755,nosuid,nodev', 'tmpfs', '/owner/out'] in commands
    assert commands[-1] == ['/usr/bin/mount', '--bind', str(broker.OWNER / 'out' / ('a' * 32)),
                            '/owner/out/' + 'a' * 32]
    assert not any(str(broker.OWNER / 'out') == argument for command in commands for argument in command)
