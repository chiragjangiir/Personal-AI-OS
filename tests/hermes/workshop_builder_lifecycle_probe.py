"""Run inside an isolated initialized builder profile: real SSH/cleanup/export, no model requests."""
import argparse
import inspect
import json
import os
from pathlib import Path
import re
import shlex
import sys
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--close-only', action='store_true', help='Isolate close/export from native per-turn cleanup')
    parser.add_argument('--test-command', help='Run the repository test entry point while the native kernel remains alive')
    parser.add_argument('--exercise-code', action='store_true', help='Exercise the same native remote Python kernel as repair tools')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root / 'integrations/hermes/personal_aios'))
    import workshop_builder as builder
    import run_agent
    import tools.terminal_tool as terminal
    from gateway.run_scope import runtime_scope

    events, workspaces = [], []
    original_agent, original_ensure = run_agent.AIAgent, terminal.ensure_task_env
    source_spool = Path(os.environ['PAIOS_RELEASE_REQUESTS'])
    original_spool = str(source_spool)
    proof = {'schema': 'paios.builder-lifecycle-probe.v1', 'scripted_conversation': True,
             'native_turn_cleanup': not args.close_only, 'events': events, 'passed': False}

    def event(phase, **fields):
        events.append({'phase': phase, 'at': time.time(), **fields})
        print(json.dumps(events[-1]), flush=True)

    class ObservedEnvironment:
        def __init__(self, environment, task):
            self.environment, self.task = environment, task

        def execute(self, command, **options):
            env = self.environment
            phase = ('cleanup' if command.startswith('rm -rf -- ') else
                     'export' if 'format-patch --binary --stdout' in command else 'prepare_commit')
            event(phase + '_started', task=self.task, scope=getattr(env, '_session_id', None))
            identity = env.execute('id -u', timeout=10, bounded_capture=True)
            if identity.get('returncode') != 0:
                raise RuntimeError('probe identity command failed')
            event(phase + '_identity', uid=int(identity['output'].strip()), task=self.task,
                  backend=type(env).__name__, source=inspect.getfile(type(env)),
                  persistent=bool(getattr(env, '_persistent', False)),
                  session_scoped=bool(getattr(env, '_session_scoped', False)))
            result = env.execute(command, **options)
            event(phase + '_finished', returncode=result.get('returncode'),
                  output=result.get('output', '')[-12000:])
            return result

    def ensure(task):
        event('ensure_started', task=task)
        environment = original_ensure(task)
        if environment is None:
            raise RuntimeError('probe SSH environment unavailable')
        event('ensure_finished', task=task, scope=getattr(environment, '_session_id', None))
        return ObservedEnvironment(environment, task)

    class ScriptedAgent(original_agent):
        def __init__(self, **options):
            self.probe_instructions = options['ephemeral_system_prompt']
            super().__init__(**options)

        def run_conversation(self, text, task_id=None, **options):
            task = task_id or self.session_id
            prepare = self.probe_instructions.split('Prepare the source once: ', 1)[1].split('. Reproduce the failure first', 1)[0]
            workspace = re.search(r'git init (\S+)', prepare).group(1)
            workspaces.append(workspace)
            target = workspace + '/01-product-half-finished/backend/services/personal-aios-integration/src/server.ts'
            command = (prepare + ' && printf "\\n// isolated lifecycle probe\\n" >> ' + shlex.quote(target)
                       + ' && git -C ' + shlex.quote(workspace) + ' add -- ' + shlex.quote(target)
                       + ' && git -C ' + shlex.quote(workspace)
                       + ' -c user.name=probe -c user.email=probe@paios.invalid -c commit.gpgsign=false commit -m lifecycle-probe')
            result = ensure(task).execute(command, timeout=90, bounded_capture=True)
            if result.get('returncode') != 0:
                diagnostic = """import os,subprocess,sys
from pathlib import Path
workspace,base=sys.argv[1:]
for path in (Path('/srv/source.git'),Path('/srv/source.git/objects'),Path(workspace)/'.git/objects/info/alternates'):
    print(str(path), 'exists',path.exists())
    if path.exists():
        print('mode',oct(path.stat().st_mode & 0o777))
        if path.is_file(): print(path.read_text())
for directory in ('/srv/source.git',workspace):
    result=subprocess.run(['git','-c','safe.directory='+directory,'-C',directory,'cat-file','-t',base],capture_output=True,text=True)
    print(directory,result.returncode,result.stdout,result.stderr)
"""
                diagnosed = original_ensure(task).execute('python3 -c ' + shlex.quote(diagnostic)
                    + ' ' + shlex.quote(workspace) + ' ' + shlex.quote(command.split('git checkout --detach ', 1)[1].split()[0]), timeout=15)
                event('prepare_diagnostic', output=diagnosed.get('output', '')[-12000:])
                raise RuntimeError('probe source preparation or commit failed')
            if args.exercise_code:
                from tools.code_execution_tool import execute_code
                code = 'from pathlib import Path\nrepair_probe_bytes = len(Path(' + repr(target) + ').read_bytes())\nprint(repair_probe_bytes)'
                result = json.loads(execute_code(code, task_id=task, enabled_tools=['terminal']))
                event('native_code_kernel', result=result)
                assert result['status'] == 'success', 'native remote code execution failed'
            if args.test_command:
                result = ensure(task).execute('cd ' + shlex.quote(workspace) + ' && ' + args.test_command,
                                             timeout=90, bounded_capture=True)
                event('repository_tests', returncode=result.get('returncode'), output=result.get('output', '')[-16000:])
                assert result.get('returncode') == 0 and not result.get('error'), 'repository tests failed in workshop'
            if args.exercise_code:
                result = json.loads(execute_code('print(repair_probe_bytes > 0)', task_id=task, enabled_tools=['terminal']))
                event('native_code_kernel_retained', result=result)
                assert result['status'] == 'success' and result['output'].strip() == 'True', 'native kernel state was lost'
            if not args.close_only:
                event('native_turn_cleanup_started', task=task)
                self._cleanup_task_resources(task)
                event('native_turn_cleanup_finished', task=task)
            return {'completed': True, 'final_response': 'isolated lifecycle probe'}

        def close(self):
            event('native_close_started')
            super().close()
            event('native_close_finished')

    try:
        with tempfile.TemporaryDirectory(prefix='builder-lifecycle-') as directory:
            spool = Path(directory)
            (spool / 'base.json').write_bytes((source_spool / 'base.json').read_bytes())
            os.environ['PAIOS_RELEASE_REQUESTS'] = directory
            run_agent.AIAgent, terminal.ensure_task_env = ScriptedAgent, ensure
            result = builder.repair_product({'input': 'Isolated source export lifecycle probe; no model inference.'})
            patch = (spool / result['request_id'] / 'candidate.patch').read_text()
            assert patch.startswith('From ') and 'isolated lifecycle probe' in patch
            proof.update(passed=True, request_id=result['request_id'], files=result['files'])
    except BaseException as error:
        proof['error'] = type(error).__name__
        raise
    finally:
        run_agent.AIAgent, terminal.ensure_task_env = original_agent, original_ensure
        os.environ['PAIOS_RELEASE_REQUESTS'] = original_spool
        try:
            if workspaces:
                with runtime_scope('build'):
                    task = 'lifecycle-probe-cleanup'
                    try:
                        env = original_ensure(task)
                        checked = env.execute(' && '.join('test ! -e ' + shlex.quote(path) for path in workspaces), timeout=30)
                        proof['production_workspace_cleanup_succeeded'] = checked.get('returncode') == 0
                        event('production_workspace_cleanup', returncode=checked.get('returncode'))
                        removed = env.execute('rm -rf -- ' + ' '.join(map(shlex.quote, workspaces)), timeout=30)
                        event('workspace_cleanup', returncode=removed.get('returncode'))
                        proof['cleanup_succeeded'] = removed.get('returncode') == 0
                        if not proof['cleanup_succeeded']:
                            raise RuntimeError('probe workspace cleanup failed')
                        if proof['passed'] and not proof['production_workspace_cleanup_succeeded']:
                            raise RuntimeError('product left a repair workspace behind')
                    finally:
                        terminal._evict_environment_for_task(task)
        except BaseException as error:
            proof.update(passed=False, cleanup_error=type(error).__name__)
            raise
        finally:
            identities = {row['phase']: row['uid'] for row in events if row['phase'].endswith('_identity')}
            scopes = {row['phase']: row.get('scope') for row in events if row['phase'] in ('prepare_commit_started', 'export_started')}
            proof['same_uid'] = identities['prepare_commit_identity'] == identities['export_identity'] if all(
                phase in identities for phase in ('prepare_commit_identity', 'export_identity')) else None
            proof['same_scope'] = scopes['prepare_commit_started'] == scopes['export_started'] if len(scopes) == 2 and all(scopes.values()) else None
            Path(args.output).write_text(json.dumps(proof, indent=2) + '\n')


if __name__ == '__main__':
    main()
