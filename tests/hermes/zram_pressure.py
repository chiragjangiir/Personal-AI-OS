#!/usr/bin/env python3
"""Disposable cgroup-v2 probe for a dedicated staging host."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time


def out(*args):
    return subprocess.check_output(args, text=True).strip()


def main():
    if sys.platform != 'linux' or sys.argv[2:] != ['isolated-staging']:
        raise SystemExit('explicit isolated-staging target required')
    if out('stat', '-fc', '%T', '/sys/fs/cgroup') != 'cgroup2fs':
        raise SystemExit('cgroup v2 required')
    image = 'python:3.12-slim'
    subprocess.run(['docker', 'pull', image], check=True, stdout=sys.stderr)
    code = '''import json,os,time
from pathlib import Path
p=Path('/sys/fs/cgroup'); blocks=[]
for i in range(16):
 b=bytearray(8*1024*1024)
 for offset in range(0,len(b),4096): b[offset:offset+512]=os.urandom(512)
 blocks.append(b)
 print(json.dumps({'allocated_mib':len(blocks)*8,'swap_current':int((p/'memory.swap.current').read_text()),'swap_max':(p/'memory.swap.max').read_text().strip()}),flush=True)
 time.sleep(.05)
print('READY',flush=True)
time.sleep(30)
'''
    report = {'time': out('date', '-u', '+%FT%TZ'), 'image': out('docker', 'image', 'inspect', '--format', '{{.Id}}', image)}
    with tempfile.TemporaryDirectory(prefix='paios-mem-1-') as directory:
        root = Path(directory)
        for allowance in (128, 0):
            service = {'image': image, 'profiles': ['staging'], 'network_mode': 'none',
                       'mem_limit': '64m', 'memswap_limit': f'{64+allowance}m', 'cpus': 0.5,
                       'pids_limit': 32, 'read_only': True, 'cap_drop': ['ALL'], 'user': '65534:65534',
                       'command': ['python', '-u', '-c', code]}
            compose = root / 'compose.json'
            compose.write_text(json.dumps({'name': f'paios-mem-1-{allowance}', 'services': {'probe': service}}))
            cmd = ['docker', 'compose', '-f', str(compose), '--profile', 'staging']
            cid = ''
            before = Path('/sys/block/zram0/mm_stat').read_text().split()
            try:
                subprocess.run(cmd + ['up', '-d', '--pull', 'never'], check=True, stdout=sys.stderr)
                cid = out(*cmd, 'ps', '-aq', 'probe')
                deadline = time.monotonic() + 60
                while time.monotonic() < deadline:
                    logs = out('docker', 'logs', cid)
                    state = json.loads(out('docker', 'inspect', '--format', '{{json .State}}', cid))
                    if 'READY' in logs or not state['Running']:
                        break
                    time.sleep(1)
                else:
                    raise RuntimeError('probe did not finish allocation within 60 s')
                rows = [json.loads(line) for line in logs.splitlines() if line.startswith('{')]
                after = Path('/sys/block/zram0/mm_stat').read_text().split()
                result = {'cap_mib': 64, 'swap_allowance_mib': allowance, 'state':
                          {k: state[k] for k in ('Running', 'OOMKilled', 'ExitCode')}, 'samples': rows,
                          'zram_before': list(map(int, before)), 'zram_after': list(map(int, after)),
                          'swapon': out('swapon', '--show', '--bytes'), 'zramctl': out('zramctl', '--bytes')}
                report[str(allowance)] = result
                if allowance:
                    assert 'READY' in logs and state['Running'] and max(r['swap_current'] for r in rows) > 0
                    assert int(after[0]) > int(before[0]), 'no zram data growth'
                    sampled = subprocess.check_output([sys.executable, sys.argv[1], 'memory', '--compose', str(compose),
                        '--env-file', '/dev/null', '--profile', 'staging', '--duration', '15', '--warmup', '0', '--interval', '2'], text=True)
                    result['measure'] = json.loads(sampled)
                else:
                    assert state['OOMKilled'] and state['ExitCode'] == 137 and all(r['swap_current'] == 0 and r['swap_max'] == '0' for r in rows)
            finally:
                subprocess.run(cmd + ['down'], check=True, stdout=sys.stderr)
    report['status'] = 'PASS'
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
