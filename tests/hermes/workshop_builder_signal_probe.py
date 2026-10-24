"""On the build host, verify init can stop the builder after its UID transition."""
import argparse
import json
from pathlib import Path
import subprocess
import time
import uuid

import yaml


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True, help='An already loaded Hermes image; no model requests are made')
    args = parser.parse_args()
    cloud = Path(__file__).resolve().parents[2] / 'deploy/cloud'
    caps = yaml.safe_load((cloud / 'compose.workshop-build.yaml').read_text())['services']['builder']['cap_add']
    code = ('import os,signal,time;os.setgid(10000);os.setuid(10000);'
            'signal.signal(signal.SIGTERM,lambda *_:exit(0));print("ready",flush=True);time.sleep(60)')
    results = []
    for configured in (False, True):
        name = 'paios-builder-signal-' + uuid.uuid4().hex[:10]
        command = ['docker', 'run', '-d', '--name', name, '--init', '--network', 'none', '--read-only',
                   '--memory', '128m', '--cpus', '.25', '--cap-drop', 'ALL']
        for cap in caps:
            if configured or cap != 'KILL':
                command += ['--cap-add', cap]
        try:
            subprocess.run(command + ['--entrypoint', '/opt/hermes/.venv/bin/python', args.image, '-c', code],
                           check=True, capture_output=True)
            for _ in range(30):
                if b'ready' in subprocess.check_output(['docker', 'logs', name]):
                    break
                time.sleep(.1)
            started = time.monotonic()
            subprocess.run(['docker', 'stop', '-t', '3', name], check=True, capture_output=True)
            state = json.loads(subprocess.check_output(['docker', 'inspect', name]))[0]['State']
            log = subprocess.check_output(['docker', 'logs', name], stderr=subprocess.STDOUT).decode()
            results.append({'configured': configured, 'exit': state['ExitCode'], 'oom': state['OOMKilled'],
                            'stop_seconds': round(time.monotonic() - started, 3), 'log': log})
        finally:
            subprocess.run(['docker', 'rm', '-f', name], check=True, capture_output=True)
    print(json.dumps(results, indent=2))
    assert results[0]['exit'] != 0 and 'Operation not permitted' in results[0]['log']
    assert results[1]['exit'] == 0 and not results[1]['oom']


if __name__ == '__main__':
    main()
