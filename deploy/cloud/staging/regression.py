#!/usr/bin/env python3
"""Qualify the restored staging stack using the existing release clients and exam."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from staging_snapshot_stack import Stack
from staging_snapshot_restore import preflight

CORE = ('front', 'gateway', 'hermes', 'postgres', 'livekit', 'workshop', 'workshop-link')
BUSINESS = ('chat.accepted', 'chat.timeline', 'call.playback', 'call.closed', 'call.settlement',
            *('effects.' + kind for kind in ('payment', 'message', 'phone_task', 'ride', 'login', 'email')), 'watch')


def failure_reason(error):
    # Commands and stdout can contain credentials. Only keep the final diagnostic.
    message = error.stderr if isinstance(error, subprocess.CalledProcessError) else (
        type(error).__name__ if isinstance(error, subprocess.SubprocessError) else str(error))
    if isinstance(message, bytes):
        message = message.decode('utf-8', errors='replace')
    lines = (message or '').strip().splitlines()
    reason = lines[-1] if lines else type(error).__name__
    reason = re.sub(r'(?i)\bBearer\s+\S+', 'Bearer [REDACTED]', reason)
    reason = re.sub(r'(?i)([\w-]*(?:key|token|secret|password|authorization)[\w-]*[\s\"\x27]*[:=]\s*)[\"\x27]?[^\s,;}]+',
                    r'\1[REDACTED]', reason)
    reason = re.sub(r'https?://\S+', '[URL REDACTED]', reason)
    return reason.encode('utf-8')[:2048].decode('utf-8', errors='ignore')


def plan():
    return {'stage': 'staging', 'checks': ['isolation', 'isolation.evidence', 'fixture.pair', 'containers', 'gateway.healthz',
            'hermes.health', 'postgres.ready', 'workshop.ssh', 'front.nginx', *BUSINESS],
            'clients': ['mac-product-provision.ts', 'mac-product-sim-client.ts', 'exam'],
            'receipt': '<PAIOS_SNAPSHOT_RECEIPT stem>.regression.json',
            'effects': ['payment', 'message', 'phone_task', 'ride', 'login', 'email'],
            'watch': 'native cron, fake transition, one timeline item'}


def isolation(stack, source):
    preflight(stack, stack.settings)
    if not source.get('stores_verified'):
        raise ValueError('Restore store verification is required')
    for name in ('gateway', 'hermes'):
        service = stack.definition['services'][name + '-staging']
        if service['environment'].get('PAIOS_STAGE') != 'staging':
            raise ValueError('Staging environment is required')
    for name, image in source['candidate_images'].items():
        if stack.definition['services'][name]['image'] != image:
            raise ValueError('Candidate changed after restore')
    cloud = json.loads(Path(stack.config_mount()).read_text())
    if cloud['payment']['enabled'] or not cloud['payment']['staging']:
        raise ValueError('Payment must stay disabled and staged')
    if not cloud['product_resources'].get('staging_effect_sink_file'):
        raise ValueError('Staging effect sink is required')
    return {'stores_verified': True, 'payment_enabled': False, 'stage': 'staging'}


PRODUCTION_ONLY = ('frp-token', 'bark-key', 'bark-device', 'vidu.key', 'agentbay.key')


def isolation_evidence(stack, config, source):
    """Capture the exam's isolation evidence from the running staging containers, for this run only.

    The host observes the containers it just started (networks, ports, secret mounts, stage, rendered payment and
    effect sink); a receipt therefore never outlives the stack it describes.
    """
    services = stack.definition['services']
    private = Path(next(m['source'] for m in services['hermes-staging']['volumes'] if m['target'] == '/stage-private'))
    def host(path):
        return private / Path(path).relative_to('/stage-private')
    exam = json.loads(host(config['effects']['exam_config']).read_text())
    receipt_path = host(exam['isolation_receipt'])
    receipt = json.loads(receipt_path.read_text())
    project = stack.definition['name']
    ids = subprocess.run(['docker', 'ps', '-q', '--filter', 'label=com.docker.compose.project=' + project],
                         check=True, capture_output=True, text=True).stdout.split()
    rows, secret_dirs = [], set()
    for container in json.loads(subprocess.run(['docker', 'inspect', *ids], check=True, capture_output=True, text=True).stdout):
        mode = container['HostConfig']['NetworkMode']
        network = mode if mode.startswith(('service:', 'container:')) else ','.join(sorted(container['NetworkSettings']['Networks']))
        ports = sorted({b['HostPort'] for v in (container['NetworkSettings']['Ports'] or {}).values() if v for b in v})
        secrets = sorted({m['Source'] for m in container['Mounts'] if m['Destination'].startswith('/run/secrets/')})
        secret_dirs.update(str(Path(s).parent) for s in secrets)
        stage = next((e.split('=', 1)[1] for e in container['Config']['Env'] if e.startswith('PAIOS_STAGE=')), None)
        rows.append(f"{container['Config']['Labels']['com.docker.compose.service']} image={container['Image']} network={network} "
                    f"ports={','.join(ports)} secrets={','.join(secrets)} PAIOS_STAGE={stage}")
    forbidden = [f'{d}/{k}' for d in sorted(secret_dirs) for k in PRODUCTION_ONLY if (Path(d) / k).exists()]
    cloud = json.loads(Path(stack.config_mount()).read_text())
    if forbidden or cloud['payment']['enabled'] or not cloud['product_resources'].get('staging_effect_sink_file'):
        raise ValueError('Staging isolation evidence failed: production-only secrets, payment or missing effect sink')
    at = datetime.now(timezone.utc).replace(microsecond=0)
    network_lines = [f'generated_at={at.isoformat()} project={project} images={json.dumps(source["candidate_images"])}', *sorted(rows),
                     f'payment.enabled False payment.staging {cloud["payment"]["staging"]}',
                     f'staging_effect_sink_file {cloud["product_resources"]["staging_effect_sink_file"]}',
                     f'production-only secrets present {forbidden}', f'secret dirs {sorted(secret_dirs)}']
    observer_lines = [f'generated_at={at.isoformat()}',
                      'effect sink: staging_effect_sink_file in owner-data-staging; fake phone log in hermes-home-staging',
                      'fake phone and fake Mijia are selected by regression-init.py for PAIOS_STAGE=staging']
    for field, lines in (('network_evidence', network_lines), ('observer_evidence', observer_lines)):
        path = host(receipt[field])
        path.write_text('\n'.join(lines) + '\n')
    receipt['expires_at'] = (at + timedelta(hours=24)).isoformat()
    receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
    for path in (receipt_path, host(receipt['network_evidence']), host(receipt['observer_evidence'])):
        os.chown(path, 10000, 10000)
        path.chmod(0o600)
    return {'generated_at': at.isoformat(), 'containers': len(rows), 'expires_at': receipt['expires_at']}


def containers(stack, config):
    expected = {name + '-staging' for name in CORE}
    expected.update(config.get('additional_services', []))
    if any(not name.endswith('-staging') for name in expected):
        raise ValueError('Only staging services are allowed')
    running = set(stack.run(['ps', '--status', 'running', '--services'],
                           capture_output=True, text=True).stdout.split())
    if not expected <= running:
        raise ValueError('An expected staging service is not running')
    return {'running': sorted(expected)}


def probe(stack, service, command):
    stack.run(['exec', '-T', service + '-staging', *command], capture_output=True, text=True)
    return {'service': service + '-staging', 'exit_code': 0}


def health(stack, config, record):
    record('containers', lambda: containers(stack, config))
    for service, name, port, path in [('gateway', 'gateway.healthz', '8787', '/healthz'),
                                    ('hermes', 'hermes.health', None, '/health')]:
        python = 'python3' if service == 'gateway' else '/opt/hermes/.venv/bin/python'
        script = ("import os,urllib.request,urllib.error,time\n"
                  "port=" + (repr(port) if port else "os.environ['PAIOS_HERMES_PORT']") + "\n"
                  "deadline=time.monotonic()+30\nwhile True:\n"
                  " try:\n  r=urllib.request.urlopen('http://127.0.0.1:'+port+" + repr(path) + ",timeout=5)\n"
                  "  assert r.status==200\n  break\n"
                  " except urllib.error.HTTPError: raise\n"
                  " except urllib.error.URLError:\n  if time.monotonic()>=deadline: raise\n  time.sleep(.5)")
        record(name, lambda s=service, p=python, c=script: probe(stack, s, [p, '-c', c]))
    pg = stack.definition['services']['postgres-staging']
    command = pg['command']
    record('postgres.ready', lambda: probe(stack, 'postgres', ['pg_isready', '-p',
           command[command.index('-p') + 1], '-U', pg['environment']['POSTGRES_USER'],
           '-d', pg['environment']['POSTGRES_DB']]))
    script = ("import socket; s=socket.create_connection(('workshop-link-staging',2222),timeout=5); "
              "assert s.recv(256).startswith(b'SSH-'); s.close()")
    record('workshop.ssh', lambda: probe(stack, 'hermes', ['/opt/hermes/.venv/bin/python', '-c', script]))
    record('front.nginx', lambda: probe(stack, 'front', ['nginx', '-t']))


def execute(settings, config, receipt):
    source = json.loads(receipt.read_text())
    target = receipt.with_name(receipt.stem + '.regression.json')
    evidence = receipt.parent / (receipt.stem + '.regression')
    if evidence.exists():
        evidence.rename(evidence.with_name(evidence.name + ".previous-" + uuid.uuid4().hex))
    evidence.mkdir(mode=0o700)
    result = {'schema': 'paios.staging-regression.v1', 'snapshot_receipt': str(receipt),
              'started_at': datetime.now(timezone.utc).isoformat(), 'checks': [], 'passed': False}

    def save():
        target.write_text(json.dumps(result, indent=2) + '\n')

    def record(name, action):
        row = {'name': name, 'status': 'failed'}
        try:
            row['evidence'] = action()
            row['status'] = 'passed'
        except (OSError, ValueError, KeyError, AssertionError, subprocess.SubprocessError) as error:
            row['error_type'] = type(error).__name__
            row['reason'] = failure_reason(error)
            row['evidence'] = {'artifact_directory': str(evidence)}
            if isinstance(error, subprocess.CalledProcessError):
                row['evidence']['exit_code'] = error.returncode
        result['checks'].append(row)
        save()
        print(name + ': ' + row['status'], flush=True)
        return row.get('evidence') if row['status'] == 'passed' else None

    handles = []
    def compose():
        handles.append(Stack(settings, stage=True))
        return {'profile': 'staging'}
    if record('compose', compose) is None:
        return 1
    stack = handles[0]
    record('isolation', lambda: isolation(stack, source))
    if all(row['status'] == 'passed' for row in result['checks']):
        record('isolation.evidence', lambda: isolation_evidence(stack, config, source))
    if all(row['status'] == 'passed' for row in result['checks']):
        from regression_turns import bootstrap
        def prepare():
            paired = bootstrap(stack, config)
            for kind in ('chat', 'call'):
                config['turns'][kind]['pairing'] = paired['pairing_file']
            stack.run(['restart', 'gateway-staging'], capture_output=True, text=True)
            return paired
        record('fixture.pair', prepare)
    if all(row['status'] == 'passed' for row in result['checks']):
        health(stack, config, record)
    if all(row['status'] == 'passed' for row in result['checks']):
        from regression_turns import run as turns
        from regression_effects import run as effects
        turns(stack, config, evidence, record)
        effects(stack, config, evidence, record)
    seen = {row['name'] for row in result['checks']}
    for name in BUSINESS:
        if name not in seen:
            result['checks'].append({'name': name, 'status': 'not_run', 'reason': 'prerequisite failed'})
    result['passed'] = all(row['status'] == 'passed' for row in result['checks'])
    result['finished_at'] = datetime.now(timezone.utc).isoformat()
    save()
    return 0 if result['passed'] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--settings', required=True, type=Path)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if args.dry_run:
        print(json.dumps(plan(), indent=2))
        return 0
    os.umask(0o077)
    if os.environ.get('PAIOS_STAGE') != 'staging' or not os.environ.get('PAIOS_SNAPSHOT_RECEIPT'):
        parser.error('restore must set PAIOS_STAGE=staging and PAIOS_SNAPSHOT_RECEIPT')
    settings = json.loads(args.settings.read_text())
    if settings['role'] != 'staging':
        parser.error('Staging settings are required')
    receipt = Path(os.environ['PAIOS_SNAPSHOT_RECEIPT']).resolve()
    if receipt.parent != Path(settings['evidence']).resolve():
        parser.error('Snapshot receipt must belong to the configured evidence directory')
    return execute(settings, json.loads(args.config.read_text()), receipt)


if __name__ == '__main__':
    sys.exit(main())
