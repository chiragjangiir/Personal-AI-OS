"""Native Python MCP host; receipt conversion reuses the production TS adapter."""
import asyncio
import json
import os
from pathlib import Path

from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server
from mcp.types import CallToolResult, ListToolsResult, Tool

directory = Path(__file__).resolve().parents[1]
root = directory.parents[2]
tools = json.loads((root / 'integrations/contracts/desktop-tools.v1.json').read_text())['tools']
fixtures = json.loads((directory / 'tests/contract.yaml').read_text())['cases']


async def listing(context, params):
    for tool in tools:
        tool['inputSchema']['properties']['owner_requested'] = {'type': 'boolean'}
    return ListToolsResult(tools=[Tool.model_validate(tool) for tool in tools])


async def calling(context, params):
    fixture = next(item for item in fixtures if item['tool'] == params.name and
        (not os.environ.get('PAIOS_MAC_FAKE_SCENARIO') or item['id'] == os.environ['PAIOS_MAC_FAKE_SCENARIO']))
    process = await asyncio.create_subprocess_exec('node', str(directory / 'fake/receipt.ts'),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    output, error = await process.communicate(json.dumps(dict(name=params.name, args=params.arguments or fixture['args'], raw=fixture['raw'])).encode())
    if process.returncode:
        raise RuntimeError('Fake receipt conversion failed')
    return CallToolResult.model_validate_json(output)


async def main():
    server = Server('desktop', on_list_tools=listing, on_call_tool=calling)
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())


if __name__ == '__main__':
    asyncio.run(main())
