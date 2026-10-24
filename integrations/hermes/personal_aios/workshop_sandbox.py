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
    os.environ['PAIOS_BUILDER_API_KEY'] = (secrets / 'opencode.key').read_text().strip()
    token = (secrets / 'workshop-builder.key').read_text().strip()
    if not token or not os.environ['PAIOS_BUILDER_API_KEY']:
        raise BuilderRefusal('Builder credentials must be provisioned')
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(os.environ.get('PAIOS_BUILDER_TLS_CERT_FILE', secrets / 'workshop-builder.crt'),
                        os.environ.get('PAIOS_BUILDER_TLS_KEY_FILE', secrets / 'workshop-builder.tls.key'))
    return token, tls
