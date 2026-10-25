"""Build host steps of a release: serial image build, core suites inside the candidate images, real-data staging.

All three run under the build host's single release lock, so builds, suites and staging never compete for its CPU,
memory or disk. Receipts are written into `<release>/.release/` and bind every result to the same immutable image IDs.
"""
from datetime import datetime, timezone
from contextlib import contextmanager, nullcontext
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import time

import release_source
from watchdog_platform import atomic_write

ROLES = ('gateway', 'hermes', 'front', 'workshop', 'watchdog')
BACKEND = '/opt/paios/01-product-half-finished/backend'
SUITE_FIXTURES = (
    'tests', 'deploy', 'scripts',
    '01-product-half-finished/apple/current-mac-source-20260930/clients/phase0/apple-native/'
    'PersonalAIOSPhase0/OpenSource/apple-health-exporter/app/Contracts',
    '01-product-half-finished/glasses-android/app/src/main/java/com/personalaios/glasses/CompanionService.kt',
    '01-product-half-finished/glasses-android/app/src/test/resources/formal-message.v1.json',
    '01-product-half-finished/rayneo-android/app/src/debug/assets/rayneo_debug_local_audio.pcm.gz.b64',
)
NODE_TEST = 'node --test --test-concurrency=1 --test-reporter=spec'
NATIVE_GATEWAY = ('mac-product-provision-config', 'self-mcp')
NATIVE_INTEGRATION = ('cron-lineage', 'native-producer-contract', 'standing-watch', 'voiceprint-authority')
CARE_NATIVE = '^legacy care run tools retain native isolation across provider HTTP$'
# Cross-native consumers run with Hermes Python and the exact gateway backend; ordinary JS keeps shipped Node 24.
SUITES = {
    'gateway': ('gateway', BACKEND + '/phase0/gateway', NODE_TEST + ' tests/!(' + '|'.join(NATIVE_GATEWAY) + ').test.ts'),
    'integration': ('gateway', BACKEND + '/services/personal-aios-integration',
                    NODE_TEST + " --test-skip-pattern='" + CARE_NATIVE + "' tests/!(" + '|'.join(NATIVE_INTEGRATION) + ').test.ts'),
    'platform-data': ('gateway', BACKEND + '/services/platform-data',
                      'node --test --test-concurrency=1 --test-reporter=spec --experimental-strip-types tests/!(*integration).test.ts'),
    'native-gateway': ('hermes', BACKEND + '/phase0/gateway', NODE_TEST + ' ' + ' '.join('tests/' + name + '.test.ts' for name in NATIVE_GATEWAY)),
    'native-integration': ('hermes', BACKEND + '/services/personal-aios-integration',
                           'status=0; ' + NODE_TEST + ' ' + ' '.join('tests/' + name + '.test.ts' for name in NATIVE_INTEGRATION)
                           + ' || status=$?; ' + NODE_TEST + " --test-name-pattern='" + CARE_NATIVE
                           + "' tests/server.test.ts || status=$?; exit \"$status\""),
    'hermes': ('hermes', '/opt/paios', 'PYTHONPATH=/opt/release-pytest:/opt/hermes /opt/hermes/.venv/bin/python -m pytest -q -p no:cacheprovider tests/hermes/'),
    'executor': ('hermes', '/opt/paios/integrations/connectors/phone_executor', '/opt/paios-phone/bin/python -m unittest discover -p "test_*.py"'),
}
FAILURE_NAMES = [re.compile(p, re.M) for p in (r'^\s*✖ (.+?) \(\d[\d.]*m?s\)$', r'^(?:FAILED|ERROR) (\S+)', r'^(?:FAIL|ERROR): (\S+ \(\S+\))')]


def now():
    return datetime.now(timezone.utc).isoformat()


def clean_env(extra=()):
    return {**{k: v for k, v in os.environ.items() if not k.startswith('PAIOS_')}, **dict(extra)}


def write(path, value):
    atomic_write(path, json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def image_id(ref):
    return subprocess.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', ref], check=True, capture_output=True, text=True).stdout.strip()


def guarded(command, cwd, env, log, guard_bytes):
    """Run one build step; stop it if free disk falls under the guard. Returns the minimum free bytes seen."""
    minimum = shutil.disk_usage('/').free
    with log.open('w') as stream:
        # Build inputs keep the modes the images have always had, whatever the operator's umask.
        process = subprocess.Popen(command, cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT,
                                   start_new_session=True, preexec_fn=lambda: os.umask(0o022))
        def stop_group(sig):
            try:
                os.killpg(process.pid, sig)
            except ProcessLookupError:
                pass  # The owned group already exited.
        try:
            while process.poll() is None:
                minimum = min(minimum, shutil.disk_usage('/').free)
                if minimum < guard_bytes:
                    raise RuntimeError('DISK_GUARD')
                time.sleep(.5)
            if process.returncode:
                raise RuntimeError('BUILD_STEP_FAILED: ' + log.name)
        except BaseException:
            try:
                stop_group(signal.SIGINT)
                try:
                    process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    stop_group(signal.SIGTERM)
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass  # SIGKILL below completes the bounded graceful-stop escalation.
            finally:
                # The shell may exit before a signal-resistant descendant; retire the entire owned group.
                stop_group(signal.SIGKILL)
                process.wait()
            raise
    return minimum


def build(config, release):
    release = Path(release)
    state = release / '.release'
    source = release_source.verify(config['repo'], release)
    if shutil.disk_usage('/').free < config.get('build_min_free_bytes', 12_000_000_000):
        raise RuntimeError('BUILD_DISK_PRECHECK')
    tag = 'r-' + source['commit'][:8]
    tags = {role: f'paios-{role}:{tag}' for role in ROLES}
    env = clean_env({**config['build_public_env'], 'DOCKER_BUILDKIT': '1', 'BUILDKIT_PROGRESS': 'plain',
                     'PAIOS_BUILD_MAINLAND_MIRRORS': str(config.get('build_mirrors', '0')),
                     'PAIOS_HERMES_NATIVE_ROOT': config['native_root'],
                     **({'HERMES_SOURCE': config['hermes_source']} if config.get('hermes_source') else {}),
                     **{f'PAIOS_{role.upper()}_IMAGE': tags[role] for role in ROLES if role != 'watchdog'}})
    cloud = release / 'deploy/cloud'
    result = {'schema': 'paios.release-build.v1', 'commit': source['commit'], 'started_at': now(), 'tags': tags}
    guard = config.get('disk_guard_bytes', 4_000_000_000)
    result['minimum_free_bytes'] = min(
        guarded(['./build.sh'], cloud, env, state / 'build-sh.log', guard),
        guarded(['docker', 'build', '-f', 'Dockerfile.watchdog', '-t', tags['watchdog'], '../..'], cloud, env, state / 'build-watchdog.log', guard))
    result['native_source'] = os.path.realpath(cloud / '.build/hermes')
    result['images'] = {role: {'tag': tags[role], 'id': image_id(tags[role])} for role in ROLES}
    result['hermes_base'] = image_id('paios-hermes-base:locked')
    result['finished_at'] = now()
    write(state / 'build.json', result)
    return result


def failure_names(text):
    return sorted({match for pattern in FAILURE_NAMES for match in pattern.findall(text)})


def pytest_cache(image, release):
    """Cache native pytest/vision and the candidate's AST compiler; suites run without a network."""
    package = Path(release) / BACKEND.removeprefix('/opt/paios/') / 'phase0/gateway/package.json'
    typescript = json.loads(package.read_text())['devDependencies']['typescript']
    volume = 'paios-release-pytest-' + image.removeprefix('sha256:')[:12] + '-vision-v1-ts-' + typescript
    if subprocess.run(['docker', 'volume', 'inspect', volume], capture_output=True).returncode:
        subprocess.run(['docker', 'volume', 'create', volume], check=True, capture_output=True)
        try:
            subprocess.run(['docker', 'run', '--rm', '--user', '0:0', '-v', volume + ':/target', '-e', 'PAIOS_TEST_TYPESCRIPT=' + typescript, '--entrypoint', 'sh', image, '-ec',
                            'uv pip install --python /opt/hermes/.venv/bin/python --target /target pytest==9.1.1 pytest-asyncio==1.3.0 '
                            'numpy==2.2.6 opencv-python-headless==4.12.0.88 && '
                            'npm install --prefix /target --ignore-scripts --no-audit --no-fund "typescript@$PAIOS_TEST_TYPESCRIPT"'],
                           check=True, capture_output=True)
        except subprocess.CalledProcessError:
            subprocess.run(['docker', 'volume', 'rm', volume], check=True, capture_output=True)
            raise
    return volume


@contextmanager
def suite_backend(image):
    """Hermes cross-runtime tests use the shipped gateway source and its native Node dependencies."""
    volume = subprocess.run(['docker', 'volume', 'create'], check=True, capture_output=True, text=True).stdout.strip()
    try:
        subprocess.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', '0:0',
                        '-v', volume + ':/target', '--entrypoint', 'sh', image, '-ec',
                        'cp -a ' + BACKEND + ' /target/backend'], check=True, capture_output=True)
        yield volume
    finally:
        subprocess.run(['docker', 'volume', 'rm', volume], check=True, capture_output=True)


def suites(config, release, baseline=None, *, model_source):
    """Run every Linux core suite in its candidate image; any failure name absent from the baseline fails the gate."""
    release = Path(release)
    images = json.loads((release / '.release/build.json').read_text())['images']
    previous = json.loads(Path(baseline).read_text())['suites'] if baseline else {}
    result = {'schema': 'paios.release-suites.v1', 'images': {k: images[k]['id'] for k in ('gateway', 'hermes')},
              'baseline': str(baseline) if baseline else None, 'started_at': now(), 'suites': {}}
    pytest_volume = pytest_cache(images['hermes']['id'], release)
    for name, (role, workdir, command) in SUITES.items():
        mounts = [arg for path in SUITE_FIXTURES for arg in ('-v', f'{release}/{path}:/opt/paios/{path}:ro')]
        mounts += ['-v', f'{config["repo"]}:/opt/paios/.git:ro', '-v', model_source + ':/opt/models:ro']
        fixture_env = ['-e', 'GIT_CONFIG_COUNT=1', '-e', 'GIT_CONFIG_KEY_0=safe.directory',
                       '-e', 'GIT_CONFIG_VALUE_0=/opt/paios', '-e', 'PAIOS_MODEL_ROOT=/opt/models']
        if name == 'gateway':
            mounts += ['--mount', f'type=volume,src={pytest_volume},dst={workdir}/node_modules/typescript,'
                       'volume-subpath=node_modules/typescript,readonly']
        if role == 'hermes':
            mounts += ['-v', pytest_volume + ':/opt/release-pytest:ro']
        if role == 'hermes':
            fixture_env += [arg for key, value in {
                'PAIOS_NATIVE_SOURCE_TEST_ROOT': '/opt/hermes', 'PAIOS_HERMES_PYTHON': '/opt/hermes/.venv/bin/python',
                'PAIOS_HERMES_REBUILD_DIR': '/opt/hermes', 'PAIOS_NATIVE_TEST_PYTHON': '/opt/hermes/.venv/bin/python',
                'HERMES_NATIVE_SOURCE': '/opt/hermes', 'HERMES_SOURCE': '/opt/hermes',
            }.items() for arg in ('-e', key + '=' + value)]
        if name == 'integration':
            fixture_env += ['-e', 'PAIOS_DEMUX_TOOLCHAIN=/usr/bin']
        if name == 'executor':
            fixture_env += ['-e', 'PAIOS_TEST_CJK_FONT=/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc']
        started = time.time()
        with suite_backend(images['gateway']['id']) if role == 'hermes' else nullcontext(None) as backend:
            if backend:
                mounts += ['--mount', f'type=volume,src={backend},dst={BACKEND},volume-subpath=backend,readonly']
            run = subprocess.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', '10000:10000',
                                  '--memory', config.get('suite_memory', '2g'), '--cpus', str(config.get('suite_cpus', 2)),
                                  '--tmpfs', '/tmp:size=1g,exec',
                                  '--tmpfs', '/opt/paios/.scratch:size=256m,uid=10000,gid=10000,mode=0700,exec',
                                  '-e', 'HOME=/tmp', '-e', 'TMPDIR=/tmp', '-e', 'PYTHONDONTWRITEBYTECODE=1',
                                  *fixture_env, *mounts, '-w', workdir, '--entrypoint', 'bash', images[role]['id'], '-O', 'extglob', '-c', command],
                                 capture_output=True, text=True)
        log = run.stdout + run.stderr
        (release / f'.release/suite-{name}.log').write_text(log)
        failures = failure_names(log)
        known = set(previous.get(name, {}).get('failures', []))
        origin = {'native-gateway': 'gateway', 'native-integration': 'integration'}.get(name)
        if origin:
            known.update(previous.get(origin, {}).get('failures', []))
        result['suites'][name] = {'exit': run.returncode, 'seconds': round(time.time() - started, 1), 'failures': failures,
                                  'new_failures': sorted(set(failures) - known),
                                  # A nonzero exit without a parsed name is still a failure, never a pass.
                                  'unexplained_failure': bool(run.returncode and not failures)}
    result['passed'] = not any(s['new_failures'] or s['unexplained_failure'] for s in result['suites'].values())
    result['finished_at'] = now()
    write(release / '.release/suites.json', result)
    return result


def newest_snapshot(settings):
    found = [p for key in ('incoming', 'accepted') for p in Path(settings[key]).glob('snapshot-*.age') if not p.is_symlink()]
    if not found:
        raise ValueError('NO_STAGING_SNAPSHOT')
    return max(found, key=lambda p: p.name)


def accept(release, staging_receipt):
    """The single promotion record: one commit, one image set, every gate on that same set."""
    state = Path(release) / '.release'
    build_result = json.loads((state / 'build.json').read_text())
    suite_result = json.loads((state / 'suites.json').read_text())
    images = {role: image['id'] for role, image in build_result['images'].items()}
    staged = staging_receipt['candidate_images']
    if not suite_result['passed'] or not staging_receipt.get('regression_passed'):
        raise ValueError('GATE_FAILED')
    if any(staged[role] != images[role] for role in ('gateway', 'hermes', 'workshop')) or suite_result['images'] != {
            k: images[k] for k in ('gateway', 'hermes')}:
        raise ValueError('CANDIDATE_DRIFT: staged or tested images differ from the build')
    accepted = {'schema': 'paios.release-accepted.v1', 'commit': build_result['commit'], 'images': images,
                'staged_images': staged, 'snapshot': staging_receipt['snapshot'],
                'raw_media_verified': staging_receipt.get('window_hours') == 48, 'accepted_at': now()}
    write(state / 'accepted.json', accepted)
    return accepted
