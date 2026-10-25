"""The shared release start (switch and manual rollback) follows each release's own Gateway/Hermes dependency."""
import copy
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'deploy/cloud'))
import release
import release_checks


def compose_services(hermes_first):
    services = yaml.safe_load((ROOT / 'deploy/cloud/compose.yaml').read_text())['services']
    if hermes_first:
        # The pre-authority graph: Gateway waited for a healthy Hermes, Hermes needed nothing from Gateway.
        services = copy.deepcopy(services)
        services['hermes'].pop('depends_on', None)
        services['gateway'].setdefault('depends_on', {})['hermes'] = {'condition': 'service_healthy'}
    return services


def stack(services):
    """Containers become healthy only once everything they need at runtime is healthy (no Compose ordering)."""
    started, calls = set(), []
    needs = {name: set(service.get('depends_on', {})) & {'gateway', 'hermes'} for name, service in services.items()}

    def healthy(name):
        return name in started and all(healthy(dep) for dep in needs.get(name, ()))

    def run(args, **options):
        calls.append(args)
        if args[0] == 'up':
            names = [arg for arg in args if not arg.startswith('-')][1:]
            started.update(names)
            if '--wait' in args and not all(healthy(name) for name in names if name in ('gateway', 'hermes')):
                raise subprocess.CalledProcessError(1, args, 'dependency failed to start: wait timed out')
        elif args[0] == 'exec':
            if not healthy(args[2]):
                raise subprocess.CalledProcessError(1, args)
        elif args[0] == 'run' and 'node' in args and '--input-type=module' in args:
            return SimpleNamespace(stdout=json.dumps({'official_native_ready': healthy('hermes')}) + '\n')
        return SimpleNamespace(stdout='')
    return run, healthy, calls


@pytest.mark.parametrize('hermes_first', [False, True])
def test_release_start_brings_up_the_authority_before_the_service_that_needs_it(monkeypatch, hermes_first):
    services = compose_services(hermes_first)
    run, healthy, calls = stack(services)
    monkeypatch.setattr(release_checks.time, 'sleep', lambda seconds: None)
    monkeypatch.setattr(release_checks, 'postcheck',
                        lambda run, suffix, **kwargs: {'passed': healthy('gateway') and healthy('hermes')})
    host = SimpleNamespace(suffix='', stage='staging', config={'profiles': []},
                           definition=lambda target: {'services': services})
    receipt = {}
    release.start(host, Path('/releases/candidate'), run, receipt)
    assert receipt['native_ready']['official_native_ready'] and receipt['core_postcheck']['passed']
    order = [next(name for name in ('gateway', 'hermes') if name in call)
             for call in calls if call[0] == 'up' and ({'gateway', 'hermes'} & set(call))]
    assert order[:2] == (['hermes', 'gateway'] if hermes_first else ['gateway', 'hermes'])
