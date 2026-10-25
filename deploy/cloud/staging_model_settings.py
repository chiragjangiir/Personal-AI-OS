"""Install a target authority projection before staging model services start."""
import json
import importlib.util
import os
import re
from pathlib import Path


def staging_environment(value):
    if not value or not re.fullmatch(r'staging-[a-z0-9][a-z0-9_.-]{0,119}', value):
        raise ValueError('A target staging model-settings environment is required')
    return value


def load_projection(path, environment, secrets, profile='owner', group='brain'):
    staging_environment(environment)
    if not path:
        raise ValueError('A target authority model-settings projection is required')
    path = Path(path).resolve()
    if not path.is_relative_to(Path(secrets).resolve()):
        raise ValueError('Model-settings projection must belong to target staging secrets')
    spec = importlib.util.spec_from_file_location('model_transport', Path(__file__).parents[2] /
        'integrations/hermes/personal_aios/model_transport.py')
    transport = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(transport)
    projection = transport.read_projection(path)
    if not projection['configured']:
        raise ValueError('Model credentials must be configured before staging restore')
    if (projection['environment_id'] != environment or projection['profile'] != profile
            or projection['group'] != group or projection['revision'] < 1):
        raise ValueError('Model-settings projection does not match the target staging authority')
    return projection


def load_projections(brain, build, environment, secrets):
    return {'brain': load_projection(brain, environment, secrets),
            'build': load_projection(build, environment, secrets, 'workshop', 'build')}


def install_projection(projection, home):
    """Replace the complete transport; never merge restored production routes."""
    home = Path(home)
    home.mkdir(parents=True, exist_ok=True)
    path = home / 'config.yaml'
    path.write_text(json.dumps(projection['config'], indent=2))
    path.chmod(0o600)
    os.chown(path, 10000, 10000)


def receipt(projection):
    return {group: {key: value[key] for key in ('environment_id', 'profile', 'revision', 'group', 'configured')}
            for group, value in projection.items()}


def install_projections(projections, home, directory=None):
    directory = Path(directory) if directory else Path(home) / 'model-settings'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chown(directory, 10000, 10000)
    for group, projection in projections.items():
        serialized = json.dumps(projection, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n'
        revision = directory / 'revisions' / str(projection['revision']) / (projection['profile'] + '.json')
        revision.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        for parent in (directory / 'revisions', revision.parent):
            parent.chmod(0o700)
            os.chown(parent, 10000, 10000)
        if revision.exists():
            if revision.read_text() != serialized:
                raise ValueError('Immutable model-settings revision already exists with different contents')
        else:
            revision.write_text(serialized)
            revision.chmod(0o400)
            os.chown(revision, 10000, 10000)
        temporary = directory / f'.{group}-current.tmp'
        temporary.write_text(serialized)
        temporary.chmod(0o400)
        os.chown(temporary, 10000, 10000)
        temporary.replace(directory / ('current.json' if group == 'brain' else 'build-current.json'))
    install_projection(projections['brain'], home)
    install_projection(projections['build'], Path(home) / 'workshop')


if __name__ == '__main__':
    import sys
    install_projections(json.loads(sys.stdin.read() if sys.argv[1] == '-' else Path(sys.argv[1]).read_text()),
                        sys.argv[2], sys.argv[3])
