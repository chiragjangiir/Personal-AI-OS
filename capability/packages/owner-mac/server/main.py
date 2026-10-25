"""Stdio entry; imports are local to this package and the existing native source."""
import asyncio
import importlib.util
import os
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[4]
sys.path[:0] = [str(root), os.environ.get('PAIOS_HERMES_SOURCE', '/opt/hermes')]
spec = importlib.util.spec_from_file_location('owner_mac_package', Path(__file__).with_name('__init__.py'),
    submodule_search_locations=[str(Path(__file__).parent)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from owner_mac_package.package_server import selected_server, OwnerMacPackage
from integrations.hermes.personal_aios import PersonalAIOSProvider

if __name__ == '__main__':
    os.environ.pop('HERMES_WRITE_SAFE_ROOT', None)
    server = selected_server(PersonalAIOSProvider().capability_tools)
    if isinstance(server, OwnerMacPackage):
        asyncio.run(server.run())
    else:
        server.run('stdio')
