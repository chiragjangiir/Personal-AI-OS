"""Carry native cua-driver stdio over the authenticated owner-Mac SSH transport."""
import json
import os
from pathlib import Path
import shlex
import sys

def command(context, device_id, arguments):
    from .owner_mac import environment
    observed = os.environ.get('PAIOS_OWNER_MAC_CUA_OBSERVE') == '1'
    with (environment(context, device_id, read_only=True) if observed else environment(context, device_id)) as env:
        driver = os.environ.get('PAIOS_OWNER_MAC_CUA_DRIVER', '/Applications/CuaDriver.app/Contents/MacOS/cua-driver')
        remote = shlex.join(['env', 'CUA_DRIVER_RS_TELEMETRY_ENABLED=0', driver, *arguments])
        ssh = env._build_ssh_command()
        # First options win: stdio teardown must not leave a detached SSH master.
        return [ssh[0], '-T', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
                *ssh[1:], remote]


if __name__ == '__main__':
    package = Path(__file__).resolve().parent
    sys.path.insert(0, str(package.parent))
    __package__ = package.name
    argv = command(json.loads(sys.argv[1]), sys.argv[2], sys.argv[3:])
    os.execvp(argv[0], argv)
