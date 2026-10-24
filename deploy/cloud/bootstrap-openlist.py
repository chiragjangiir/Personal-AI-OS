#!/usr/bin/env python3
"""Provision a scoped OpenList v4.2.6 cold mount. Offline until --execute."""
import argparse
import base64
import json
import os
from pathlib import Path
import secrets
import sqlite3
import stat
import sys
import urllib.error
import urllib.request
import uuid


class BootstrapError(Exception):
    pass


def require(ok, message):
    if not ok:
        raise BootstrapError(message)


def private(path, owners):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not info.st_mode & 0o077 and info.st_uid in owners,
            'private input must be an owner-only regular file with the expected owner')
    return path.read_text()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--data', required=True)
    p.add_argument('--bootstrap', help='owner-only JSON containing refresh_token; only needed on first creation')
    p.add_argument('--local-staging', action='store_true', help='Local driver at /opt/openlist/data/local-storage; no cloud requests')
    p.add_argument('--local-root', default='/opt/openlist/data/local-storage', help='existing isolated Local staging directory')
    p.add_argument('--password-file', required=True)
    p.add_argument('--port', type=int, default=5244)
    p.add_argument('--delete-bootstrap', action='store_true')
    p.add_argument('--execute', action='store_true')
    a = p.parse_args()
    if not a.execute:
        print('DRY RUN: resolve exactly one /Personal-AIOS; scope /paios and user; scratch PUT/GET/DELETE. No I/O.')
        return
    require(a.local_staging or a.local_root == '/opt/openlist/data/local-storage', '--local-root requires --local-staging')
    if a.local_staging:
        require(Path(a.local_root).is_absolute() and Path(a.local_root).is_dir() and Path(a.local_root).resolve() != Path('/'), 'local staging root must be an existing non-root absolute directory')
    os.umask(0o077)
    data, password_file = Path(a.data), Path(a.password_file)
    config = json.loads(private(data / 'config.json', {os.geteuid(), 1001}))
    require(config['log']['enable'] and config['log']['name'] == '/dev/null', 'set OpenList log enable=true,name=/dev/null before credentials')
    info = (data / 'data.db').lstat()
    require(stat.S_ISREG(info.st_mode) and not info.st_mode & 0o077 and info.st_uid in {os.geteuid(), 1001}, 'OpenList database must be private')
    if password_file.exists() or password_file.is_symlink():
        password = private(password_file, {os.geteuid(), 10000}).strip()
        require(bool(password), 'empty WebDAV password')
    else:
        password = secrets.token_urlsafe(32)
    with sqlite3.connect(f'file:{data / "data.db"}?mode=ro', uri=True) as db:
        row = db.execute("SELECT value FROM x_setting_items WHERE key='token'").fetchone()
    require(row and row[0], 'OpenList admin token not initialized')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    base = 'http://127.0.0.1:' + str(a.port)
    def request(url, body=None, auth=row[0], method=None, json_body=False):
        # Only API calls are typed JSON: OpenList v4.2.6 native_proxy answers a WebDAV GET typed JSON with 403.
        headers = {'Authorization': auth, **({'Content-Type': 'application/json'} if json_body else {})}
        req = urllib.request.Request(url, data=body, method=method, headers=headers)
        with opener.open(req, timeout=300) as response:
            return response.status, response.read()
    def api(path, payload=None):
        result = json.loads(request(base + '/api/' + path, None if payload is None else json.dumps(payload).encode(), json_body=True)[1])
        require(result['code'] == 200, 'OpenList API failed: ' + path.split('?')[0] + '; response omitted')
        return result.get('data')
    def listing(kind):
        items, page = [], 1
        while True:
            batch = api('admin/' + kind + '/list?page=' + str(page) + '&per_page=100')
            items.extend(batch['content'] or [])
            if len(items) >= batch['total']:
                return items
            page += 1
    stores = listing('storage')
    matches = [s for s in stores if s['mount_path'] == '/paios']
    require(len(matches) <= 1, 'ambiguous existing /paios')
    driver = 'Local' if a.local_staging else 'AliyundriveOpen'
    pending = '/.paios-bootstrap-unresolved'
    staged = [s for s in stores if s['mount_path'] == pending]
    require(not (matches and staged) and len(staged) <= 1, 'conflicting bootstrap mount; retain and inspect')
    store = (matches or staged or [None])[0]
    if store:
        require(store['driver'] == driver and not store['disabled'], 'existing mount differs; refusing overwrite')
    elif a.local_staging:
        store = {'mount_path': '/paios', 'driver': driver, 'addition': json.dumps({'root_folder_path': a.local_root, 'thumbnail': False, 'mkdir_perm': '700'}), 'webdav_policy': 'native_proxy', 'disable_index': True}
        store['id'] = api('admin/storage/create', store)['id']
    else:
        require(a.bootstrap, '--bootstrap required for first creation')
        refresh = json.loads(private(Path(a.bootstrap), {os.geteuid()}))['refresh_token']
        require(isinstance(refresh, str) and bool(refresh), 'invalid refresh_token')
        addition = {'refresh_token': refresh, 'root_folder_id': 'paios-bootstrap-unresolved', 'drive_type': 'resource',
                    'remove_way': 'delete', 'use_online_api': True, 'alipan_type': 'default',
                    'api_url_address': 'https://api.oplist.org/alicloud/renewapi'}
        store = {'mount_path': pending, 'remark': 'paios-bootstrap-v1', 'driver': driver, 'addition': json.dumps(addition), 'webdav_policy': 'native_proxy', 'disable_index': True}
        store['id'] = api('admin/storage/create', store)['id']
    store = api('admin/storage/get?id=' + str(store['id']))
    addition = json.loads(store['addition'])
    if a.local_staging:
        require(addition['root_folder_path'] == a.local_root, 'existing Local root differs')
    else:
        access = addition['AccessToken']
        require(bool(access), 'OpenList access token missing; retain bootstrap mount')
        def ali(path, payload):
            result = json.loads(request('https://openapi.alipan.com/' + path, json.dumps(payload).encode(), 'Bearer ' + access, json_body=True)[1])
            require('code' not in result, 'Aliyun discovery failed; response omitted')
            return result
        drives = ali('adrive/v1.0/user/getDriveInfo', {})
        found = []
        for drive_type in ('resource', 'backup'):
            drive_id = drives.get(drive_type + '_drive_id')
            if not drive_id:
                continue
            marker = ''
            while True:
                page = ali('adrive/v1.0/openFile/list', {'drive_id': drive_id, 'parent_file_id': 'root', 'limit': 200, 'marker': marker})
                found.extend((drive_type, f['file_id']) for f in page['items'] if f['name'] == 'Personal-AIOS' and f['type'] == 'folder')
                marker = page.get('next_marker', '')
                if not marker:
                    break
        require(len(found) == 1 and found[0][1] not in ('', 'root', '/'), 'missing, ambiguous or root /Personal-AIOS; no mount promotion')
        drive_type, folder_id = found[0]
        if matches:
            require(addition['root_folder_id'] == folder_id and addition['drive_type'] == drive_type and addition['remove_way'] == 'delete' and store['webdav_policy'] == 'native_proxy', 'existing /paios differs; refusing overwrite')
        else:
            require(store['remark'] == 'paios-bootstrap-v1' and addition['root_folder_id'] == 'paios-bootstrap-unresolved', 'unrecognized bootstrap mount')
            addition.update(root_folder_id=folder_id, drive_type=drive_type)
            store.update(mount_path='/paios', addition=json.dumps(addition))
            api('admin/storage/update', store)
    if not password_file.exists():
        with password_file.open('x') as out:
            out.write(password + '\n')
        if os.geteuid() == 0:
            os.chown(password_file, 10000, 10000)
    permission = (1 << 3) | (1 << 7) | (1 << 8) | (1 << 9)
    users = [u for u in listing('user') if u['username'] == 'paios-archive']
    require(len(users) <= 1, 'ambiguous scoped user')
    if users:
        u = users[0]
        require(u['base_path'] == '/paios' and u['role'] == 0 and u['permission'] == permission and not u['disabled'], 'existing user differs; refusing overwrite')
    else:
        api('admin/user/create', {'username': 'paios-archive', 'password': password, 'base_path': '/paios', 'role': 0, 'permission': permission, 'allow_ldap': False})
    auth = 'Basic ' + base64.b64encode(('paios-archive:' + password).encode()).decode()
    scratch, payload = base + '/dav/l5-smoke-' + uuid.uuid4().hex, secrets.token_bytes(4096)
    require(request(scratch, payload, auth, 'PUT')[0] in (200, 201, 204), 'scratch PUT failed')
    require(request(scratch, auth=auth)[1] == payload, 'scratch GET differs; bootstrap retained')
    require(request(scratch, auth=auth, method='DELETE')[0] == 204, 'scratch DELETE not confirmed')
    try:
        request(scratch, auth=auth)
    except urllib.error.HTTPError as error:
        require(error.code == 404, 'scratch deletion GET failed; expected 404')
    else:
        raise BootstrapError('scratch still readable after deletion')
    if a.delete_bootstrap and a.bootstrap:
        private(Path(a.bootstrap), {os.geteuid()})
        Path(a.bootstrap).unlink()
    print('PASS: drive=' + ('local-staging' if a.local_staging else drive_type) + '; scoped mount=/paios; scratch PUT/GET/DELETE verified; no secrets displayed')


if __name__ == '__main__':
    try:
        main()
    except BootstrapError as error:
        sys.exit("FAIL: " + str(error))
    except (ValueError, KeyError, OSError, sqlite3.Error):
        sys.exit('FAIL: bootstrap could not verify configuration, discovery or WebDAV; private state retained; response omitted')
