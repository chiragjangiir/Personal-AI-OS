"""Use the deployed Compose services and gateway's authenticated resource authority."""
import json
import os
import re
from contextlib import contextmanager
import fcntl
from pathlib import Path
import subprocess
from string import Template
from uuid import uuid4
from types import SimpleNamespace

import migrate

TOOLS = Path(__file__).resolve().parent
WRITERS = ('gateway', 'hermes', 'workshop', 'workshop-link')


def call_idle(run, gateway='gateway'):
    """Ask the gateway's live-call authority; an owned (opening or live) call refuses the operation."""
    script = """import json,os,pathlib,urllib.request
key=pathlib.Path('/run/secrets/hermes-internal.key').read_text().strip()
request=urllib.request.Request('http://127.0.0.1:'+os.environ['PAIOS_INTEGRATION_PORT']+'/internal/resources',headers={'Authorization':'Bearer '+key})
with urllib.request.urlopen(request,timeout=5) as response: print(json.dumps(json.load(response)))
"""
    result = run(['exec', '-T', gateway, 'python3', '-c', script], capture_output=True, text=True)
    resource = json.loads(result.stdout)
    if resource.get('schema') != 'paios.gateway.resources.v1' or not isinstance(resource.get('terminals'), list):
        raise ValueError('Gateway live-call authority is unavailable')
    for terminal in resource['terminals']:
        state = terminal['resources']
        if not isinstance(state, dict) or 'call' not in state:
            raise ValueError('Gateway terminal call authority is unavailable')
        # The call view also reports camera and reply-archive state between calls; an owned (opening or live)
        # call is the one carrying a top-level call_id. LiveKit device presence rooms are not calls.
        if state['call'] is not None and state['call'].get('call_id') is not None:
            raise ValueError('BUSY: gateway owns a live or preparing call; no snapshot/transfer started')


class Stack:
    def __init__(self, settings, stage=False):
        self.settings = settings
        self.stage = stage
        self.suffix = '-staging' if stage else ''
        self.compose = migrate.compose_cloud(SimpleNamespace(**settings), 'staging' if stage else 'production')
        if 'compose_project' in settings:
            self.compose += ['--project-name', settings['compose_project']]
        if settings.get('parity_compose'):
            self.compose += ['-f', settings['parity_compose']]
        # Restore compares staging with the production services and volumes it must never share, so it reads both.
        profiles = ['--profile', 'production'] if stage else []
        self.definition = json.loads(self.run(profiles + ['config', '--format', 'json'], capture_output=True, text=True).stdout)
        self.gateway = self.definition['services']['gateway' + self.suffix]
        self.image = settings.get('helper_image', self.gateway['image'])
        if 'helper_image' in settings and not re.search(r'(?:@sha256:|^sha256:)[a-f0-9]{64}$', self.image):
            raise ValueError('helper_image requires an immutable loaded image identity')
        self.volumes = self.definition['volumes']

    def run(self, args, **kwargs):
        return subprocess.run(self.compose + args, check=True, **kwargs)

    def release_lock_path(self):
        watchdog = self.definition['services']['release-watchdog' + self.suffix]
        root = Path(next(m['source'] for m in watchdog['volumes'] if m['target'] == '/watchdog'))
        # Docker creates this bind source when the watchdog first starts; a stack that never ran it has none yet.
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        return root / 'release.lock'

    @contextmanager
    def maintenance(self, held=None):
        # Reuse the release authority's lock so its watchdog cannot treat this cut as an outage. The release entry
        # point passes the lock it already holds for the whole release window.
        path = self.release_lock_path()
        if held is not None:
            if os.fstat(held.fileno()).st_ino != path.stat().st_ino:
                raise ValueError('The held lock is not this stack release lock')
            yield
            return
        with path.open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield

    def volume(self, name):
        return self.volumes[name + self.suffix]['name']

    def tools(self, args, work, mounts=(), network='none', image=None, entrypoint=None):
        name = 'paios-snapshot-' + uuid4().hex
        command = ['docker', 'run', '--name', name, '--rm', '--read-only', '--network', network, '--user', '0:0',
                   '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '-e', 'TMPDIR=/work',
                   '-v', str(TOOLS) + ':/opt/paios/deploy/cloud:ro', '-v', str(work) + ':/work']
        for source, target in mounts:
            command += ['-v', str(source) + ':' + target]
        for key, value in self.gateway['environment'].items():
            command += ['-e', key + '=' + str(value)]
        if entrypoint:
            command += ['--entrypoint', entrypoint]
        try:
            subprocess.run(command + [image or self.image] + args, check=True)
        except BaseException:
            # Killing a Docker client does not stop its container. Clean up this one task container on interruption.
            subprocess.run(['docker', 'rm', '--force', name], capture_output=True)
            raise

    def preflight(self, work, spool, budget, raw):
        # Estimate the entire source, not only the recent window. Active writers make this an estimate;
        # the capture alarm remains the authority for the actual stopped interval.
        script = """import json,os,pathlib,shutil,sqlite3,sys,tempfile
sys.path.insert(0,'/opt/paios/deploy/cloud')
from staging_snapshot_data import OMIT,RAW_CONSUMER_STORES,RAW_CONSUMER_PREFIXES
raw=sys.argv[1]=='raw'; size=files=0
def scan(root):
 global size,files
 with os.scandir(root) as entries:
  for entry in entries:
   name=entry.name
   if entry.is_dir(follow_symlinks=False):
    if name not in OMIT and (raw or not (name in {'objects','stream-revisions','manifests','quarantine-manifests','session-finals','visual-memory'} or name in RAW_CONSUMER_STORES or name.startswith(RAW_CONSUMER_PREFIXES))): scan(entry.path)
   elif entry.is_file(follow_symlinks=False): size+=entry.stat(follow_symlinks=False).st_size; files+=1
for root in ('/source/home','/source/owner','/source/errands'): scan(root)
cold=pathlib.Path('/source/owner/central-storage/cold.sqlite')
if raw and cold.exists():
 with tempfile.TemporaryDirectory(dir='/work') as temporary:
  for suffix in ('','-wal','-shm'):
   path=pathlib.Path(str(cold)+suffix)
   if path.exists(): shutil.copyfile(path,temporary+'/cold.sqlite'+suffix)
  with sqlite3.connect(temporary+'/cold.sqlite') as db:
   n,b=db.execute('SELECT count(*),coalesce(sum(size),0) FROM locations').fetchone()
   files+=n; size+=b
sessions=pathlib.Path('/source/owner/central-storage/session-records.sqlite')
if raw and sessions.exists():
 with tempfile.TemporaryDirectory(dir='/work') as temporary:
  for suffix in ('','-wal','-shm'):
   path=pathlib.Path(str(sessions)+suffix)
   if path.exists(): shutil.copyfile(path,temporary+'/session-records.sqlite'+suffix)
  with sqlite3.connect(temporary+'/session-records.sqlite') as db:
   # Folded finals and source receipts incur logical work even with one shared audio object.
   files+=2*db.execute('SELECT count(*) FROM sessions').fetchone()[0]
pathlib.Path('/work/capacity.json').write_text(json.dumps({'files':files,'bytes':size}))
"""
        self.tools(['python3', '-c', script, 'raw' if raw else 'structural'], work,
                   [(self.volume('hermes-home'), '/source/home:ro'), (self.volume('owner-data'), '/source/owner:ro'),
                    (self.volume('errands'), '/source/errands:ro')])
        estimate = json.loads((work / 'capacity.json').read_text())
        pg = self.definition['services']['postgres']
        command = pg['command']
        result = self.run(['exec', '-T', 'postgres', 'psql', '-XAt', '--set', 'ON_ERROR_STOP=1', '--port',
                           command[command.index('-p') + 1], '--username', pg['environment']['POSTGRES_USER'],
                           '--dbname', pg['environment']['POSTGRES_DB'], '-c', 'SELECT pg_database_size(current_database())'],
                          capture_output=True, text=True)
        size, files = estimate['bytes'] + int(result.stdout), estimate['files']
        # Two copies cover validation scratch/indexes and encrypted output, with a growth reserve.
        required = 2 * size + (1 << 30)
        scratch_stat, spool_stat = os.statvfs(work), os.statvfs(spool)
        checks = [(scratch_stat.f_bavail * scratch_stat.f_frsize >= required, 'scratch bytes'),
                  (spool_stat.f_bavail * spool_stat.f_frsize >= required, 'spool bytes'),
                  (scratch_stat.f_favail >= files * 2 + 4096, 'scratch inodes'),
                  (spool_stat.f_favail >= 4096, 'spool inodes'),
                  (240 + files / 100 + size / (4 << 20) < budget, 'estimated stopped interval')]
        for accepted, reason in checks:
            if not accepted:
                raise ValueError('SNAPSHOT_CAPACITY: ' + reason + '; writers remain running')

    def home_config(self, work):
        self.tools(['python3', '/opt/paios/deploy/cloud/staging_snapshot_data.py', 'hermes-config'], work,
                   [(self.volume('hermes-home'), '/source/home:ro')])

    def idle(self):
        call_idle(self.run)

    def counts(self):
        service = 'postgres' + self.suffix
        pg = self.definition['services'][service]
        command = pg['command']
        query = """SELECT format('SELECT json_build_array(%L, count(*)) FROM %I.%I;',
format('%I.%I', schemaname, tablename), schemaname, tablename)
FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY schemaname,tablename
\\gexec
"""
        result = self.run(['exec', '-T', service, 'psql', '-XAt', '--set', 'ON_ERROR_STOP=1',
                           '--port', command[command.index('-p') + 1], '--username', pg['environment']['POSTGRES_USER'],
                           '--dbname', pg['environment']['POSTGRES_DB']], input=query, capture_output=True, text=True)
        return dict(json.loads(line) for line in result.stdout.splitlines())

    def pg(self, operation, stream):
        service = 'postgres' + self.suffix
        pg = self.definition['services'][service]
        command = pg['command']
        flags = ['pg_dump', '--format=custom'] if operation == 'dump' else ['pg_restore', '--exit-on-error']
        self.run(['exec', '-T', service] + flags + ['--no-owner', '--no-acl', '--port',
                  command[command.index('-p') + 1], '--username', pg['environment']['POSTGRES_USER'],
                  '--dbname', pg['environment']['POSTGRES_DB']], **({'stdout': stream} if operation == 'dump' else {'stdin': stream}))

    def config_mount(self):
        return next(m['source'] for m in self.gateway['volumes'] if m['target'] == '/etc/paios/cloud.json')

    def l5(self, work, mode, as_of=None, restored=()):
        mounts = list(restored)
        if mode == 'export':
            mounts = [(self.volume('owner-data'), '/source:ro'), (self.config_mount(), '/etc/paios/cloud.json:ro')]
            # Resolve the existing cold authority's credential mount; never copy its bytes into the bundle.
            cold = json.loads(Path(self.config_mount()).read_text()).get('archive_tiering', {}).get('cold')
            if cold:
                target = Template(cold['password_file']).substitute(self.gateway['environment'])
                source = next((m['source'] for m in self.gateway['volumes'] if m['target'] == target), None)
                if not source or not Path(source).is_file():
                    raise ValueError('Configured cold credential mount is missing; include the deployed archive Compose overlay')
                mounts.append((source, target + ':ro'))
        network = 'none'
        if mode == 'export':
            front = self.run(['ps', '-q', 'front'], capture_output=True, text=True).stdout.strip()
            if not front:
                raise ValueError('Source front network namespace is required for cold reads')
            network = 'container:' + front
        for helper, suffix in [('l5', ''), ('visual', '/visual-memory')]:
            args = ['node', '/opt/paios/deploy/cloud/staging_snapshot_' + helper + '.ts', mode,
                    '--dest', '/work/data/owner-data/central-storage' + suffix]
            if mode == 'export':
                args += ['--source', '/source/central-storage' + suffix, '--as-of', as_of,
                         '--config', '/etc/paios/cloud.json']
            self.tools(args, work, mounts, network=network)
