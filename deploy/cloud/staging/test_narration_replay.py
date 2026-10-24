import json
import unittest
import sys
from types import SimpleNamespace

from narration_replay import transcript_prefix, evaluate_checks
from narration_replay import judge, native_agent, assemble, run
import tempfile
from pathlib import Path
from unittest.mock import patch


class ReplayTests(unittest.TestCase):
    def test_native_launch_instructions_reach_api_request_for_main_and_child(self):
        class Agent:
            def __init__(self, **kwargs):
                self.options = kwargs
            def _build_system_prompt(self):
                return self.options['ephemeral_system_prompt']
        provider_loads = []
        request_assemblies = []
        def assemble_request(agent, **kwargs):
            request_assemblies.append(kwargs)
            return SimpleNamespace(api_messages=[{'role': 'system', 'content': kwargs['active_system_prompt']}] + kwargs['messages'])
        modules = {
            'hermes_cli.config': SimpleNamespace(load_config=lambda: {'memory': {'provider': 'configured'}}),
            'plugins.memory': SimpleNamespace(load_memory_provider=lambda name: provider_loads.append(name)),
            'gateway.run': SimpleNamespace(_resolve_runtime_agent_kwargs=lambda: {}, _resolve_gateway_model=lambda: 'configured',
                GatewayRunner=SimpleNamespace(_load_reasoning_config=lambda model: {})),
            'run_agent': SimpleNamespace(AIAgent=Agent),
            'gateway.run_scope': SimpleNamespace(with_note=lambda instructions, scope: instructions + ':' + scope),
            'tools.delegate_tool_progress': SimpleNamespace(_build_child_system_prompt=lambda goal, context, role: goal + ':' + context + ':' + role),
            'tools.delegation_output_schema': SimpleNamespace(append_output_contract=lambda context, schema: context + ':outcome'),
            'tools.personal_aios_task_outcome': SimpleNamespace(task_outcome_schema=lambda schema: {'task': 'outcome'}),
            'agent.turn_request_assembly': SimpleNamespace(assemble_api_request=assemble_request, logger=None),
        }
        with patch.dict(sys.modules, modules), patch('pathlib.Path.read_text', return_value='main ProcessedEvent instruction'):
            main = native_agent('main', {'kind': 'api', 'run_scope': 'owner'})
            failure = {'execution': {'success': True}, 'task_retry_allowed': False}
            child = native_agent('child', {'kind': 'child', 'goal': 'goal', 'context': 'actual context', 'role': 'leaf',
                'principal_id': 'retained-owner', 'failure_context': failure})
            with self.subTest('retained owner scope'):
                self.assertEqual(child._paios_principal_id, 'retained-owner')
            with self.subTest('retained failure context'):
                self.assertEqual(child._paios_failure_context, failure)
            self.assertIn('main ProcessedEvent instruction:owner', assemble(main, [])[0]['content'])
            self.assertIn('goal:actual context:outcome:leaf', assemble(child, [])[0]['content'])
            self.assertTrue(child.options['side_agent'] and child.options['skip_context_files'])
            self.assertEqual(provider_loads, ['configured', 'configured'])
            for agent in (main, child):
                prefix = [{'role': 'user', 'content': 'retained request'}]
                request = assemble(agent, prefix)
                self.assertEqual(request[-1], {'role': 'system', 'content': 'Narration replay: tool execution is suspended. Complete the pending final assistant response in its required format without tool calls.'})
                self.assertEqual(prefix, [{'role': 'user', 'content': 'retained request'}])
            self.assertEqual(len(request_assemblies), 4)
            for launch in (None, {}, {'kind': 'missing'}):
                with self.assertRaisesRegex(ValueError, 'launch kind'):
                    native_agent('invalid', launch)

    def test_empty_manifest_and_unmatched_case_do_not_report_success(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'manifest.json'
            for cases, selected in (([], None), ([{'id': 'actual'}], 'typo')):
                path.write_text(json.dumps(cases))
                with self.assertRaisesRegex(ValueError, 'no cases'):
                    run(SimpleNamespace(manifest=str(path), case=selected))

    def test_resume_uses_saved_input_without_reassembling_or_replacing_it(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            native = root / 'native.json'
            native.write_text(json.dumps({'trace': {'messages': [
                {'id': 1, 'session_id': 'session', 'role': 'user', 'content': 'request'},
                {'id': 2, 'session_id': 'session', 'role': 'assistant', 'content': 'target'}]}}))
            manifest = root / 'manifest.json'
            manifest.write_text(json.dumps([{'id': 'example', 'native': str(native), 'message_id': 2, 'launch': {'kind': 'api'}}]))
            dest = root / 'results/example'
            dest.mkdir(parents=True)
            frozen = '[{"role":"system","content":"original request bytes"}]'
            (dest / 'input.json').write_text(frozen)
            (dest / 'sample-1.json').write_text(json.dumps({'text': 'saved', 'tool_calls': False, 'verdict': {'pass': True}}))
            args = SimpleNamespace(manifest=str(manifest), output=str(root / 'results'), case=None,
                adapter=None, refresh_skills=False, samples=1, minimum_passes=1)
            with patch('narration_replay.native_agent'), patch('narration_replay.assemble') as build:
                self.assertEqual(run(args), 0)
                build.assert_not_called()
            self.assertEqual((dest / 'input.json').read_text(), frozen)

    def test_explicit_failure_keeps_judge_record_without_becoming_a_pass(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            native = root / 'native.json'
            native.write_text(json.dumps({'trace': {'messages': [
                {'id': 1, 'session_id': 's', 'role': 'user', 'content': 'request'},
                {'id': 2, 'session_id': 's', 'role': 'assistant', 'content': 'target'}]}}))
            manifest = root / 'manifest.json'
            manifest.write_text(json.dumps([{'id': 'case', 'native': str(native), 'message_id': 2,
                'launch': {'kind': 'api'}, 'checks': {'require': ['actual receipt']}}]))
            dest = root / 'out/case'
            dest.mkdir(parents=True)
            (dest / 'input.json').write_text('[]')
            args = SimpleNamespace(manifest=str(manifest), output=str(root / 'out'), case=None,
                adapter=None, refresh_skills=False, samples=1, minimum_passes=1)
            with patch('narration_replay.native_agent', return_value=SimpleNamespace(model='configured', provider='custom', close=lambda: None)), patch('narration_replay.completion', return_value={'text': 'missing', 'tool_calls': False}), patch('narration_replay.judge', return_value={'pass': True, 'prompt': 'retained judge', 'response': {'text': 'raw'}}):
                self.assertEqual(run(args), 1)
            saved = json.loads((dest / 'sample-1.json').read_text())
            self.assertEqual(saved['verdict']['prompt'], 'retained judge')
            self.assertFalse(saved['deterministic_checks'])

    def test_prefix_keeps_current_tool_result_but_excludes_target_and_other_sessions(self):
        rows = [dict(id=1, session_id='a', role='user', content='request'),
                dict(id=2, session_id='b', role='assistant', content='private'),
                dict(id=3, session_id='a', role='assistant', content='',
                     tool_calls=json.dumps([{'id': 'c', 'type': 'function', 'function': {'name': 'lookup', 'arguments': '{}'}}])),
                dict(id=4, session_id='a', role='tool', content='actual receipt', tool_call_id='c'),
                dict(id=5, session_id='a', role='assistant', content='wrong answer')]
        result = transcript_prefix({'trace': {'messages': rows}}, 5)
        self.assertEqual([m['role'] for m in result], ['user', 'assistant', 'tool'])
        self.assertEqual(result[1]['tool_calls'][0]['id'], 'c')
        self.assertNotIn('id', result[0])

    def test_readback_wrapper_uses_same_native_contract(self):
        native = {'native': {'trace': {'messages': [dict(id=1, session_id='a', role='user', content='original'), dict(id=2, session_id='a', role='assistant', content='wrong')]}}}
        self.assertEqual(transcript_prefix(native, 2), [{'role': 'user', 'content': 'original'}])

    def test_missing_target_is_error(self):
        with self.assertRaises(ValueError):
            transcript_prefix({'trace': {'messages': []}}, 50)

    def test_no_checks_is_not_success(self):
        self.assertIsNone(evaluate_checks('anything', {}))
        self.assertFalse(evaluate_checks('任务成功，重新发送', {'forbid': ['重新发送']}))
        self.assertTrue(evaluate_checks('确认已完成', {'require': ['确认'], 'forbid': ['重发']}))

    def test_judge_does_not_receive_original_failure_commentary_as_evidence(self):
        case = {'criteria': ['state actual receipt'], 'facts': [
            {'group': 'case', 'evidence': {'receipt': 'once'},
             'observed': 'original failure commentary', 'expected': 'duplicated target'}]}
        with patch('narration_replay.completion', return_value={'text': '{"pass":true,"reason":"receipt"}'}) as call:
            result = judge(None, {'text': 'receipt confirmed'}, case)
        prompt = call.call_args.args[1][0]['content']
        self.assertNotIn('original failure commentary', prompt)
        self.assertNotIn('duplicated target', prompt)
        self.assertIn('once', prompt)
        self.assertTrue(result['pass'])

    def test_judge_uses_explicit_job_report_records_without_inferring_from_history(self):
        reports = [{'job_id': 'job-a', 'reply_text': 'Already reported', 'source': {'run_id': 'other-session-run'}}]
        case = {'criteria': ['Only new facts'], 'facts': [{'group': 'dedup', 'evidence': {'job_id': 'job-a'}}],
                'prior_reports': reports}
        with patch('narration_replay.completion', return_value={'text': '{"pass":true}'}) as call:
            judge(None, {'text': 'New confirmation'}, case)
        payload = json.loads(call.call_args.args[1][0]['content'].split('\n', 1)[1])
        self.assertEqual(payload['prior_reports'], reports)
