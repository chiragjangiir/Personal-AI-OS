"""Workshop package sandbox and credential/TLS startup authority."""
import json
import hmac
import os
from pathlib import Path
import shlex
import ssl
import uuid

class BuilderRefusal(ValueError):
    """A bounded public validation or native Hub refusal, without a traceback."""


def authorized(headers, token):
    return hmac.compare_digest(headers.get('Authorization', ''), 'Bearer ' + token)


def test_tool(files):
    from gateway.run_scope import runtime_scope
    from tools.terminal_tool import ensure_task_env, _evict_environment_for_task
    if (not isinstance(files, dict) or not files
            or any(not isinstance(k, str) or not isinstance(v, str) for k, v in files.items())
            or 'scripts/test.py' not in files):
        raise BuilderRefusal('Invalid test package')
    for name in files:
        path = Path(name)
        if path.is_absolute() or '..' in path.parts or not path.parts:
            raise BuilderRefusal('Invalid package path')
    script = ('import json,pathlib,tempfile,subprocess,sys,shutil\n'
              'root=pathlib.Path(tempfile.mkdtemp(prefix="tool-test-",dir="/workshop"))\n'
              'try:\n'
              ' for name,content in json.load(sys.stdin).items():\n'
              '  path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(content)\n'
              ' result=subprocess.run([sys.executable,"scripts/test.py"],cwd=root,timeout=40)\n'
              ' sys.exit(result.returncode)\n'
              'finally: shutil.rmtree(root)\n')
    task = 'verify-' + uuid.uuid4().hex
    with runtime_scope('build'):
        try:
            environment = ensure_task_env(task)
            if environment is None:
                raise RuntimeError('Test sandbox is unavailable')
            result = environment.execute('python3 -c ' + shlex.quote(script),
                timeout=50, stdin_data=json.dumps(files), bounded_capture=True)
        finally:
            _evict_environment_for_task(task)
    return {'success': result.get('returncode') == 0 and not result.get('error'), 'result': result}


def check_capability(files):
    """Validate portably on the builder, then obtain kernel evidence on the data-free worker."""
    import tempfile
    from hermes_cli.plugin_validate import validate_plugin_dir
    from gateway.run_scope import runtime_scope
    from tools.terminal_tool import ensure_task_env, _evict_environment_for_task
    if not isinstance(files, dict) or not files or len(files) > 32:
        raise BuilderRefusal('Invalid capability package')
    for name, content in files.items():
        if (not isinstance(name, str) or not isinstance(content, str) or Path(name).is_absolute()
                or any(part in ('..', '.', '') for part in name.split('/'))
                or name in {'plugin.yaml', 'plugin.yml', '__init__.py', 'hooks.json'} or name.startswith('hooks/')):
            raise BuilderRefusal('Only portable package files are accepted')
    sizes = [len(content.encode()) for content in files.values()]
    if max(sizes) > 131072 or sum(sizes) > 524288:
        raise BuilderRefusal('Capability package budget exceeded')
    with tempfile.TemporaryDirectory(prefix='capability-manifest-') as directory:
        for name, content in files.items():
            path = Path(directory) / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        if not validate_plugin_dir(Path(directory)).ok:
            raise BuilderRefusal('Hermes plugin validation failed')
    task = 'register-' + uuid.uuid4().hex
    with runtime_scope('build'):
        try:
            result = ensure_task_env(task).execute('python3 /opt/yimi/registration/runner.py --files',
                timeout=300, stdin_data=json.dumps(files), bounded_capture=True)
        finally:
            _evict_environment_for_task(task)
    if result.get('returncode') or result.get('error'):
        raise BuilderRefusal('Registration sandbox failed')
    return json.loads(result['output'])


def invoke_capability(request):
    """Use the registration worker's kernel boundary for every installed-package call."""
    from gateway.run_scope import runtime_scope
    from tools.terminal_tool import ensure_task_env, _evict_environment_for_task
    if not isinstance(request, dict) or set(request) != {'files', 'call'}:
        raise BuilderRefusal('Invalid capability invocation')
    files = request['files']
    if not isinstance(files, dict) or not files or len(files) > 32 or sum(len(v.encode()) for v in files.values()) > 524288:
        raise BuilderRefusal('Capability package budget exceeded')
    if request['call'].get('method') not in ('tools/list', 'tools/call'):
        raise BuilderRefusal('Invalid capability method')
    task = 'capability-' + uuid.uuid4().hex
    with runtime_scope('build'):
        try:
            result = ensure_task_env(task).execute('python3 /opt/yimi/registration/runner.py --invoke-files',
                timeout=120, stdin_data=json.dumps(request), bounded_capture=True)
        finally:
            _evict_environment_for_task(task)
    if result.get('returncode') or result.get('error'):
        raise BuilderRefusal('Capability execution sandbox failed')
    return json.loads(result['output'])



def prepare_server():
    import importlib.util
    spec = importlib.util.spec_from_file_location('builder_config', '/opt/paios/workshop-builder-init.py')
    config = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(config)
    config.prepare_builder_home(Path(os.environ['HERMES_HOME']))
    os.environ['HOME'] = os.environ['HERMES_HOME']
    if os.geteuid() == 0:
        os.setgid(10000)
        os.setuid(10000)
    secrets = Path(os.environ['PAIOS_SECRET_ROOT'])
    if __package__:
        from .model_transport import initialize_credentials
    else:
        from model_transport import initialize_credentials
    initialize_credentials(Path(os.environ['HERMES_HOME']))
    token = (secrets / 'workshop-builder.key').read_text().strip()
    if not token:
        raise BuilderRefusal('Builder credentials must be provisioned')
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(os.environ.get('PAIOS_BUILDER_TLS_CERT_FILE', secrets / 'workshop-builder.crt'),
                        os.environ.get('PAIOS_BUILDER_TLS_KEY_FILE', secrets / 'workshop-builder.tls.key'))
    return token, tls
