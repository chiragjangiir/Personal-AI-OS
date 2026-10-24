"""Local process lifecycle coverage; pass the compiled owner-ssh-audit executable."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

HELPER = str(Path(sys.argv.pop(1)).resolve())
APP = """
import subprocess, sys, time
from pathlib import Path
helper, marker = sys.argv[1:]
command = 'sleep 120 & echo $$ $! > "' + marker + '"; wait'
child = subprocess.Popen([helper, '--supervise', '/bin/sh', '-c', command], stdin=subprocess.PIPE)
Path(marker + '.helper').write_text(str(child.pid))
sys.stdin.buffer.read(1)
child.stdin.close()
child.wait(timeout=5)
"""


def wait_for(predicate):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("Process lifecycle deadline exceeded")


def running(pid):
    result = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True)
    return result.returncode == 0 and not result.stdout.strip().startswith('Z')


class OwnerSSHLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.apps = []
        self.owned = []
        self.unrelated = subprocess.Popen(['/bin/sleep', '120'])

    def tearDown(self):
        for app in self.apps:
            if app.poll() is None:
                app.stdin.close()
                app.wait(timeout=5)
        for pid in self.owned:
            if running(pid):
                os.kill(pid, signal.SIGKILL)
        self.unrelated.terminate()
        self.unrelated.wait(timeout=5)
        self.temp.cleanup()

    def start_app(self):
        marker = Path(self.temp.name) / str(len(self.apps))
        app = subprocess.Popen([sys.executable, '-c', APP, HELPER, str(marker)], stdin=subprocess.PIPE)
        self.apps.append(app)
        wait_for(lambda: marker.exists() and len(marker.read_text().split()) == 2 and marker.with_suffix('.helper').exists() and marker.with_suffix('.helper').read_text().strip())
        pids = [int(p) for p in marker.read_text().split()]
        self.owned += pids + [int(marker.with_suffix('.helper').read_text())]
        self.assertTrue(all(running(pid) for pid in pids))
        return app, pids

    def assert_stopped(self, pids):
        wait_for(lambda: all(not running(pid) for pid in pids))
        self.assertIsNone(self.unrelated.poll(), 'Unrelated same-user process must survive')

    def test_original_command_is_audited_and_executed(self):
        audit = Path(self.temp.name) / 'audit.jsonl'
        result = subprocess.run([HELPER, str(audit)], env={**os.environ, 'SSH_ORIGINAL_COMMAND': 'printf owner-ssh-test'}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'owner-ssh-test')
        self.assertIn('printf owner-ssh-test', audit.read_text())

    def test_normal_exit(self):
        app, pids = self.start_app()
        app.stdin.close()
        self.assertEqual(app.wait(timeout=5), 0)
        self.assert_stopped(pids)

    def test_forced_kill_restart_pause_resume_pause(self):
        app, old = self.start_app()
        app.kill()
        app.wait(timeout=5)
        app.stdin.close()
        self.assert_stopped(old)
        for _ in range(2):
            restarted, current = self.start_app()
            restarted.stdin.close()
            self.assertEqual(restarted.wait(timeout=5), 0)
            self.assert_stopped(old + current)


if __name__ == '__main__':
    unittest.main()
