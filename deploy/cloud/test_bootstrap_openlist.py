"""HTTP contract fixture. Does not claim a real OpenList/Aliyun acceptance run."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
import urllib.request

spec = importlib.util.spec_from_file_location('bootstrap', Path(__file__).with_name('bootstrap-openlist.py'))
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class Contract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        (self.data / 'config.json').write_text(json.dumps({'log': {'enable': True, 'name': '/dev/null'}}))
        self.secret = 'PRIVATE_FIXTURE_TOKEN'
        (self.data / 'bootstrap.json').write_text(json.dumps({'refresh_token': self.secret}))
        with sqlite3.connect(self.data / 'data.db') as db:
            db.execute('CREATE TABLE x_setting_items (key TEXT,value TEXT)')
            db.execute('INSERT INTO x_setting_items VALUES (?,?)', ('token', self.secret))
        for path in self.data.iterdir():
            path.chmod(0o600)
        self.stores, self.users, self.objects, self.mutations = [], [], {}, []
        self.folders = {'resource': [{'name': 'Personal-AIOS', 'type': 'folder', 'file_id': 'folder-123'}], 'backup': []}
        fixture = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                self.handle_request()
            do_POST = do_PUT = do_DELETE = do_GET
            def handle_request(self):
                body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
                path = self.path.split('?')[0]
                if path.startswith('/dav/'):
                    if self.command == 'PUT':
                        fixture.objects[path] = body
                        self.send_response(201)
                    elif self.command == 'DELETE':
                        del fixture.objects[path]
                        self.send_response(204)
                    elif self.headers.get('Content-Type') == 'application/json':
                        self.send_response(403)  # OpenList v4.2.6 native_proxy rejects a WebDAV GET with a JSON type
                    else:
                        self.send_response(200 if path in fixture.objects else 404)
                    self.end_headers()
                    if self.command == 'GET':
                        self.wfile.write(fixture.objects.get(path, b''))
                    return
                payload = json.loads(body) if body else {}
                if path == '/adrive/v1.0/user/getDriveInfo':
                    result = {'resource_drive_id': 'resource', 'backup_drive_id': 'backup'}
                elif path == '/adrive/v1.0/openFile/list':
                    result = {'items': fixture.folders[payload['drive_id']], 'next_marker': ''}
                else:
                    action = path.removeprefix('/api/admin/')
                    if action.endswith('/list'):
                        items = fixture.stores if action.startswith('storage') else fixture.users
                        result = {'content': items, 'total': len(items)}
                    elif action == 'storage/get':
                        result = fixture.stores[0]
                    else:
                        fixture.mutations.append((action, payload))
                        if action == 'storage/create':
                            addition = json.loads(payload['addition'])
                            addition['AccessToken'] = fixture.secret
                            payload.update(id=1, disabled=False, addition=json.dumps(addition))
                            fixture.stores.append(payload)
                            result = {'id': 1}
                        elif action == 'storage/update':
                            fixture.stores[0] = payload
                            result = None
                        elif action == 'user/create':
                            fixture.users.append(dict(payload, disabled=False))
                            result = None
                        else:
                            raise AssertionError(action)
                    result = {'code': 200, 'data': result}
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(result).encode())
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def run_bootstrap(self, *extra):
        outer = self
        class RedirectCloud:
            def open(self, req, timeout):
                req.full_url = req.full_url.replace('https://openapi.alipan.com', 'http://127.0.0.1:' + str(outer.server.server_port))
                return outer.opener.open(req, timeout=timeout)
        argv = ['bootstrap', '--data', str(self.data), '--password-file', str(self.data / 'password'),
                '--bootstrap', str(self.data / 'bootstrap.json'), '--port', str(self.server.server_port), '--execute', *extra]
        output = io.StringIO()
        with patch.object(sys, 'argv', argv), patch.object(bootstrap.urllib.request, 'build_opener', return_value=RedirectCloud()), contextlib.redirect_stdout(output):
            bootstrap.main()
        self.assertNotIn(self.secret, output.getvalue())
        return output.getvalue()

    def test_resolve_scope_roundtrip_and_idempotence(self):
        self.assertIn('PASS', self.run_bootstrap())
        self.assertEqual(self.stores[0]['mount_path'], '/paios')
        self.assertEqual(json.loads(self.stores[0]['addition'])['root_folder_id'], 'folder-123')
        count = len(self.mutations)
        self.run_bootstrap()
        self.assertEqual(len(self.mutations), count)
        self.assertEqual(self.objects, {})

    def test_missing_ambiguous_root_and_no_overwrite(self):
        for folders in ({'resource': [], 'backup': []},
                        {'resource': self.folders['resource'], 'backup': self.folders['resource']},
                        {'resource': [{'name': 'Personal-AIOS', 'type': 'folder', 'file_id': 'root'}], 'backup': []}):
            self.folders = folders
            with self.assertRaises(bootstrap.BootstrapError):
                self.run_bootstrap()
            self.assertEqual(self.stores[0]['mount_path'], '/.paios-bootstrap-unresolved')
            self.assertEqual(self.users, [])
        self.stores[0]['mount_path'] = '/paios'
        self.folders = {'resource': [{'name': 'Personal-AIOS', 'type': 'folder', 'file_id': 'other'}], 'backup': []}
        with self.assertRaisesRegex(bootstrap.BootstrapError, 'refusing overwrite'):
            self.run_bootstrap()
        self.assertEqual(json.loads(self.stores[0]['addition'])['root_folder_id'], 'paios-bootstrap-unresolved')

    def test_private_inputs_and_local_staging(self):
        (self.data / 'bootstrap.json').chmod(0o644)
        with self.assertRaisesRegex(bootstrap.BootstrapError, 'owner-only'):
            self.run_bootstrap()
        self.assertEqual(self.stores, [])
        self.assertIn('PASS', self.run_bootstrap('--local-staging', '--local-root', str(self.data)))
        self.assertEqual(self.stores[0]['driver'], 'Local')


    def test_local_root_boundaries(self):
        with self.assertRaisesRegex(bootstrap.BootstrapError, 'non-root'):
            self.run_bootstrap('--local-staging', '--local-root', '/')
        with self.assertRaisesRegex(bootstrap.BootstrapError, 'requires --local-staging'):
            self.run_bootstrap('--local-root', str(self.data))
        self.run_bootstrap('--local-staging', '--local-root', str(self.data))
        other=self.data/'other';other.mkdir()
        with self.assertRaisesRegex(bootstrap.BootstrapError, 'Local root differs'):
            self.run_bootstrap('--local-staging', '--local-root', str(other))


class Render(unittest.TestCase):
    def test_isolated_cold_hosts_and_reserve(self):
        import runpy
        import subprocess
        root = Path(__file__).resolve().parents[2]
        tests = runpy.run_path(str(root / 'tests/hermes/test_cloud_render.py'))
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)
            tests['CloudRenderTests']().copy_renderer(target)
            environment = dict(os.environ, PAIOS_PUBLIC_HOST='stage.example.invalid', PAIOS_PUBLIC_API_URL='',
                               PAIOS_LEGACY_PUBLIC_API_URLS='', PAIOS_LIVEKIT_URL='', PAIOS_LIVEKIT_API_URL='')
            subprocess.run([sys.executable, str(target / 'deploy/cloud/prepare-build.py'), '--config-only'],
                           env=environment, check=True, capture_output=True)
            built = lambda profile: json.loads((target / ('deploy/cloud/.build/' + profile + '.json')).read_text())
            config = built('production')['archive_tiering']
            self.assertEqual(config['cold']['url'], 'http://cold-webdav:5244/dav')
            self.assertEqual((config['hot_days'], config['min_free_bytes'], config['min_free_inodes']), (2, 4294967296, 500000))
            # Staging restores the snapshot's recent L5 closure locally and never tiers to a cold host.
            self.assertNotIn('archive_tiering', built('staging'))


if __name__ == '__main__':
    unittest.main()
