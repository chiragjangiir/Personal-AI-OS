"""Linux integration proof through the production broker, without SSH or external data."""
import ctypes
import fcntl
import json
import os
from pathlib import Path
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid

import pytest

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parents[1] / 'deploy/cloud/workshop-scope.py'


def test_offline_kernel_boundary_and_local_document_workflow():
    if sys.platform != 'linux' or os.geteuid() != 0:
        pytest.skip('requires Linux root and CAP_SYS_ADMIN; use isolated compose fixture')
    check = subprocess.run(['unshare', '--net', '--ipc', '--mount', '--pid', '--fork', 'true'],
                           capture_output=True, text=True)
    if check.returncode:
        pytest.skip('namespace capability unavailable: ' + check.stderr.strip())
    if not all(Path(p).is_dir() for p in ('/workshop', '/owner/in', '/owner/out')):
        pytest.skip('requires workshop mountpoints; use isolated compose fixture')
    disk = Path('/var/lib/workshop-proof')
    disk.mkdir(mode=0o700, exist_ok=True)
    base = Path(tempfile.mkdtemp(prefix='dk-kernel-', dir=disk))
    base.chmod(0o755)
    token = uuid.uuid4().hex
    marker = 'dk-kernel-' + token
    libc = ctypes.CDLL(None, use_errno=True)
    queue_key = 0x40000000 | (os.getpid() & 0xffffff)
    queue = libc.msgget(queue_key, 0o1000 | 0o2000 | 0o666)
    assert queue >= 0, 'cannot create isolated synthetic SysV queue'
    mq_name = '/' + marker
    previous_umask = os.umask(0)
    try:
        mq = libc.mq_open(mq_name.encode(), os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o666, None)
    finally:
        os.umask(previous_umask)
    process = None
    stop = threading.Event()
    pulse = None
    try:
        assert mq >= 0, 'cannot create synthetic POSIX queue'
        assert Path('/dev/mqueue' + mq_name).exists()
        (base / 'scopes').mkdir(mode=0o700)
        for path in ('owner/in', 'owner/out', 'live'):
            (base / path).mkdir(parents=True)
        (base / 'live').chmod(0o700)
        config = base / 'owner/config.json'
        config.write_text('{}')
        document = base / 'live/document.txt'
        document.write_text('synthetic document\n')
        os.mkfifo(base / 'live/fifo')
        for directory in ('/tmp', '/dev/shm'):
            (Path(directory) / marker).write_text('online namespace marker')
        with socket.socket(socket.AF_UNIX) as live, socket.socket() as tcp, document.open() as locked:
            live.bind(str(base / 'live/socket'))
            live.listen()
            tcp.bind(('127.0.0.1', 0))
            tcp.listen()
            fcntl.flock(locked, fcntl.LOCK_EX | fcntl.LOCK_NB)
            expected = {'marker': marker, 'queue_key': queue_key, 'mq': mq_name,
                        'port': tcp.getsockname()[1],
                        'inode': [document.stat().st_dev, document.stat().st_ino],
                        'namespaces': {name: os.readlink('/proc/self/ns/' + name)
                                       for name in ('net', 'ipc', 'mnt', 'pid')}}
            environment = dict(os.environ, DK_KERNEL_BASE=str(base), DK_KERNEL_SOURCE=str(SOURCE),
                               PAIOS_PRODUCT_CONFIG=str(config),
                               SSH_ORIGINAL_COMMAND=f'workshop-scope start {token}')
            command = [sys.executable, str(HERE / 'workshop_kernel_driver.py'), '--offline']
            process = subprocess.Popen(command, env=environment, stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)

            def heartbeat():
                while not stop.is_set():
                    try:
                        os.write(process.stdin.fileno(), b'\0')
                    except BrokenPipeError:
                        return
                    stop.wait(0.5)

            pulse = threading.Thread(target=heartbeat)
            pulse.start()
            control = base / 'scopes' / token / 'control'
            deadline = time.monotonic() + 15
            while not control.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            assert control.exists(), ('no production control socket', process.poll(),
                                      process.stderr.read().decode() if process.poll() is not None else '')
            environment['SSH_ORIGINAL_COMMAND'] = ('workshop-scope exec ' + token + ' ' + shlex.quote(
                'python3 ' + shlex.quote(str(HERE / 'workshop_kernel_probe.py')) + ' ' +
                shlex.quote(json.dumps(expected))))
            result = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=30)
            assert result.returncode == 0, result.stdout + result.stderr
            assert json.loads(result.stdout)['offline_kernel_proof'] == 'passed'
            artifact = base / 'owner/out' / token / 'offline.docx'
            assert artifact.stat().st_size > 0
            print(result.stdout.strip())
        stop.set()
        pulse.join()
        process.stdin.close()
        process.stdin = None
        _, stderr = process.communicate(timeout=10)
        assert process.returncode == 0, stderr.decode()
        assert artifact.exists(), 'artifact must survive scope teardown'
        assert not (base / 'scopes' / token).exists()
    finally:
        stop.set()
        if pulse is not None:
            pulse.join()
        if process is not None and process.poll() is None:
            if process.stdin is not None:
                process.stdin.close()
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        libc.msgctl(queue, 0, None)  # IPC_RMID, only this test's queue.
        if mq >= 0:
            libc.mq_close(mq)
            libc.mq_unlink(mq_name.encode())
        for directory in ('/tmp', '/dev/shm'):
            (Path(directory) / marker).unlink(missing_ok=True)
        shutil.rmtree(base)
