"""One stdio MCP host for small Python packages; the deployment loader chooses its modules."""
import asyncio
import importlib
import json
import sys
from pathlib import Path

from mcp.server.lowlevel import Server, NotificationOptions
from mcp.server.stdio import stdio_server
from mcp.types import CallToolResult, ListToolsResult, Tool

from capability.sdk.python.yimi_receipt import to_mcp_result


class Host:
    def __init__(self):
        self.tools = {}
        self.namespace = ''
        self.refresh = lambda: False
        self.session = None
        self.schema = json.loads((Path(__file__).parents[1] / 'contracts/receipt.v1.schema.json').read_text())

    def add(self, name, function, parameters, description):
        name = self.namespace + name
        if name in self.tools:
            raise ValueError('Duplicate package tool')
        self.tools[name] = (function, Tool(name=name, description=description,
            inputSchema=parameters, outputSchema=self.schema))

    def server(self):
        async def tools(context, params):
            self.refresh()
            self.session = context.session
            return ListToolsResult(tools=[tool for _, tool in self.tools.values()])

        async def call(context, params):
            # Hooks shallow-merge arguments. Consume the reserved judgment before execution.
            arguments = {k: v for k, v in params.arguments.items() if k != 'owner_requested'}
            result = await asyncio.to_thread(self.tools[params.name][0], **arguments)
            return CallToolResult(**(result if 'structuredContent' in result else to_mcp_result(result)))

        return Server('yimi-shared', on_list_tools=tools, on_call_tool=call)

    async def watch(self):
        while True:
            await asyncio.sleep(1)
            if self.refresh() and self.session:
                await self.session.send_tool_list_changed()


async def main(modules):
    host = Host()
    for module in modules:
        namespace, separator, module_name = module.partition('=')
        host.namespace = namespace + '__' if separator else ''
        module = module_name if separator else namespace
        importlib.import_module(module).register(host)
    server = host.server()
    watcher = asyncio.create_task(host.watch())
    try:
        async with stdio_server() as (reader, writer):
            await server.run(reader, writer, server.create_initialization_options(
                notification_options=NotificationOptions(tools_changed=True)))
    finally:
        watcher.cancel()


if __name__ == '__main__':
    asyncio.run(main(sys.argv[1:]))
