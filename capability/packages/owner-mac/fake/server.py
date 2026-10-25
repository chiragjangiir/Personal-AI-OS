"""Scripted transport with the production schemas and receipt adapter; no SSH or devices."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys

directory = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(directory.parents[2]), os.environ.get('PAIOS_HERMES_SOURCE', '/opt/hermes')]
spec = importlib.util.spec_from_file_location('owner_mac_package', directory / 'server/__init__.py',
    submodule_search_locations=[str(directory / 'server')])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from owner_mac_package.package_server import OwnerMacPackage
from integrations.hermes.personal_aios.owner_mac import create_server
from mcp.types import CallToolResult

fixtures = json.loads((directory / 'tests/contract.yaml').read_text())['cases']


def fixture(name):
    return next(item for item in fixtures if item['tool'] == name and
                (not os.environ.get('PAIOS_MAC_FAKE_SCENARIO') or item['id'] == os.environ['PAIOS_MAC_FAKE_SCENARIO']))


class FakeTransport:
    async def list_tools(self):
        return await create_server().list_tools()

    async def call_tool(self, name, args):
        return CallToolResult(content=[{'type': 'text', 'text': json.dumps(fixture(name)['raw'])}])


if __name__ == '__main__':
    asyncio.run(OwnerMacPackage(legacy=FakeTransport(), computer=lambda args, **kw: fixture('computer_use')['raw']).run())
