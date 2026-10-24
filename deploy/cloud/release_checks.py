"""Host-side release gates on a running stack: drain, native readiness, health and structural post-check.

Every function receives `run(args, **options)`, which executes `docker compose <release inputs> args`, and the
stage's service suffix. Nothing here prints credentials or log bodies.
"""
import json
import re
import subprocess
import time

from staging_snapshot_stack import call_idle

HERMES_PYTHON = '/opt/hermes/.venv/bin/python'

# Expiring leases and active runs are in-flight work a restart would cut. Persisted process completions survive a
# restart and are delivered afterwards, so they never block a switch.
NATIVE_DRAIN = '''
import json, os, shutil, sqlite3, tempfile, time, urllib.request
from pathlib import Path
home=Path(os.environ['HERMES_HOME']); source=home/'state.db'
with tempfile.TemporaryDirectory() as tmp:
 copied=Path(tmp)/'state.db'; shutil.copyfile(source,copied)
 for tail in ('-wal','-shm'):
  if Path(str(source)+tail).exists(): shutil.copyfile(str(source)+tail,str(copied)+tail)
 with sqlite3.connect(copied) as db:
  counts={t:db.execute('SELECT COUNT(*) FROM '+t+' WHERE expires_at > ?',(time.time(),)).fetchone()[0] for t in ('session_turn_leases','compression_locks')}
request=urllib.request.Request('http://127.0.0.1:'+os.environ['PAIOS_HERMES_PORT']+'/health/detailed',headers={'Authorization':'Bearer '+Path('/run/secrets/hermes-api.key').read_text().strip()})
with urllib.request.urlopen(request,timeout=10) as r: q=json.load(r)['readiness']['checks']['background_queues']
counts.update({k:q[k] for k in ('active_api_runs','active_delegations')})
print(json.dumps(counts))
'''
ERRANDS = "import json; from pathlib import Path; print(json.dumps({'running_errands':len(list(Path('/var/lib/paios/state/errands').glob('*.running.json')))}))"
# The gateway's own system-notice endpoint on its loopback listener, with the key it already holds (no new channel).
NOTICE = ("import json,os,sys,urllib.request; from pathlib import Path; "
          "r=urllib.request.Request('http://127.0.0.1:'+os.environ['PAIOS_INTEGRATION_PORT']+'/internal/hermes/scheduled-delivery',"
          "data=sys.stdin.buffer.read(),headers={'Authorization':'Bearer '+Path('/run/secrets/hermes-internal.key').read_text().strip(),"
          "'Content-Type':'application/json'}); "
          "print(urllib.request.build_opener(urllib.request.ProxyHandler({})).open(r,timeout=20).read().decode())")
FAULTS = re.compile(r'HERMES_HTTP_401|out of memory|\bpanic\b|Unhandled|L5_.*EXHAUSTED', re.I)


def inside(run, service, interpreter, code):
    return json.loads(run(['exec', '-T', service, interpreter, '-c', code], capture_output=True, text=True).stdout)


def containers(run):
    ids = run(['ps', '-a', '-q'], capture_output=True, text=True).stdout.split()
    if not ids:
        raise ValueError('FAIL: no containers')
    return json.loads(subprocess.run(['docker', 'inspect', *ids], check=True, capture_output=True, text=True).stdout)


def drain(run, suffix=''):
    """Owner-call closure through the gateway authority, then in-flight native, errand and fault evidence."""
    call_idle(run, 'gateway' + suffix)
    oom = [r['Config']['Labels']['com.docker.compose.service'] for r in containers(run) if r['State']['OOMKilled']]
    native = inside(run, 'hermes' + suffix, HERMES_PYTHON, NATIVE_DRAIN)
    errands = inside(run, 'gateway' + suffix, 'python3', ERRANDS)
    logs = run(['logs', '--no-color', '--since', '5m', 'gateway' + suffix, 'hermes' + suffix], capture_output=True, text=True).stdout
    report = {'native': native, **errands, 'log_faults': len(FAULTS.findall(logs)), 'oom': oom}
    report['passed'] = not (any(native.values()) or any(errands.values()) or report['log_faults'] or oom)
    return report


def native_ready(run, suffix=''):
    code = ("import{readFile}from'node:fs/promises';"
            "import{loadHostConfiguration}from'/opt/paios/01-product-half-finished/backend/services/personal-aios-integration/src/host-configuration.ts';"
            "import{HermesClient}from'/opt/paios/01-product-half-finished/backend/services/personal-aios-integration/src/hermes-client.ts';"
            "const c=await loadHostConfiguration('/etc/paios/cloud.json');const key=(await readFile(c.hermes_key_file,'utf8')).trim();"
            "const ready=await new HermesClient(c.hermes_base_url,key,c.native_request_timeout_ms,c.max_read_bytes).ready(c.max_request_bytes);"
            "console.log(JSON.stringify({official_native_ready:ready}));process.exitCode=ready?0:1;")
    result = run(['run', '--rm', '--no-deps', '-T', '--pull', 'never', 'gateway' + suffix, 'node', '--input-type=module', '-e', code],
                 capture_output=True, text=True, timeout=120)
    return json.loads(result.stdout.strip().splitlines()[-1])


def wait_health(run, suffix='', attempts=60, interval=5):
    code = ("import os,urllib.request; r=urllib.request.urlopen('http://127.0.0.1:'+os.environ['PAIOS_INTEGRATION_PORT']+'/health',timeout=5); "
            "assert r.status==200")
    for attempt in range(1, attempts + 1):
        try:
            run(['exec', '-T', 'gateway' + suffix, 'python3', '-c', code], capture_output=True)
            return {'gateway_health_seconds': (attempt - 1) * interval}
        except subprocess.CalledProcessError:
            time.sleep(interval)
    raise RuntimeError('GATEWAY_HEALTH_TIMEOUT')


def postcheck(run, suffix='', expected=None, core_only=False, edge_forward=False):
    """Structural smoke: required services running, healthy and on the accepted immutable images."""
    expected = expected or {}
    required = {s + suffix for s in ('gateway', 'hermes', 'postgres', 'livekit', 'front')}
    if not core_only:
        required |= {s + suffix for s in ('workshop', 'workshop-link')} | ({'frpc'} if edge_forward else set())
    rows, seen, services = containers(run), set(), []
    for r in rows:
        name = r['Config']['Labels']['com.docker.compose.service']
        seen.add(name)
        if core_only and name not in required:
            continue
        state = r['State']
        health = state.get('Health', {}).get('Status', 'none')
        ok = (state['Running'] and not state['OOMKilled'] and health in ('healthy', 'none')
              and (name not in expected or expected[name] == r['Image']))
        services.append({'service': name, 'image': r['Image'], 'ok': ok, 'health': health, 'restarts': r['RestartCount']})
    for service, interpreter, port in [('gateway', 'python3', 'PAIOS_INTEGRATION_PORT'), ('hermes', HERMES_PYTHON, 'PAIOS_HERMES_PORT')]:
        code = "import os,urllib.request; r=urllib.request.urlopen('http://127.0.0.1:'+os.environ['" + port + "']+'/health',timeout=10); assert r.status==200"
        run(['exec', '-T', service + suffix, interpreter, '-c', code], capture_output=True)
    run(['exec', '-T', 'front' + suffix, 'nginx', '-t', '-q'], capture_output=True)
    missing = sorted((required | {name for name in expected if not core_only}) - seen)
    return {'services': services, 'missing': missing,
            'passed': not missing and all(row['ok'] for row in services)}


def notice(run, suffix, body):
    """Deliver one owner system notice; only the gateway's delivered receipt for this exact id counts."""
    out = run(['exec', '-T', 'gateway' + suffix, 'python3', '-c', NOTICE], input=json.dumps(body), capture_output=True, text=True).stdout
    receipt = json.loads(out.strip().splitlines()[-1])
    if receipt.get('status') != 'delivered' or receipt.get('system_event_id') != body['id']:
        raise ValueError('NOTICE_NOT_ACCEPTED')
    return receipt
