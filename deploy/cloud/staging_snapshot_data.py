"""Frozen-store copy and restore-drill evidence. Production sources are read-only."""
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile

HOME_ROOTS = {'state.db', 'MEMORY.md', 'USER.md', 'memory', 'memories', 'skills', 'sessions', 'cron'}
OMIT = {'.env', '.op.env', 'config.yaml', 'auth.json', 'credentials.json', 'backups',
        'plugins', 'cache', 'logs', 'voiceprints', '.snapshots', '.raw-ingress-reserve'}


def staging_private_path(relative):
    """Deployment credentials and executable model transport never cross environments."""
    for name in Path(relative).parts:
        if (name in {'.env', '.op.env', 'config.yaml', 'auth.json', 'credentials.json',
                     'auth', '.auth', '.credentials.json', 'credentials', 'oauth', 'auth-pool', 'auth_pool',
                     '.claude', '.codex', '.qwen', '.aws', 'backups',
                     'provider-tokens', 'transport-overrides.json', 'model-overrides.json',
                     'model_catalog.json', 'model_overrides.json', 'model-settings', 'model-projections', 'vault', 'secrets'}
                or name.startswith(('.env.', 'auth.json.', 'config.yaml.', 'model-settings.', 'model-settings-'))
                or name.endswith(('.key', '.pem', '.password'))):
            return True
    return False


def home_config(source, destination):
    import yaml
    config = yaml.safe_load(Path(source).read_text())
    Path(destination).write_text(json.dumps({key: config[key] for key in ('timezone', '_config_version') if key in config}, indent=2))
    Path(destination).chmod(0o600)
    # Source registrations remain inspectable in staging, without enabling external executors or plugins.
    registry = Path(destination).parent / '.paios-production-registry.json'
    registry.write_text(json.dumps({'mcp_servers': sorted(config.get('mcp_servers', {}))}))
    plugins = Path(source).parent / 'plugins'
    dormant = Path(destination).parent / '.paios-production-plugins'
    if plugins.exists():
        copy_tree(plugins, dormant)


def sqlite_counts(path):
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
        if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise ValueError('SQLite consistency check failed: ' + path.name)
        names = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' "
                           "AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'").fetchall()
        counts = {name: db.execute('SELECT count(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0]
                  for (name,) in names}
        if {'sessions', 'messages'} <= counts.keys():
            orphaned = db.execute('SELECT count(*) FROM messages m LEFT JOIN sessions s ON s.id=m.session_id '
                                  'WHERE s.id IS NULL').fetchone()[0]
            if orphaned:
                raise ValueError('Hermes messages reference missing sessions')
        return counts


def copy_tree(source, destination, hermes=False):
    source, destination = Path(source), Path(destination)
    if source.is_symlink() or not source.is_dir():
        raise ValueError('Expected an existing owner store directory')
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    def walk_error(error):
        raise error
    for directory, folders, files in os.walk(source, followlinks=False, onerror=walk_error):
        parent = Path(directory)
        relative = parent.relative_to(source)
        folders[:] = [name for name in folders if name not in OMIT and not staging_private_path(relative / name) and not name.startswith('.pending-')
                      and not (parent / name).is_symlink()
                      and not (hermes and relative == Path('.') and name not in HOME_ROOTS)
                      and not (not hermes and relative == Path('.') and name == 'central-storage')]
        target = destination / relative
        target.mkdir(parents=True, exist_ok=True, mode=0o700)
        for name in files:
            path = parent / name
            if (path.is_symlink() or name in OMIT or staging_private_path(relative / name) or name.startswith(('.env.', '.pending-'))
                    or name.endswith(('-wal', '-shm', '.key', '.pem', '.password'))
                    or hermes and relative == Path('.') and name not in HOME_ROOTS):
                continue
            if not path.is_file():
                raise ValueError('Unsupported owner object: ' + str(relative / name))
            with path.open('rb') as stream:
                sqlite = stream.read(16) == b'SQLite format 3\x00'
            if sqlite:
                with tempfile.TemporaryDirectory(dir=destination) as temporary:
                    snapshot = Path(temporary) / name
                    for suffix in ('', '-wal', '-shm'):
                        candidate = Path(str(path) + suffix)
                        if candidate.exists():
                            if candidate.is_symlink():
                                raise ValueError('Unsafe SQLite sidecar')
                            shutil.copyfile(candidate, str(snapshot) + suffix)
                    with sqlite3.connect(snapshot) as origin, sqlite3.connect(target / name) as copied:
                        origin.backup(copied)
                        copied.execute('PRAGMA journal_mode=DELETE')
            else:
                shutil.copyfile(path, target / name)
            (target / name).chmod(0o600)


# Per-chunk records of the raw media pipeline. A structural cut without raw L5 omits them with the chunks they track.
RAW_CONSUMER_PREFIXES = ('audio-consumer-', 'media-')
RAW_CONSUMER_STORES = {'processed-media', 'processed-media-inputs', 'derived-audio'}


def copy_auxiliary(source, destination, omit_raw=False):
    """Native L5 exporter owns raw objects; preserve the other integration stores unchanged."""
    raw = {'manifests', 'stream-revisions', 'quarantine-manifests', 'objects', 'source-clock-bases',
           'owner-deletions', 'cold.sqlite', 'cold.sqlite-wal', 'cold.sqlite-shm', 'visual-memory',
           'session-finals', 'session-ends', 'session-records.sqlite', 'session-records.sqlite-wal', 'session-records.sqlite-shm'}
    for path in Path(source).iterdir():
        if path.name in raw or path.name in OMIT or staging_private_path(path.name) or path.name.startswith(('.pending-', '.cold-read-')):
            continue
        if omit_raw and (path.name in RAW_CONSUMER_STORES or path.name.startswith(RAW_CONSUMER_PREFIXES)):
            continue
        if path.is_symlink():
            raise ValueError('Unsafe auxiliary storage link')
        if path.is_dir():
            copy_tree(path, Path(destination) / path.name)
        else:
            raise ValueError('Unrecognized auxiliary storage file: ' + path.name)


def inventory(root):
    result = {'files': {}, 'sqlite': {}}
    for path in sorted(Path(root).rglob('*')):
        if path.is_symlink() or not (path.is_dir() or path.is_file()):
            raise ValueError('Unsafe snapshot member')
        if path.is_file():
            name = str(path.relative_to(root))
            result['files'][name] = path.stat().st_size
            with path.open('rb') as stream:
                if stream.read(16) == b'SQLite format 3\x00' and not name.endswith('/visual-memory/visual.sqlite'):
                    result['sqlite'][name] = sqlite_counts(path)
    if 'hermes-home/state.db' not in result['sqlite']:
        raise ValueError('Hermes state.db is required')
    if not {'sessions', 'messages'} <= result['sqlite']['hermes-home/state.db'].keys():
        raise ValueError('Hermes sessions and messages tables are required')
    return result


def verify(root, expected):
    actual = inventory(root)
    for name in actual['files']:
        if name != 'hermes-home/config.yaml' and staging_private_path(name):
            raise ValueError('Snapshot contains environment credentials or transport: ' + name)
    if actual != expected:
        raise ValueError('Restored file/SQLite row counts differ from captured stores')


if __name__ == '__main__':
    import sys
    if sys.argv[1] == 'copy':
        copy_tree('/source/home', '/work/data/hermes-home', hermes=True)
        copy_tree('/source/owner', '/work/data/owner-data')
        copy_tree('/source/errands', '/work/data/owner-data/state/errands')
    elif sys.argv[1] == 'auxiliary':
        copy_auxiliary('/source/central-storage', '/work/data/owner-data/central-storage', '--omit-raw' in sys.argv[2:])
    elif sys.argv[1] == 'hermes-config':
        home_config('/source/home/config.yaml', '/work/data/hermes-home/config.yaml')
    elif sys.argv[1] == 'inventory':
        Path('/work/files.json').write_text(json.dumps(inventory(Path('/work/data')), sort_keys=True))
    elif sys.argv[1] == 'verify':
        verify(Path('/work/data'), json.loads(Path('/work/files.json').read_text()))
    elif sys.argv[1] == 'install':
        for name, target in [('hermes-home', '/restore/home'), ('owner-data', '/restore/owner')]:
            shutil.copytree('/work/data/' + name, target, dirs_exist_ok=True)
            for path in [Path(target), *Path(target).rglob('*')]:
                os.chown(path, 10000, 10000)
    else:
        raise SystemExit('Expected copy, inventory or verify')
