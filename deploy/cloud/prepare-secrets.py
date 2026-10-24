#!/usr/bin/env python3
"""Render secret-bearing front/LiveKit files on the host, never in images."""
import argparse
import base64
import secrets
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--secrets-dir', type=Path, required=True)
parser.add_argument('--public-host', required=True)
parser.add_argument('--public-ipv4', required=True)
parser.add_argument('--staging', action='store_true')
parser.add_argument('--bootstrap', action='store_true', help='Validate and import public deployment model keys')
parser.add_argument('--uid', type=int, help='Owner UID for newly generated files and directories')
parser.add_argument('--tls-dir', type=Path, help='Keep supplied TLS pair or generate a self-signed pair')
args = parser.parse_args()
import ipaddress
ipaddress.IPv4Address(args.public_ipv4)
if not re.fullmatch(r'[a-z0-9.-]+', args.public_host):
    raise ValueError('ASCII DNS public host required')
roles = ('BRAIN', 'VISION', 'EXECUTOR_FAST', 'EXECUTOR_THOROUGH', 'REALTIME', 'TTS', 'WORKSHOP_REPAIR')
def role_file(role):
    return 'role-' + role.lower().replace('_', '-') + '.key'
if args.bootstrap:
    for role in roles:
        if role != 'BRAIN' and not os.environ.get(f'PAIOS_{role}_MODEL'):
            continue
        key = args.secrets_dir / role_file(role)
        if not os.environ.get(f'PAIOS_{role}_API_KEY', '').strip() and not (key.is_file() and key.read_text().strip()):
            parser.error(f'PAIOS_{role}_API_KEY is required (or provide a nonempty {key.name})')
def directory(path):
    if not path.exists():
        path.mkdir(parents=True, mode=0o700)
        if args.uid is not None:
            os.chown(path, args.uid, path.stat().st_gid)
directory(args.secrets_dir)
owner = args.secrets_dir.stat()
owner_uid = args.uid if args.uid is not None else owner.st_uid
def credential(name):
    value = (args.secrets_dir / name).read_text().strip()
    if not re.fullmatch(r'[A-Za-z0-9_+./=:-]+', value):
        raise ValueError(f'Invalid {name} credential encoding')
    return value
def protected(name, content):
    path = args.secrets_dir / name
    existing = path.exists()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        if not existing:
            os.fchown(stream.fileno(), owner_uid, owner.st_gid)
        stream.write(content)
    os.chmod(path, 0o600)
def missing(name, content):
    path = args.secrets_dir / name
    if not path.exists():
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            os.fchown(stream.fileno(), owner_uid, owner.st_gid)
            stream.write(content)
    os.chmod(path, 0o600)
# Host-local credentials have one authority. Existing files retain their bytes.
for name in ('postgres.password', 'proxy-attestation', 'livekit-api-key', 'livekit-api-secret',
             'hermes-api.key', 'hermes-internal.key', 'frp-token', 'e2ee-root-key'):
    missing(name, secrets.token_urlsafe(32))
for name in ('payment-executor.key', 'voiceprint.key'):
    missing(name, base64.b64encode(secrets.token_bytes(32)).decode('ascii') + '\n')
if args.bootstrap:
    for role in roles:
        value = os.environ.get(f'PAIOS_{role}_API_KEY', '')
        if '\n' in value or '\r' in value:
            parser.error(f'PAIOS_{role}_API_KEY must be a single line')
        if value:
            missing(role_file(role), value + '\n')
if args.tls_dir:
    tls = args.tls_dir
    directory(tls)
    cert, key = tls / 'fullchain.pem', tls / 'privkey.pem'
    if cert.exists() != key.exists():
        parser.error('--tls-dir must contain both fullchain.pem and privkey.pem, or neither')
    if not cert.exists():
        try:
            ipaddress.ip_address(args.public_host)
            host_san = f'IP:{args.public_host}'
        except ValueError:
            host_san = f'DNS:{args.public_host}'
        sans = ','.join(dict.fromkeys([host_san, f'IP:{args.public_ipv4}']))
        with tempfile.TemporaryDirectory(dir=tls) as temporary:
            generated = Path(temporary)
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
                '-days', '365', '-subj', f'/CN={args.public_host}', '-addext', f'subjectAltName={sans}',
                '-addext', 'basicConstraints=critical,CA:FALSE',
                '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment',
                '-addext', 'extendedKeyUsage=serverAuth',
                '-keyout', str(generated / key.name), '-out', str(generated / cert.name)],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            for destination in (cert, key):
                source = generated / destination.name
                source.chmod(0o600)
                os.chown(source, owner_uid, owner.st_gid)
                source.rename(destination)
    for path in (cert, key):
        path.chmod(0o600)
attestation = credential('proxy-attestation')
protected('workshop-public-ipv4', args.public_ipv4 + '\n')
protected('nginx-attestation.conf', f'proxy_set_header X-PAIOS-Proxy-Attestation "{attestation}";\n')
config = {'port': int(os.environ.get('PAIOS_LIVEKIT_SIGNAL_PORT', '7880')), 'bind_addresses': ['127.0.0.1'],
    'rtc': {'tcp_port': int(os.environ.get('PAIOS_STAGING_RTC_TCP_PORT' if args.staging else 'PAIOS_RTC_TCP_PORT', '17881' if args.staging else '7881')),
            'udp_port': int(os.environ.get('PAIOS_STAGING_RTC_UDP_PORT' if args.staging else 'PAIOS_RTC_UDP_PORT', '17882' if args.staging else '7882')),
            'use_external_ip': False, 'node_ip': args.public_ipv4},
    'keys': {credential('livekit-api-key'): credential('livekit-api-secret')}}
turn_prefix = 'PAIOS_STAGING_TURN' if args.staging else 'PAIOS_TURN'
turn_enabled = os.environ.get(f'{turn_prefix}_ENABLED', 'false')
if turn_enabled not in ('true', 'false'):
    raise ValueError(f'{turn_prefix}_ENABLED must be true or false')
config['turn'] = {'enabled': True, 'domain': args.public_host,
    'tls_port': int(os.environ.get(f'{turn_prefix}_TLS_PORT', '15349' if args.staging else '5349')),
    'udp_port': int(os.environ.get(f'{turn_prefix}_UDP_PORT', '13478' if args.staging else '3478')),
    'relay_range_start': int(os.environ.get(f'{turn_prefix}_RELAY_START', '25700' if args.staging else '25600')),
    'relay_range_end': int(os.environ.get(f'{turn_prefix}_RELAY_END', '25799' if args.staging else '25699')),
    'cert_file': '/etc/paios-tls/fullchain.pem', 'key_file': '/etc/paios-tls/privkey.pem'}
if turn_enabled == 'false':
    config['turn'] = {'enabled': False}
# JSON is a YAML subset accepted by LiveKit's YAML loader.
protected('livekit.yaml', json.dumps(config, indent=2) + '\n')
# Empty optional files satisfy Compose binds without enabling a provider.
# An empty bark-device leaves the offline push unprovisioned, as on the Mac.
optional = ['tavily.key'] + ([] if args.staging else ['agentbay.key', 'agentbay.adbkey', 'agentbay.adbkey.pub', 'bark-device', 'vidu.key'])
optional += ['deepseek.key', 'siliconflow.key', 'dashscope.key', 'amap.key', 'bark-key',
             'cold-webdav.password', 'owner-mac-relay.json']
for name in optional:
    missing(name, '')
if args.bootstrap:
    directory(args.secrets_dir / 'owner-mac')
if not args.staging and os.environ.get('PAIOS_PHONE_PROVIDER', 'agentbay') == 'agentbay' and (args.secrets_dir / 'agentbay.key').read_text().strip():
    for name in ('agentbay.adbkey', 'agentbay.adbkey.pub'):
        if not (args.secrets_dir / name).read_text().strip():
            raise ValueError(f'{name} is required with agentbay.key')
    if not os.environ.get('PAIOS_AGENTBAY_IMAGE'):
        raise ValueError('PAIOS_AGENTBAY_IMAGE is required with agentbay.key')
print('Prepared protected Nginx attestation and LiveKit configuration')
