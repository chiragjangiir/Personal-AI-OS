"""Replay recorded isolated H5 turns with receipt outcomes through the authorized test brain."""
import argparse
import hashlib
import json
from pathlib import Path
import re

import httpx

from capability.sdk.python.yimi_receipt import receipt, to_mcp_result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--key-file', type=Path, required=True)
    parser.add_argument('--recordings', type=Path, required=True)
    parser.add_argument('--proxy', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--states', nargs='*', default=[])
    args = parser.parse_args()
    root = Path(__file__).parents[2]
    system = '\n\n'.join((root / path).read_text() for path in (
        'integrations/hermes/personal_aios/persona/yimi.md',
        'integrations/hermes/personal_aios/skills/personal-aios-main/SKILL.md'))
    results = []
    with httpx.Client(proxy=args.proxy, timeout=120) as client:
        for name, state, reason in [('allowed', 'waiting', 'needs_confirmation'),
                ('write', 'succeeded', 'completed'), ('edit', 'cancelled', 'confirmation_denied'),
                ('upload', 'unknown', 'TRANSPORT_DISCONNECTED')]:
            if args.states and state not in args.states:
                continue
            path = args.recordings / f'h5-eager-1-{name}.json'
            recorded = json.loads(path.read_text())
            tool = recorded['actual_tools'][-1]
            fields = {'status': {'reason_code': reason}}
            if state == 'waiting':
                fields['next'] = {'waiting_on': 'owner', 'needs_confirmation': 'fixture-card'}
            if state == 'unknown':
                fields['next'] = {'retry': 'after_check', 'check_with': 'fixture_read_only_status'}
                fields['unknowns'] = [{'about': 'operation', 'why': 'No transport acknowledgement.'}]
            body = receipt(state, **fields)
            messages = [{'role': 'system', 'content': system}, {'role': 'user', 'content': recorded['request']['input']},
                {'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'recorded', 'type': 'function',
                    'function': {'name': tool, 'arguments': json.dumps(recorded.get('expected_args', {}), ensure_ascii=False)}}]},
                {'role': 'tool', 'tool_call_id': 'recorded', 'content': json.dumps(to_mcp_result(body), ensure_ascii=False)}]
            for attempt in range(2):
                try:
                    response = client.post('https://amr-link.open-design.ai/v1/chat/completions',
                        headers={'Authorization': 'Bearer ' + args.key_file.read_text().strip()},
                        json={'model': 'deepseek-v4.1-flash', 'messages': messages, 'temperature': 0, 'max_tokens': 2000,
                            'tools':[{'type':'function','function':{'name':tool,'description':'Recorded tool',
                                'parameters':{'type':'object','properties':{}}}}], 'tool_choice':'none'})
                    if response.status_code>=400:
                        raise RuntimeError(response.text.replace(args.key_file.read_text().strip(),'[redacted]')[:1000])
                    response.raise_for_status()
                    value = response.json()
                    break
                except httpx.TransportError:
                    if attempt:
                        raise
            answer = value['choices'][0]['message'].get('content', '')
            checks = {'answered': bool(answer), 'no_tool_reexecution': not value['choices'][0]['message'].get('tool_calls')}
            if state == 'waiting':
                checks['waiting_reported'] = bool(re.search('确认|同意|授权', answer))
            if state == 'cancelled':
                checks['denial_reported'] = bool(re.search('拒绝|取消|没有|未|不', answer))
            if state == 'unknown':
                checks['uncertainty_reported'] = bool(re.search('未知|不确定|没.*确认|未.*确认|核对|回执|无法确认', answer))
                checks['no_false_failure_claim'] = not re.search('没成功|失败了|上传失败', answer)
                checks['check_before_retry'] = not re.search('再传一次|重试一遍', answer)
            results.append({'recording': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                'receipt': body, 'answer': answer, 'checks': checks, 'usage': value.get('usage')})
    args.out.write_text(json.dumps({'model': 'deepseek-v4.1-flash', 'results': results,
        'passed': all(all(row['checks'].values()) for row in results)}, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'samples': len(results), 'passed': all(all(row['checks'].values()) for row in results)}))


if __name__ == '__main__':
    main()
