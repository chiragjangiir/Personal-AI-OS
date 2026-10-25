"""Opt-in Open Design replay against real Hermes MCP refresh and the package registry.

Usage: python <this> <repo> <out> <test-key-file> <pypdf-source>
The P1/P3 boundaries in workshop_capability_stack.ts are explicit test-only stubs.
"""
import asyncio
import base64
from io import BytesIO
import json
import os
from pathlib import Path
import shutil
import socket
import sys
import time

import httpx
from openai import OpenAI
from mcp.shared.exceptions import MCPError

REPO, OUT, KEY, DEPS = map(Path, sys.argv[1:5])
sys.path.insert(0, str(DEPS))
from pypdf import PdfWriter, PdfReader
from tools import mcp_tool

OUT.mkdir(parents=True, exist_ok=True)
scratch_key = REPO / '.scratch/capability-model.key'
shutil.copyfile(KEY, scratch_key)
scratch_key.chmod(0o600)
os.environ['PAIOS_CAPABILITY_TEST_KEY_FILE'] = str(scratch_key)
# Proxy is a client setting of this probe process only.
gateway = next(line.split()[2] for line in Path('/proc/net/route').read_text().splitlines()[1:]
               if line.split()[1] == '00000000')
proxy = 'http://' + socket.inet_ntoa(bytes.fromhex(gateway)[::-1]) + ':7897'
for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'):
    os.environ[name] = proxy
os.environ['NO_PROXY'] = '127.0.0.1,localhost'
files = {}
for name, pages in [('sample-a.pdf', 1), ('sample-b.pdf', 2)]:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=72, height=72)
    stream = BytesIO(); writer.write(stream)
    files[name] = {'base64': base64.b64encode(stream.getvalue()).decode()}
(OUT / 'sample-files.json').write_text(json.dumps(files))
transcript, timings = [], []
client = OpenAI(api_key=scratch_key.read_text().strip(), base_url='https://amr-link.open-design.ai/v1',
                max_retries=1, http_client=httpx.Client(proxy=proxy, trust_env=False, timeout=180))


async def main():
    mcp_tool._ensure_mcp_sdk()
    task = mcp_tool.MCPServerTask('yimi-capability-probe')
    await task.start({'command': 'node', 'args': [str(REPO / 'tests/hermes/workshop_capability_stack.ts'),
        str(REPO), str(OUT), str(DEPS)], 'env': {**os.environ}, 'timeout': 1500})
    identity = id(task)
    messages = [{'role': 'system', 'content':
        '你是依米。在隔离测试部署中按工程手册完成能力流水线。先 capability_find 找复用，再 capability_build 用你自己的模型构建标准包，'
        'capability_check 全部通过后用 capability_publish 直接上线，不加确认或预发。每步用真实工具，不声称没完成的步骤。'
        '上线刷新后通过新的工具处理两个合成样本 /work/sample-a.pdf 和 /work/sample-b.pdf，它们分别1页、2页。'
        '可用写入范围只有 /work。缺少第三方工具也可把现有pypdf包装成能力包。完成本轮后停止，等待主人下一句话。'
        '第一轮只到上线和样本验证，不自行撤销；第二轮收到主人撤销意图后才回退。'
        '登记失败就把错误作为 feedback 交给 capability_build 修复同一个包，再检查；不要从头丢弃已完成的工作。'
        '主人说改回去时，用 capability_rollback 撤销最近上线的包。'}]
    feedback = OUT / 'replay-feedback.txt'
    if feedback.exists():
        messages[0]['content'] += '\n上次登记的实际诊断：' + feedback.read_text()
    if os.environ.get('PAIOS_CAPABILITY_RESUME_DRAFT') == '1':
        messages[0]['content'] += ('\n已有你上次自己写出的未验证草稿，可通过 capability_build(feedback=诊断) 继续修复。'
            '先找复用，再继续这份草稿；每个合同用例都必须在 files 中自带相对 /work 的输入，不能假设运行时样本在登记时存在。'
            '只需少量代表性合同和业务回归；平台会统一校验清单、回执和安全，不要重复实现这些检查。'
            '清单 scopes 是调用方范围，本轮须包含 owner；build 是构建环境，不能替代 owner。')

    async def turn(text):
        messages.append({'role': 'user', 'content': text})
        for step in range(20):
            listed = await task.session.list_tools()
            tools = [{'type': 'function', 'function': {'name': tool.name,
                'description': tool.description or tool.name, 'parameters': mcp_tool.mcp_field(tool, 'input_schema', 'inputSchema')}} for tool in listed.tools]
            started = time.monotonic()
            response = await asyncio.to_thread(client.chat.completions.create,
                model='deepseek-v4.1-flash', messages=messages, tools=tools, max_tokens=2500, temperature=0)
            choice = response.choices[0].message
            item = choice.model_dump(exclude_none=True)
            messages.append(item)
            transcript.append({'type': 'model', 'message': item, 'usage': response.usage.model_dump()})
            timings.append({'step': 'model', 'seconds': time.monotonic() - started})
            if not choice.tool_calls:
                break
            for call in choice.tool_calls:
                started = time.monotonic()
                args = json.loads(call.function.arguments)
                print('tool', call.function.name, flush=True)
                try:
                    result = await task.session.call_tool(call.function.name, args, read_timeout_seconds=1500)
                    content = result.model_dump_json(exclude_none=True, by_alias=True)
                except MCPError as error:
                    content = json.dumps({'error': str(error)})
                messages.append({'role': 'tool', 'tool_call_id': call.id, 'content': content})
                transcript.append({'type': 'tool', 'name': call.function.name, 'args': args, 'result': json.loads(content)})
                timings.append({'step': call.function.name, 'seconds': time.monotonic() - started})
                (OUT / 'transcript.json').write_text(json.dumps(transcript, ensure_ascii=False, indent=2))
                (OUT / 'timings.json').write_text(json.dumps(timings, indent=2))
                await asyncio.sleep(.1)
        else:
            raise RuntimeError('Model exceeded the bounded replay budget')

    try:
        await turn('帮我做一个能批量处理 PDF 的能力')
        events = json.loads((OUT / 'stack-events.json').read_text())
        if not any(row['action'] == 'call' for row in events):
            await turn('请用刚上线的能力处理那两个合成 PDF 样本。')
        events = json.loads((OUT / 'stack-events.json').read_text())
        assert not any(row['action'] == 'capability_rollback' for row in events), 'Model rolled back before the owner requested it'
        await asyncio.sleep(.3)
        after_publish = [tool.name for tool in task._tools]
        await turn('改回去')
        await asyncio.sleep(.3)
        after_rollback = [tool.name for tool in task._tools]
        assert id(task) == identity
        events = json.loads((OUT / 'stack-events.json').read_text())
        assert any(row['action'] == 'call' and row['receipt']['status']['state'] == 'succeeded' for row in events), 'No successful batch receipt'
        dynamic = set(after_publish) - set(after_rollback)
        assert dynamic, 'Hermes did not remove the dynamic tool on tools/list_changed'
        assert not json.loads((await task.session.call_tool('capability_status')).content[0].text)['enabled']
        automatic = await task.session.call_tool('test_automatic_rollback', {})
        rollback = json.loads(automatic.content[0].text)
        assert rollback['regression']['rollback']['reason'] == 'outcome_regression'
        assert rollback['health']['rollback']['reason'] == 'health_failed'
        events = json.loads((OUT / 'stack-events.json').read_text())
        artifacts = []
        for event in events:
            if event['action'] == 'call':
                for name, encoded in event['audit']['artifacts'].items():
                    if name.endswith('.pdf'):
                        artifacts.append({'name': name, 'pages': len(PdfReader(BytesIO(base64.b64decode(encoded))).pages)})
        summary = {'model': 'deepseek-v4.1-flash', 'hermes_connection_unchanged': id(task) == identity,
                   'published_tools': after_publish, 'after_rollback': after_rollback, 'removed': list(dynamic),
                   'artifacts_independently_parsed': artifacts, 'automatic_rollback': rollback,
                   'authority_and_consent': 'explicit_test_stubs', 'isolation': 'rootless_namespaces',
                   'containers': 'not_run_docker_socket_permission_denied'}
        (OUT / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
        print('model pipeline and rollback verified', flush=True)
    finally:
        await task.shutdown()


try:
    asyncio.run(main())
finally:
    client.close()
    scratch_key.unlink(missing_ok=True)
    shutil.rmtree(REPO / '.scratch/model-builder-home', ignore_errors=True)
    (OUT / 'transcript.json').write_text(json.dumps(transcript, ensure_ascii=False, indent=2))
    (OUT / 'timings.json').write_text(json.dumps(timings, indent=2))
