"""One stateful MCP runtime over the existing paired owner-Mac transports."""
import asyncio
import copy
import json

from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server
from mcp.types import CallToolResult, ListToolsResult, Tool

from .receipts import POLICIES, exception_result, mcp_result


class OwnerMacPackage:
    def __init__(self, legacy=None, computer=None):
        if legacy is None:
            from integrations.hermes.personal_aios.owner_mac import create_server
            legacy = create_server(observe=True)
        if computer is None:
            from integrations.hermes.personal_aios.owner_mac_computer import execute
            computer = execute
        self.legacy, self.computer = legacy, computer
        async def listing(context, params):
            return ListToolsResult(tools=await self.list_tools())
        async def calling(context, params):
            return await self.call_tool(params.name, params.arguments or {})
        self.server = Server('owner_mac', on_list_tools=listing, on_call_tool=calling)

    async def list_tools(self):
        from tools.computer_use.schema import COMPUTER_USE_SCHEMA
        tools = list(await self.legacy.list_tools())
        native = copy.deepcopy(COMPUTER_USE_SCHEMA)
        native['parameters']['properties'].update(device_id={'type': 'string'}, context={'type': 'object'})
        native['parameters']['required'] = [*native['parameters'].get('required', []), 'context']
        tools.append(Tool(name='computer_use', description='Operate the paired owner Mac through its existing SSH/CUA transport.',
                          inputSchema=native['parameters']))
        for tool in tools:
            schema = tool.input_schema
            schema['additionalProperties'] = False
            schema['properties']['owner_requested'] = {'type': 'boolean', 'description': 'Whether the owner explicitly requested this operation.'}
        return tools

    async def call_tool(self, name, arguments):
        if name not in POLICIES:
            raise ValueError('Unknown owner Mac package tool')
        # Standard gateway fields never reach the native transport. No self-reported effect.
        args = {key: item for key, item in arguments.items() if key != 'owner_requested'}
        try:
            if 'effect' in arguments:
                raise ValueError('Effect classification belongs to the manifest')
            if name == 'computer_use':
                context = args['context']
                raw = await asyncio.to_thread(self.computer, args, session_id=context['session_id'], tool_call_id=context['tool_call_id'])
            else:
                result = await self.legacy.call_tool(name, args)
                if result.is_error:
                    raise RuntimeError('Owner Mac MCP operation did not return its outcome')
                raw = result.structured_content
                if raw is None:
                    raw = json.loads(result.content[0].text)
            result = mcp_result(name, args, raw)
        except Exception as error:
            result = exception_result(name, error)
        return CallToolResult.model_validate(result)

    async def run(self):
        async with stdio_server() as (read, write):
            await self.server.run(read, write, self.server.create_initialization_options())


def create_server(**kwargs):
    return OwnerMacPackage(**kwargs)


def selected_server(capability_tools, **kwargs):
    """Use the loader's catalog projection; a disabled family keeps the original MCP entry."""
    if 'mcp__owner_mac__computer_use' in capability_tools:
        return create_server(**kwargs)
    from integrations.hermes.personal_aios.owner_mac import create_server as legacy_server
    return legacy_server()
