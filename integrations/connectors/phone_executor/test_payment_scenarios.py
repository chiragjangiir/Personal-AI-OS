"""Fake-only runner binding and actual isolated HTTP redirects; no model or real service."""
import contextlib
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[3]
STAGING = ROOT / 'integrations/hermes/personal_aios/staging'
spec = importlib.util.spec_from_file_location('payment_scenarios', STAGING / 'run_scenarios.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


@contextlib.contextmanager
def service(handler):
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}'
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


class SilentHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass


class ScenarioIsolationTests(unittest.TestCase):
    def test_proxy_is_disabled_and_redirect_never_forwards_credentials(self):
        seen = []
        class Sink(SilentHandler):
            def do_GET(self):
                seen.append(self.headers.get('Authorization'))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{}')
        with service(Sink) as sink:
            class Origin(SilentHandler):
                def do_POST(self):
                    self.rfile.read(int(self.headers.get('Content-Length', '0')))
                    self.send_response(302)
                    self.send_header('Location', sink + '/unowned-target')
                    self.end_headers()
            with service(Origin) as origin, patch.dict(os.environ, {
                    'http_proxy': sink, 'HTTP_PROXY': sink, 'all_proxy': sink, 'NO_PROXY': '', 'no_proxy': ''}):
                binding = SimpleNamespace(authority=origin, open=runner._isolated_opener().open)
                with self.assertRaisesRegex(RuntimeError, 'redirects are forbidden'):
                    runner._payment_turn(binding, 'synthetic-fixture-key', 'staging-test', '开免密',
                                         {'request_timeout_s': 2, 'run_timeout_s': 2, 'poll_s': .01})
        self.assertEqual(seen, [])

    def test_all_external_entry_points_fail_before_unbound_request(self):
        with patch.object(runner.urllib.request, 'urlopen') as network:
            with self.assertRaisesRegex(ValueError, 'Bind an owned'):
                runner.call('/v1/runs', {'input': 'purchase'})
            with self.assertRaises((FileNotFoundError, ValueError)):
                runner.payment(str(ROOT / '.scratch/nonexistent-payment-fixture'))
            with self.assertRaises((FileNotFoundError, ValueError)):
                runner.commute(str(ROOT / '.scratch/nonexistent-payment-fixture'), 'chat', '帮我买东西')
            with patch.dict(os.environ, {}, clear=True), self.assertRaises(KeyError):
                runner.main(['food-progress'])
            network.assert_not_called()

    def test_listener_rejects_foreign_uid_and_wildcard_binding(self):
        import psutil
        process = SimpleNamespace(uids=lambda: SimpleNamespace(real=os.getuid() + 1))
        output = SimpleNamespace(stdout='p12345\n')
        with patch.object(runner.subprocess, 'run', return_value=output), patch.object(psutil, 'Process', return_value=process):
            with self.assertRaisesRegex(ValueError, 'not owned'):
                runner._listener('http://127.0.0.1:19999')
            process.uids = lambda: SimpleNamespace(real=os.getuid())
            process.net_connections = lambda **kwargs: [SimpleNamespace(status='LISTEN',
                laddr=SimpleNamespace(ip='0.0.0.0', port=19999))]
            with self.assertRaisesRegex(ValueError, 'only numeric loopback'):
                runner._listener('http://127.0.0.1:19999')

    def test_loopback_origin_is_exact_and_numeric(self):
        for url in ['http://localhost:19999', 'http://127.0.0.1:19999/path', 'https://127.0.0.1:19999',
                    'http://user:secret@127.0.0.1:19999', 'http://127.0.0.1:19999#redirect']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                runner._loopback(url)

    def test_binding_uses_existing_process_config_and_fake_authority_wiring(self):
        import yaml
        (ROOT / '.scratch').mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=ROOT / '.scratch', prefix='payment-binding-') as tmp:
            private = Path(tmp)
            home = private / 'hermes-staging'
            home.mkdir()
            for name in ['api.key', 'internal.key', 'executor.key']:
                (private / name).write_text('synthetic-' + name)
            gateway = {'hermes_base_url': 'http://127.0.0.1:19991', 'port': 19992,
                       'product_resources': {'gateway_port': 19993},
                       'storage_root': str(home / 'storage'), 'lock_file': str(home / 'central.lock'),
                       'hermes_key_file': str(private / 'api.key'), 'internal_key_file': str(private / 'internal.key'),
                       'payment': {'enabled': True, 'staging': True, 'executor_key_file': str(private / 'executor.key')}}
            env = {'PAIOS_FAKE_PHONE_LOG': str(home / 'fake-phone.jsonl'),
                   'PAIOS_ERRAND_SPOOL': str(home / 'errands'), 'PAIOS_FAKE_CASHIER': str(home / 'cashier.json'),
                   'PAIOS_PAYMENT_URL': 'http://127.0.0.1:19992', 'PAIOS_PAYMENT_KEY_FILE': str(private / 'executor.key')}
            native = {'personal_aios': {'internal_base_url': 'http://127.0.0.1:19992',
                                       'internal_key_file': gateway['internal_key_file']},
                      'mcp_servers': {'phone': {'command': '/fixture/python', 'args': [str(STAGING / 'fake_phone.py')], 'env': env}}}
            config_file, gateway_file = home / 'config.yaml', home / 'gateway.json'
            def save():
                config_file.write_text(yaml.safe_dump(native))
                gateway_file.write_text(json.dumps(gateway))
            save()
            started = time.time() + 10
            process_env = {'PAIOS_STAGE': 'staging', 'HERMES_HOME': str(home), 'PAIOS_PRODUCT_CONFIG': str(gateway_file)}
            def process(pid, command):
                return SimpleNamespace(pid=pid, cmdline=lambda: command, create_time=lambda: started,
                                       environ=lambda: process_env, is_running=lambda: True)
            authority = process(101, ['/fixture/node', str(ROOT / '01-product-half-finished/backend/services/personal-aios-integration/src/main.ts'),
                                      '--config', str(gateway_file)])
            hermes = process(102, ['/fixture/python', str(STAGING.parent / 'run_api.py')])
            def listener(url):
                return hermes if url == gateway['hermes_base_url'] else authority
            with patch.object(runner, '_listener', side_effect=listener):
                binding = runner.StagingBinding(private)
                self.assertEqual(binding.authority, env['PAIOS_PAYMENT_URL'])
                # No network dispatch occurs when the process identity changes or config drifts.
                with patch.object(binding.opener, 'open') as network:
                    authority.is_running = lambda: False
                    with self.assertRaisesRegex(ValueError, 'process exited'):
                        binding.open(runner.urllib.request.Request(binding.authority + '/v1/prompts'), 1)
                    network.assert_not_called()
                authority.is_running = lambda: True
                for change, restore in [
                    (lambda: native['mcp_servers']['phone'].update(args=['real_phone.py']),
                     lambda: native['mcp_servers']['phone'].update(args=[str(STAGING / 'fake_phone.py')])),
                    (lambda: env.update(PAIOS_PAYMENT_URL='http://127.0.0.1:18661'),
                     lambda: env.update(PAIOS_PAYMENT_URL=binding.authority)),
                    (lambda: gateway['payment'].update(staging=False), lambda: gateway['payment'].update(staging=True)),
                    (lambda: process_env.update(PAIOS_STAGE='production'), lambda: process_env.update(PAIOS_STAGE='staging'))]:
                    change(); save()
                    with self.assertRaises(ValueError):
                        runner.StagingBinding(private)
                    restore(); save()
                started = time.time() - 10
                with self.assertRaisesRegex(ValueError, 'config changed after process start'):
                    runner.StagingBinding(private)

    def test_typed_order_rejects_blocked_dispatch_and_mismatched_fake_job(self):
        calls = [{'tool': 'paios_payment', 'args': {'action': 'request'},
                  'result': {'status': 'accepted', 'intent_id': 'pi-fixture'}},
                 {'tool': 'phone_task', 'args': {'payment_intent': 'pi-fixture', 'app': '千问'},
                  'result': {'status': 'started', 'job_id': 'job-fixture'}}]
        evidence = [{'tool': 'phone_task', 'args': dict(calls[1]['args']), 'result': {'status': 'started', 'job_id': 'job-fixture'}},
                    {'tool': 'payment_checkpoint', 'args': {**calls[1]['args'], 'job_id': 'job-fixture'},
                     'result': {'checkpoint_reached': True}}]
        runner.assert_payment_scenario('payment-typed-order', calls, '开始了', evidence)
        for result in [None, {'status': 'blocked'}, {'status': 'started'}]:
            changed = copy.deepcopy(calls)
            changed[1]['result'] = result
            with self.assertRaises(AssertionError):
                runner.assert_payment_scenario('payment-typed-order', changed, '', evidence)
        for field, value in [('job_id', 'different-job'), ('app', '淘宝'), ('payment_intent', 'different-intent')]:
            changed = copy.deepcopy(evidence)
            changed[1]['args'][field] = value
            with self.assertRaises(AssertionError):
                runner.assert_payment_scenario('payment-typed-order', calls, '', changed)
        with self.assertRaises(AssertionError):
            runner.assert_payment_scenario('payment-typed-order', calls, '', [])
        changed = copy.deepcopy(calls)
        changed[0]['args']['app'] = '淘宝'
        with self.assertRaises(AssertionError):
            runner.assert_payment_scenario('payment-typed-order', changed, '', evidence)


if __name__ == '__main__':
    unittest.main()
