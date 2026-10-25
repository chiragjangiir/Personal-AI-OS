"""Data-free TLS entry point into Hermes' native build loop."""
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import tempfile
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timezone

if __name__ == '__main__' and not __package__:
    import runpy
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    runpy.run_module('integrations.hermes.personal_aios.workshop_builder', run_name='__main__')
    raise SystemExit


if __package__:
    from .workshop_sandbox import BuilderRefusal, test_tool, check_capability, invoke_capability, prepare_server, authorized
else:
    from workshop_sandbox import BuilderRefusal, test_tool, check_capability, invoke_capability, prepare_server, authorized


def _admit_build():
    if __package__:
        from .model_task_admission import require_new_task
    else:
        from model_task_admission import require_new_task
    require_new_task('build')


def build_tool(request):
    _admit_build()
    capability = request.pop('_capability', False) if isinstance(request, dict) else False
    if (not isinstance(request, dict) or set(request) not in ({'input', 'name'}, {'input', 'name', 'files'}) or not isinstance(request['input'], str)
            or not 1 <= len(request['input']) <= 16000
            or not isinstance(request['name'], str)
            or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', request['name'])):
        raise BuilderRefusal('Expected a tool name and a data-free owner request')
    from gateway.run_scope import runtime_scope
    from hermes_cli.config import load_config, resolve_turn_limit
    from run_agent import AIAgent
    from tools.registry import registry
    from tools.skill_manager_batch import _BATCH_MAX_OPS
    from hermes_constants import get_hermes_home
    if __package__:
        from .workshop import register
    else:
        from workshop import register

    class Tools:
        def register_tool(self, name, toolset, schema, handler):
            if name == 'skills_hub':
                schema['parameters']['properties']['action']['enum'] = ['find', 'search', 'inspect', 'install']
                if capability:
                    schema['parameters']['properties']['action']['enum'] += ['package_write', 'package_read']
                    schema['parameters']['properties']['files'] = {'type': 'object', 'additionalProperties': {'type': 'string'}}
                    schema['description'] = ('Find and inspect reusable tools. package_write updates the supplied '
                        'package-relative files in your isolated draft, preserving other files. package_read '
                        'returns the draft. Use terminal for isolated regression tests from /package; outputs go to /work.')
                    original = handler
                    def handler(args, **kwargs):
                        if args['action'] in {'package_write', 'package_read'}:
                            from .workshop_capability import draft_files
                            return json.dumps(draft_files(request['name'], args.get('files') if args['action'] == 'package_write' else None))
                        return original(args, **kwargs)
            registry.register(name=name, toolset=toolset, schema=schema, handler=handler)

    run_id = uuid.uuid4().hex
    with runtime_scope('build'):
        register(Tools())
        if request.get('files') and capability:
            from .workshop_capability import draft_files
            draft_files(request['name'], request['files'])
        elif request.get('files'):
            if __package__:
                from .tool_lifecycle import ToolLifecycle, _apply, _operations, _files
            else:
                from tool_lifecycle import ToolLifecycle, _apply, _operations, _files
            previous = _files(ToolLifecycle(None)._skill(request['name']))
            _apply({'operations': _operations(request['name'], request['files'], previous)})
        config = load_config()
        model = config['model']
        native = config['agent']
        handbook = (Path(__file__).parent / 'shared-skills/engineering-handbook/SKILL.md').read_text()
        instructions = handbook
        instructions += (
            '\nYou are the isolated builder. Find reusable tools first in skills_hub, MCP registries, '
            'GitHub, npm and PyPI using terminal HTTP requests. Record candidates and why you reused '
            'or rejected them. Desktop app operations use the existing desktop/DesktopKit source; '
            'do not make per-app routes or access an owner device here. '
            f'Build or repair the reusable skill workshop/{request["name"]} with skill_manage. '
            'Declare adapter_modules in SKILL.md YAML frontmatter: all package-relative external conversion '
            'module paths, or [] for pure business code. Test rejects missing declarations and modules over '
            '200 physical lines. Count related conversion code together; never split, rename or compress '
            'code to evade the limit. Use observed fixtures or official interface contracts; reject unknown '
            'formats and missing fields rather than guessing aliases or falling through JSON/HTML/text. '
            'Include scripts/test.py: a regression test with synthetic inputs and real assertions. '
            'Run that test in the workshop before returning. Preserve scripts needed to use the tool. '
            'Runtime files must live in the exported package and use package-relative paths. '
            'The owner workshop is offline; do not depend on a build-only install or public download there. '
            'Additional image dependencies touch the sandbox baseline and require owner confirmation. '
            'Only reusable code and instructions may be exported here. For product code changes use the same '
            'repair and release flow; protected baselines ask the owner. Do not use external coding CLIs; use your own model loop.'
            'Package budgets are 131072 UTF-8 bytes per file, 32 files, and 524288 total UTF-8 bytes. '
            'When any budget is exceeded, save a specific written budget_reason in SKILL.md YAML frontmatter. '
            'Up to twice every budget, that reason permits continuing and is recorded with the release. '
            'Beyond twice any budget, export a candidate with the reason for the main agent to request '
            'the owner\'s one-time approval; do not claim it is approved or published. '
            f'The publication budget is {_BATCH_MAX_OPS} operations, counting SKILL.md, supporting files and '
            'removed files, under the same reason/approval policy. Ordinary skill_manage calls still take at '
            f'most {_BATCH_MAX_OPS} operations; use further calls to prepare a larger package in this isolated '
            'workspace. The release lifecycle publishes the complete approved package in one native atomic '
            'batch with the same locks, snapshots and rollback; never split a publication.'
        )
        if capability:
            template = Path(os.environ.get('PAIOS_APP_ROOT', Path(__file__).parents[3])) / 'capability/templates/yimi-capability-template'
            instructions = handbook + ('\nYou are the isolated builder. Find reusable tools first in skills_hub, '
                'MCP registries, GitHub, npm and PyPI. Record candidates and why you reused or rejected them. '
                'The product is a standard Agent Plugins v1 capability PACKAGE. '
                'Use capability_find before building (skills_hub action=find on the legacy build profile). '
                'Build the smallest useful interface; do not add independent operations that were not requested. '
                'Keep a short business regression script and a few representative contract cases. '
                'The platform already validates manifests, receipts, security and effects after export; '
                'do not reimplement those validators or repeat meta-checks in this build. '
                'Each contract case is independent: its fixture bytes need not match another case. '
                'Once your business regression passes and package files are saved, finish and return the candidate. '
                'Write package files with skills_hub(action="package_write", value="draft", files={...}); '
                'later calls update supplied files and preserve the rest. '
                'read it with action="package_read". This editor owns only this isolated package draft. '
                'Native skill_manage restricts supporting paths and cannot write standard package roots. '
                'The root SKILL.md is scratch metadata supplied by the editor. '
                'In the exported directory save plugin.json, mcp.json, '
                'skills/<name>/SKILL.md, server/, fake/, scripts/test.py and tests/contract.yaml. '
                'Copy the template shapes below, then implement the requested behavior. Import the shared SDK '
                'from capability.sdk.python.yimi_receipt (available at /opt/yimi); never copy its code. '
                'Set maintainer=yimi and a new semver; declare every tool effect and all egress. '
                'Manifest scopes describe the callers, not the build environment: include owner for an '
                'owner-requested capability; never add guest or care without that requirement. Never declare '
                'spend or self_change, including argument branches. Tests run offline in a credential-free '
                'namespace with the package read-only at /package and writable outputs under /work. '
                'Budgets: 32 files, 131072 UTF-8 bytes per file and 524288 total. Reduce scope on overruns. '
                'No dependency downloads during use. The real and fake server must speak MCP JSON lines. '
                'The MCP entry is a protocol adapter: declare it in provenance.adapter_modules and keep that '
                'entire file under 200 lines. Put the actual business operations in a separate module. '
                'return receipt v1. Contract YAML version=1 has cases [{tool,args,files,expect}]. '
                'files keys are RELATIVE paths: {"sample.pdf":{"base64":"..."}} stages /work/sample.pdf; '
                'never use /work/sample.pdf as the files key. Tool args may use absolute /work paths. '
                'Every case supplies its own inputs; no runtime sample files are implicit during registration. '
                'expect maps dotted receipt paths to exact expected values. '
                'Registration checks are automatic and blocking. Passing packages ship directly through '
                'test/promote, without staging or a new confirmation. External effects remain under gateway decide.\n')
            for path in sorted(template.rglob('*')):
                if path.is_file():
                    instructions += '\nTEMPLATE ' + path.relative_to(template).as_posix() + '\n' + path.read_text()
        from gateway.run import _resolve_runtime_agent_kwargs
        from hermes_cli.fallback_config import get_fallback_chain
        runtime = _resolve_runtime_agent_kwargs()
        selected_model = runtime.pop('model', model['default'])
        runtime.pop('_fallback_notice', None)
        agent = AIAgent(model=selected_model, **runtime, fallback_model=get_fallback_chain(config),
            enabled_toolsets=['terminal', 'skills_hub', 'todo'] if capability else ['skills', 'terminal', 'file', 'code_execution', 'skills_hub', 'todo'],
            # Same rule as native cron: no turn limit unless configured; the shared max_tool_calls cap bounds the run.
            max_iterations=resolve_turn_limit(native.get('max_turns')),
            session_id=run_id, skip_context_files=True, load_soul_identity=False,
            skip_memory=True, skip_background_review=True, quiet_mode=True,
            save_trajectories=False, ephemeral_system_prompt=instructions)
        try:
            result = agent.run_conversation(request['input'])
        finally:
            agent.close()
        if result.get('failed') or not result.get('completed'):
            raise RuntimeError('Builder did not complete: ' + str(result.get('error') or result.get('turn_exit_reason') or 'no completed result'))
        root = get_hermes_home() / 'skills/workshop' / request['name']
        if capability:
            from tools.skill_manager_tool import _find_skill
            skill = _find_skill(request['name'])
            if skill is None:
                raise BuilderRefusal('Builder did not save the package scratch skill')
            root = Path(skill['path'])
        candidate = export_tool(request['name'], root,
                                request.get('files', {}), capability=capability)
        if 'scripts/test.py' not in candidate['files']:
            raise BuilderRefusal('Builder must save its regression test')
        return {**candidate, 'run_id': run_id, 'output': result['final_response']}


def build_capability(request):
    return build_tool({**request, '_capability': True})


def export_tool(name, root, previous=(), capability=False):
    if __package__:
        from .tool_lifecycle import package_budget
    else:
        from tool_lifecycle import package_budget
    files = {}
    for path in root.rglob('*'):
        if path.is_symlink():
            raise BuilderRefusal('Tool exports cannot contain symlinks')
        if path.is_file():
            relative = path.relative_to(root).as_posix()
            if '__pycache__' in path.parts:
                continue
            files[relative] = path.read_text()
    if 'SKILL.md' not in files:
        raise BuilderRefusal('Hub or builder must save a native skill')
    if capability:
        if 'plugin.json' not in files or 'tests/contract.yaml' not in files or 'mcp.json' not in files:
            raise BuilderRefusal('Builder must export a standard capability package')
        manifest = json.loads(files['plugin.json'])
        if manifest['name'] != name or manifest['extensions']['ai.yimi.capability']['maintainer'] != 'yimi':
            raise BuilderRefusal('Builder package identity mismatch')
    return {'name': name, 'files': files, 'budget': package_budget(files, previous)}


REPAIR_PATHS = ('01-product-half-finished/backend', 'integrations', 'scripts', 'tests', 'deploy', '.dockerignore', '.gitignore',
                '!01-product-half-finished/backend/upstream')


def repair_product(request):
    """Repair product source on the build host's accepted base; queue the patch for the host release runner."""
    _admit_build()
    if (not isinstance(request, dict) or set(request) != {'input', 'origin'} or not isinstance(request['input'], str)
            or not 1 <= len(request['input']) <= 16000):
        raise BuilderRefusal('Expected a data-free repair request with its admitted origin')
    origin = request['origin']
    if (not isinstance(origin, dict) or origin.get('kind') not in {'owner_request', 'system_selfcheck'}
            or any(not isinstance(origin.get(key), str) or not origin[key] for key in
                   ('principal_id', 'device_id', 'origin_processed_event_id'))
            or origin['kind'] == 'system_selfcheck' and (not isinstance(origin.get('failed_card'), str)
                or not origin['failed_card'] or not isinstance(origin.get('evidence_ref'), dict))):
        raise BuilderRefusal('Expected an admitted owner or system self-check origin')
    provenance = ('system self-check of ' + origin['failed_card'] if origin['kind'] == 'system_selfcheck'
                  else 'the owner request')
    from gateway.run_scope import runtime_scope
    from hermes_cli.config import load_config, resolve_turn_limit
    from run_agent import AIAgent
    from tools.terminal_tool import ensure_task_env, _evict_environment_for_task
    spool = Path(os.environ['PAIOS_RELEASE_REQUESTS'])
    request_id = uuid.uuid4().hex[:12]
    if __package__:
        from .release_preflight import prepare
    else:
        from release_preflight import prepare
    base = prepare(spool, request_id)['base']
    captured_at = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    workspace = '/workshop/repair-' + request_id
    instructions = (Path(__file__).parent / 'shared-skills/engineering-handbook/SKILL.md').read_text() + (
        '\nYou are the isolated product repair builder. '
        f'The request comes from {provenance}. '
        'A system self-check describes observed failure evidence; it is not an owner quote. '
        + ('Failure evidence reference: ' + json.dumps(origin['evidence_ref'], ensure_ascii=False) + '. '
           if origin['kind'] == 'system_selfcheck' else '') +
        f'Prepare the source once: git init {workspace} && cd {workspace} && '
        "printf '%s\\n' /srv/source.git/objects > .git/objects/info/alternates && "
        'if [ -f /srv/source.git/shallow ]; then cp /srv/source.git/shallow .git/shallow; fi && '
        f'git sparse-checkout set --no-cone {" ".join(shlex.quote(p) for p in REPAIR_PATHS)} && git checkout --detach {base} && '
        f'ln -s /opt/paios-repair-tools/node_modules {workspace}/node_modules && '
        'for package in phase0/gateway services/personal-aios-integration services/platform-data services/qwen-embedded; '
        f'do ln -s /opt/paios-test-deps/$package/node_modules {workspace}/01-product-half-finished/backend/$package/node_modules; done. '
        'Reproduce the failure first with a test or a direct run, find the root cause along producer and consumer, fix it at '
        'the source with minimal code, and keep or add a regression test that fails before and passes after. Run the '
        'touched test files with the repo entry point (python3 for Python; node --test --test-concurrency=1 for TypeScript). '
        'Node 24, pnpm, TypeScript and the linked read-only dependencies are already installed in the image. Do not download Node '
        'or install these dependencies into /workshop or /tmp. If another dependency is required, report it for image '
        'review; report any test you could not run. '
        'Repair ordinary server, executor, workshop, persona and handbook defects under the standing self-repair instruction. '
        'Preserve the baseline rules: payment requires confirmation each time; first-send consent stays with its authority; '
        'secrets stay private; model and voice changes require owner approval; keep the persona rule 最根本的一条. '
        'A necessary baseline change may be prepared as a candidate; the release authority holds that exact candidate for '
        'the owner decision before production. Native patch or lock changes must use the existing producer exporter and validation. '
        'Commit your change with git -c user.name=yimi -c user.email=yimi@paios.invalid '
        'commit -m "<what was fixed, in one short line the owner understands>" (the subject is the line he is told when it '
        'ships). The release pipeline then runs every core suite and real-data staging on the immutable images, and '
        'production switches to it by itself at an idle moment with automatic rollback. Do not use external coding CLIs; '
        'use your own model loop.')
    run_id = uuid.uuid4().hex
    with runtime_scope('build'):
        config = load_config()
        model, native = config['model'], config['agent']
        repair = config['workshop']['repair']
        from gateway.run import _runtime_agent_kwargs
        from hermes_cli.runtime_provider import resolve_runtime_with_fallback
        from hermes_cli.fallback_config import get_fallback_chain, scoped_fallback_chain, resolve_entry_api_key
        chain = scoped_fallback_chain(get_fallback_chain(config), repair['fallback_providers'], pinned=True, owner='build.repair')
        selected = {**config, 'model': {**repair, 'default': repair['model']}, 'fallback_providers': chain or []}
        resolved, fallback = resolve_runtime_with_fallback(selected, requested=repair['provider'],
            target_model=repair['model'], explicit_base_url=repair['base_url'], explicit_api_key=resolve_entry_api_key(repair))
        runtime = _runtime_agent_kwargs(resolved)
        agent = AIAgent(model=fallback['model'] if fallback else repair['model'], **runtime, fallback_model=chain,
            enabled_toolsets=['terminal', 'file', 'code_execution', 'todo'],
            max_iterations=resolve_turn_limit(native.get('max_turns')),
            session_id=run_id, skip_context_files=True, load_soul_identity=False,
            skip_memory=True, skip_background_review=True, quiet_mode=True,
            save_trajectories=False, ephemeral_system_prompt=instructions)
        try:
            try:
                result = agent.run_conversation(request['input'])
            finally:
                agent.close()
            if result.get('failed') or not result.get('completed'):
                raise RuntimeError('Repair did not complete: ' + str(result.get('error', 'tool-call budget exhausted')))
            task = 'repair-export-' + request_id
            try:
                environment = ensure_task_env(task)
                git = f'git -c safe.directory={workspace} -C {workspace} '
                exported = environment.execute(
                    git + f'merge-base --is-ancestor {base} HEAD && ' + git + f'format-patch --binary --stdout {base}..HEAD',
                    timeout=60, bounded_capture=False)
            finally:
                _evict_environment_for_task(task)
        finally:
            task = 'repair-cleanup-' + request_id
            try:
                cleanup = ensure_task_env(task).execute('rm -rf -- ' + shlex.quote(workspace), timeout=30)
                if cleanup['returncode'] != 0:
                    raise RuntimeError('Repair workspace cleanup failed')
            finally:
                _evict_environment_for_task(task)
    patch = exported.get('output', '')
    if exported.get('returncode') != 0 or not patch.startswith('From '):
        raise BuilderRefusal('Repair produced no committed change on its base')
    if len(patch.encode()) > 1048576:
        raise BuilderRefusal('Repair patch exceeds the 1 MiB request budget')
    # Written aside and renamed: the host path unit sees one complete request directory appear.
    partial = spool / ('.' + request_id)
    partial.mkdir(mode=0o750)
    (partial / 'candidate.patch').write_text(patch)
    (partial / 'request.json').write_text(json.dumps({'schema': 'paios.release-request.v1', 'request_id': request_id,
                                                      'base': base, 'run_id': run_id, 'origin': origin,
                                                      'captured_at': captured_at}) + '\n')
    partial.rename(spool / request_id)
    return {'request_id': request_id, 'base': base, 'output': result['final_response'],
            'files': sorted({line[6:] for line in patch.splitlines() if line.startswith('+++ b/')})}


def release_status(request):
    if not isinstance(request, dict) or set(request) != {'request_id'} or not re.fullmatch(r'[0-9a-f]{12}', str(request['request_id'])):
        raise BuilderRefusal('Expected a repair request id')
    queued = Path(os.environ['PAIOS_RELEASE_REQUESTS']) / request['request_id']
    if not (queued / 'request.json').exists():
        raise BuilderRefusal('Unknown repair request')
    result = queued / 'result.json'
    return json.loads(result.read_text()) if result.exists() else {'request_id': request['request_id'], 'status': 'queued'}


def hub_request(request):
    if (not isinstance(request, dict) or set(request) != {'action', 'value'}
            or request['action'] not in {'search', 'inspect', 'install'}
            or not isinstance(request['value'], str) or not 1 <= len(request['value']) <= 16000):
        raise BuilderRefusal('Expected a hub action and query or identifier')
    if __package__:
        from .workshop import local_hub
    else:
        from workshop import local_hub
    if request['action'] != 'install':
        return local_hub(request['action'], request['value'])
    from gateway.run_scope import runtime_scope
    from hermes_constants import get_hermes_home, set_hermes_home_override, reset_hermes_home_override
    from tools.skills_hub import HubLockFile
    with runtime_scope('build'):
        home = get_hermes_home()
        with tempfile.TemporaryDirectory(prefix='hub-', dir=home) as directory:
            scratch = Path(directory)
            shutil.copyfile(home / 'config.yaml', scratch / 'config.yaml')
            token = set_hermes_home_override(scratch)
            try:
                output = local_hub('install', request['value'])
                installed = HubLockFile().list_installed()
                if len(installed) != 1:
                    raise BuilderRefusal('Hub did not install a scanned package: ' + output['output'])
                entry = installed[0]
                return {**export_tool(entry['name'], scratch / 'skills' / entry['install_path']), **output}
            finally:
                reset_hermes_home_override(token)


def builder_server(address, token, tls, read_timeout=30):
    gate = threading.BoundedSemaphore(1)

    class Server(ThreadingHTTPServer):
        def get_request(self):
            connection, address = super().get_request()
            connection.settimeout(read_timeout)
            return tls.wrap_socket(connection, server_side=True,
                                   do_handshake_on_connect=False), address

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def respond(self, status, output):
            body = json.dumps(output, ensure_ascii=False, separators=(',', ':')).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            activation = self.path == '/api/model-settings/activate'
            credential = Path(os.environ['PAIOS_MODEL_SETTINGS_TOKEN_FILE']).read_text().strip() if activation else token
            if self.path not in {'/build', '/capability-build', '/test', '/capability-check', '/capability-invoke', '/hub', '/repair', '/release-status', '/api/model-settings/activate'} or not authorized(self.headers, credential):
                self.send_error(403)
                return
            # Status reads a receipt only; it never waits behind a running build or repair.
            serial = self.path != '/release-status'
            if serial and not gate.acquire(blocking=False):
                self.respond(503, {'error': 'busy'})
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                limit = 4194304 if self.path in {'/capability-build', '/capability-check', '/capability-invoke'} else 1048576
                if size <= 0 or self.path not in {'/build', '/test'} and size > limit:
                    self.send_error(413)
                    return
                request = json.loads(self.rfile.read(size))
                def activate_models(body):
                    if __package__:
                        from .model_transport import activate
                    else:
                        from model_transport import activate
                    if any(item['group'] != 'build' for item in body['projections']):
                        raise ValueError('Builder requires its own build projection')
                    return activate(Path(os.environ['HERMES_HOME']), body['projections'])
                if __package__:
                    from .model_task_admission import remote_context
                else:
                    from model_task_admission import remote_context
                if self.path in {'/build', '/capability-build', '/repair'}:
                    with remote_context(request):
                        output = {'/build': build_tool, '/capability-build': build_capability, '/repair': repair_product}[self.path](request)
                else:
                    output = {'/api/model-settings/activate': activate_models, '/test': test_tool, '/hub': hub_request,
                              '/capability-check': check_capability,
                              '/capability-invoke': invoke_capability,
                              '/release-status': release_status}[self.path](request)
            except TimeoutError:
                self.respond(408, {'error': 'timeout'})
            except BuilderRefusal as error:
                self.respond(502, {'error': str(error)[:1024]})
            except (ValueError, RuntimeError, OSError) as error:
                self.respond(502, {'error': type(error).__name__})
            else:
                self.respond(200, output)
            finally:
                if serial:
                    gate.release()

    return Server(address, Handler)


def serve():
    token, tls = prepare_server()
    with builder_server((os.environ.get('PAIOS_BUILDER_BIND', '0.0.0.0'),
                         int(os.environ.get('PAIOS_BUILDER_PORT', '18664'))), token, tls) as server:
        server.serve_forever()


if __name__ == '__main__':
    serve()
