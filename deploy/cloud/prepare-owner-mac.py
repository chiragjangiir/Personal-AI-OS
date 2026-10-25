#!/usr/bin/env python3
"""Prepare a deployment's owner-Mac relay secrets without rotating existing keys.

The relay (frps) runs in the front network namespace: Macs reach it as wss://<public host>:<TLS port>/~!frp through the
front's existing certificate, and the visitor in the same namespace dials it on loopback."""
import argparse
import json
import os
from pathlib import Path
import secrets

parser = argparse.ArgumentParser()
parser.add_argument('--secrets-dir', required=True, type=Path)
parser.add_argument('--relay-host', required=True, help='public host the Macs dial (the front TLS host)')
parser.add_argument('--relay-port', type=int, default=9443, help='public TLS port of the front')
parser.add_argument('--frps-port', type=int, default=7000, help='loopback port of frps inside the front namespace')
parser.add_argument('--admin-port', type=int, default=18665)
parser.add_argument('--visitor-port-start', type=int, default=22000)
parser.add_argument('--visitor-port-end', type=int, default=22999)
args = parser.parse_args()
if not args.relay_host or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789.-' for c in args.relay_host):
    raise ValueError('relay-host must be the public DNS hostname of the front')
if not all(1024 < port < 65536 for port in (args.admin_port, args.frps_port, args.visitor_port_start, args.visitor_port_end)) or not 0 < args.relay_port < 65536 or args.visitor_port_start > args.visitor_port_end:
    raise ValueError('Invalid relay/admin/visitor ports')
root = args.secrets_dir
owner = root.stat()
def protected(path, content):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        os.fchown(stream.fileno(), owner.st_uid, owner.st_gid)
        stream.write(content)
    path.chmod(0o600)
relay_file = root / 'owner-mac-relay.json'
relay_text = relay_file.read_text() if relay_file.exists() else ''
if relay_text:
    relay = json.loads(relay_text)
    if (relay['server_addr'], relay['server_port'], relay['admin_port'], relay['visitor_port_start'], relay['visitor_port_end']) != (args.relay_host, args.relay_port, args.admin_port, args.visitor_port_start, args.visitor_port_end):
        raise ValueError('Existing relay binding differs; migrate explicitly instead of rotating paired Macs')
else:
    relay = dict(server_addr=args.relay_host, server_port=args.relay_port, token=secrets.token_urlsafe(32),
                 admin_port=args.admin_port, admin_password=secrets.token_urlsafe(32),
                 visitor_port_start=args.visitor_port_start, visitor_port_end=args.visitor_port_end)
    protected(relay_file, json.dumps(relay, indent=2) + '\n')
directory = root / 'owner-mac'
directory.mkdir(mode=0o700, exist_ok=True)
os.chown(directory, owner.st_uid, owner.st_gid)
visitors = directory / 'visitors'
visitors.mkdir(mode=0o700, exist_ok=True)
os.chown(visitors, owner.st_uid, owner.st_gid)
q = json.dumps
protected(directory / 'frpc.toml', f'''loginFailExit = false
serverAddr = "127.0.0.1"
serverPort = {args.frps_port}
transport.protocol = "tcp"
auth.method = "token"
auth.token = {q(relay['token'])}
webServer.addr = "127.0.0.1"
webServer.port = {relay['admin_port']}
webServer.user = "paios"
webServer.password = {q(relay['admin_password'])}
includes = ["/run/owner-mac/visitors/*.toml"]
log.level = "error"
''')
protected(root / 'owner-mac-frps.toml', f'''bindAddr = "127.0.0.1"
bindPort = {args.frps_port}
proxyBindAddr = "127.0.0.1"
auth.method = "token"
auth.token = {q(relay['token'])}
allowPorts = [{{ single = 1 }}]
log.level = "error"
''')
print('Prepared owner-Mac relay configuration; secret values were not printed')
