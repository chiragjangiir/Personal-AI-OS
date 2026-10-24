"""Replay a native assistant continuation through Hermes' configured brain, without tools.

Inputs and every sample belong in a private output directory. The manifest contains
native evidence paths/message IDs, expected facts, and optional regex checks. No
fixture actions are executed. A candidate adapter must call the product producer.
"""
import argparse
import copy
import importlib
import json
import re
import time
from pathlib import Path


def transcript_prefix(native, message_id):
    rows = native.get('native', native)['trace']['messages']
    targets = [row for row in rows if row['id'] == message_id]
    if len(targets) != 1 or targets[0]['role'] != 'assistant':
        raise ValueError('Target must identify exactly one native assistant message')
    target = targets[0]
    messages = []
    for row in rows:
        if row['session_id'] != target['session_id'] or row['id'] >= message_id:
            continue
        message = {key: row[key] for key in ('role', 'content', 'tool_call_id') if row.get(key) is not None}
        if row.get('tool_calls'):
            message['tool_calls'] = json.loads(row['tool_calls']) if isinstance(row['tool_calls'], str) else row['tool_calls']
        messages.append(message)
    return messages


def refresh_skills(messages):
    from tools.skills_tool import skill_view
    from agent.tool_dispatch_helpers import make_tool_result_message
    changed = {'personal-aios-main', 'failure-selfcheck', 'errands/failure-selfcheck'}
    calls = {}
    for message in messages:
        for call in message.get('tool_calls', []):
            function = call['function']
            if function['name'] == 'skill_view':
                args = json.loads(function['arguments'])
                if args['name'] in changed:
                    calls[call['id']] = args
        if message['role'] == 'tool' and message.get('tool_call_id') in calls:
            args = calls[message['tool_call_id']]
            result = skill_view(args['name'], file_path=args.get('file_path'), preprocess=False)
            message.update(make_tool_result_message('skill_view', result, message['tool_call_id']))
    return messages


def evaluate_checks(text, checks):
    if not checks:
        return None
    return (all(re.search(pattern, text, re.S) for pattern in checks.get('require', []))
            and not any(re.search(pattern, text, re.S) for pattern in checks.get('forbid', [])))


def native_agent(session_id, launch):
    if not isinstance(launch, dict) or launch.get('kind') not in ('api', 'child'):
        raise ValueError('Unknown replay launch kind')
    from hermes_cli.config import load_config
    from plugins.memory import load_memory_provider
    load_memory_provider(load_config()['memory']['provider'])
    from gateway.run import _resolve_runtime_agent_kwargs, _resolve_gateway_model, GatewayRunner
    from run_agent import AIAgent
    runtime = _resolve_runtime_agent_kwargs()
    model = runtime.pop('model', None) or _resolve_gateway_model()
    runtime.pop('_fallback_notice', None)
    flags = {}
    if launch and launch['kind'] == 'api':
        from gateway.run_scope import with_note
        instructions = Path('/opt/paios/integrations/hermes/personal_aios/skills/personal-aios-main/SKILL.md').read_text()
        flags['ephemeral_system_prompt'] = with_note(instructions, launch['run_scope'])
    elif launch and launch['kind'] == 'child':
        from tools.delegate_tool_progress import _build_child_system_prompt
        from tools.delegation_output_schema import append_output_contract
        from tools.personal_aios_task_outcome import task_outcome_schema
        context = append_output_contract(launch.get('context'), task_outcome_schema(launch.get('output_schema')))
        flags.update(ephemeral_system_prompt=_build_child_system_prompt(
            launch['goal'], context, role=launch['role']),
            side_agent=True, skip_context_files=True)
    agent = AIAgent(model=model, **runtime, **flags, session_id=session_id,
                   platform='subagent' if launch and launch['kind'] == 'child' else 'api_server',
                   enabled_toolsets=[], skip_memory=True, skip_background_review=True,
                   save_trajectories=False, quiet_mode=True,
                   reasoning_config=GatewayRunner._load_reasoning_config(model))
    if launch.get('principal_id'):
        agent._paios_principal_id = launch['principal_id']
    if launch['kind'] == 'child' and launch.get('failure_context'):
        agent._paios_failure_context = copy.deepcopy(launch['failure_context'])
    return agent


def assemble(agent, messages):
    from agent.turn_request_assembly import assemble_api_request, logger
    messages = copy.deepcopy(messages) + [{'role': 'system', 'content':
        'Narration replay: tool execution is suspended. Complete the pending final assistant response in its required format without tool calls.'}]
    agent._current_turn_timestamp = time.time()
    prompt = agent._build_system_prompt()
    current = max((i for i, row in enumerate(messages) if row['role'] == 'user'), default=-1)
    request = assemble_api_request(agent, messages=messages, current_turn_user_idx=current,
        _ext_prefetch_cache=None, _plugin_user_context=None, moa_config=None, active_system_prompt=prompt,
        original_user_message=messages[current]['content'] if current >= 0 else '',
        pending_moa_prepared_request=None, request_logger=logger)
    return request.api_messages


def completion(agent, messages):
    kwargs = agent._build_api_kwargs(messages, tools_for_api=[])
    kwargs.pop('tools', None)
    kwargs.pop('tool_choice', None)
    result = agent._interruptible_api_call(kwargs)
    message = result.choices[0].message
    return {'text': message.content or '', 'tool_calls': bool(getattr(message, 'tool_calls', None)),
            'message': message.model_dump(), 'finish_reason': result.choices[0].finish_reason,
            'usage': result.usage.model_dump() if getattr(result, 'usage', None) else None}


def judge(agent, sample, case):
    facts = [{'group': fact['group'], 'evidence': fact['evidence']} for fact in case['facts']]
    prompt = ('Evaluate the assistant continuation against the supplied authoritative facts. '
              'The original failing answer is not evidence. Prior reports show what was already said, '
              'not whether its claims were true. Require every criterion. '
              'Do not require exact wording. Return JSON {"pass":boolean,"reason":string}. '
              'A silence/dedup response passes only if the criteria permit silence.\n'
              + json.dumps({'criteria': case['criteria'], 'authoritative_facts': facts,
                            'prior_reports': case.get('prior_reports', []),
                            'assistant': sample['text']}, ensure_ascii=False))
    result = completion(agent, [{'role': 'user', 'content': prompt}])
    try:
        parsed = json.loads(result['text'].strip().removeprefix('```json').removesuffix('```').strip())
    except json.JSONDecodeError as error:
        return {'prompt': prompt, 'response': result, 'pass': False, 'kind': 'judge_invalid', 'error': str(error)}
    if not isinstance(parsed, dict) or type(parsed.get('pass')) is not bool:
        return {'prompt': prompt, 'response': result, 'pass': False, 'kind': 'judge_invalid',
                'error': 'Judge did not return a boolean verdict'}
    return {'prompt': prompt, 'response': result, 'pass': parsed['pass'], 'reason': parsed.get('reason')}


def run(args):
    cases = json.loads(Path(args.manifest).read_text())
    cases = [case for case in cases if not args.case or case['id'] == args.case]
    if not cases:
        raise ValueError('Replay selection contains no cases')
    adapter = None
    if args.adapter:
        module, function = args.adapter.split(':')
        adapter = getattr(importlib.import_module(module), function)
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True, mode=0o700)
    summary = []
    for case in cases:
        dest = out / case['id']
        dest.mkdir(exist_ok=True, mode=0o700)
        prefix = transcript_prefix(json.loads(Path(case['native']).read_text()), case['message_id'])
        if args.refresh_skills:
            prefix = refresh_skills(prefix)
        if adapter:
            prefix = adapter(prefix, case)
        agent = native_agent('narration-replay-' + case['id'], case['launch'])
        try:
            input_path = dest / 'input.json'
            if not input_path.exists():
                input_path.write_text(json.dumps(assemble(agent, prefix), ensure_ascii=False, indent=2))
            messages = json.loads(input_path.read_text())
            passes = []
            for i in range(args.samples):
                sample_path = dest / f'sample-{i+1}.json'
                if sample_path.exists() and 'verdict' in json.loads(sample_path.read_text()):
                    sample = json.loads(sample_path.read_text())
                    passes.append(sample['verdict']['pass'] and not sample['tool_calls'] and evaluate_checks(sample['text'], case.get('checks', {})) is not False)
                    continue
                sample = json.loads(sample_path.read_text()) if sample_path.exists() else completion(agent, messages)
                sample_path.write_text(json.dumps(sample, ensure_ascii=False, indent=2))
                deterministic = evaluate_checks(sample['text'], case.get('checks', {}))
                verdict = judge(agent, sample, case)
                sample.update(verdict=verdict, deterministic_checks=deterministic, model=agent.model, provider=agent.provider)
                (dest / f'sample-{i+1}.json').write_text(json.dumps(sample, ensure_ascii=False, indent=2))
                passes.append(verdict['pass'] and not sample['tool_calls'] and deterministic is not False)
            summary.append({'id': case['id'], 'passes': sum(passes), 'samples': args.samples,
                            'passed': sum(passes) >= args.minimum_passes})
            (out / ('summary-' + args.case + '.json' if args.case else 'summary.json')).write_text(json.dumps(summary, ensure_ascii=False, indent=2))
        finally:
            agent.close()
    return 0 if all(row['passed'] for row in summary) else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--refresh-skills', action='store_true')
    parser.add_argument('--case', help='Run exactly one case, for independent worker processes')
    parser.add_argument('--adapter', help='Candidate producer adapter module:function')
    parser.add_argument('--samples', type=int, default=5)
    parser.add_argument('--minimum-passes', type=int, default=4)
    raise SystemExit(run(parser.parse_args()))
