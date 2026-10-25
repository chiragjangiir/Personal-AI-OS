"""Run the selected release's migrations; Compose remains the only container authority."""
import json
from pathlib import Path
import subprocess


def recorded(run, args, receipt, field):
    try:
        result = run(args, capture_output=True)
    except subprocess.CalledProcessError as error:
        if error.stdout:
            receipt[field] = json.loads(error.stdout)
        raise
    if result.stdout:
        receipt[field] = json.loads(result.stdout)


def projection(source):
    declaration = Path(source) / 'deploy/cloud/release-hooks.json'
    if not declaration.exists():
        return None
    return json.loads(declaration.read_text()).get('rollback_projection')


def project_rollback(host, source, target, receipt):
    hook = projection(source)
    if not hook:
        return
    definition = host.definition(target)
    mount = next(mount for mount in definition['services'][hook['source_service'] + host.suffix]['volumes']
                 if mount['target'] == hook['source_target'])
    volume = definition['volumes'][mount['source']]['name'] if mount['type'] == 'volume' else mount['source']
    # Only this declared projection receives a writable legacy home; forward migration retains its RO mount.
    recorded(host.runner(source), ['run', '--rm', '--no-deps', '--pull', 'never', '--user', '0:0',
             '-v', f"{volume}:{hook['writable_target']}:rw", hook['service'] + host.suffix, *hook['command']],
             receipt, 'memory_projection')
