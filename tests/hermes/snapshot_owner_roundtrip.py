"""Isolated Linux/root fixture. No services, retained volumes, credentials or network."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile

if sys.platform != 'linux' or os.geteuid() != 0:
    raise SystemExit('run in an isolated Linux container as root')
repo = Path(os.environ.get('PAIOS_TEST_REPO', '/opt/paios'))
spec = importlib.util.spec_from_file_location('migration', repo / 'deploy/cloud/migrate.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)

with tempfile.TemporaryDirectory(prefix='snap-own-') as temporary:
    base = Path(temporary)
    base.chmod(0o755)
    owner = base / 'owner'
    owner.mkdir(mode=0o755)
    os.chown(owner, 10000, 10000)
    for name in ('state', 'resources', 'central-storage'):
        (owner / name).mkdir()
        os.chown(owner / name, 10000, 10000)
    (owner / 'state/retained.json').write_text('{"owner":"gateway"}')
    output = owner / 'desktop-out'
    output.mkdir(mode=0o711)
    (output / '.issued').mkdir(mode=0o700)
    (output / '.issued/token').write_text('1792100000')
    (output / '.issued/token').chmod(0o600)
    token = output / ('a' * 32)
    token.mkdir(mode=0o755)
    os.chown(token, 20001, 10001)
    (token / 'report.txt').write_text('owner output')
    os.chown(token / 'report.txt', 20001, 10001)
    probe = f"""
import {{RawArchive}} from '{repo}/01-product-half-finished/backend/services/personal-aios-integration/src/archive.ts';
import {{PosixStorage}} from '{repo}/01-product-half-finished/backend/services/personal-aios-integration/src/storage.ts';
import {{promises as fs}} from 'node:fs';
const storage=new PosixStorage(process.argv[1]+'/central-storage'),archive=new RawArchive(storage,4096);
const receipt=await archive.snapshot(true);
if(JSON.parse(await fs.readFile(receipt.consumer_root+'/state/retained.json','utf8')).owner!=='gateway')throw Error('lost state');
if((await fs.readdir(receipt.consumer_root)).includes('desktop-out'))throw Error('crossed owner');
await archive.releaseSnapshot(receipt.snapshot_id);await archive.close();await storage.close();
"""
    subprocess.run(['node', '--input-type=module', '-e', probe, str(owner)], check=True, user=10000, group=10000)
    inbox, workshop = owner / 'desktop-in', base / 'workshop'
    inbox.mkdir(mode=0o755); os.chown(inbox, 10000, 10000)
    (inbox / '.state').mkdir(mode=0o700); os.chown(inbox / '.state', 10000, 10000)
    quota = inbox / '.state/quota.sqlite'
    writer = sqlite3.connect(quota)
    writer.execute('PRAGMA journal_mode=WAL')
    writer.execute('CREATE TABLE days(bytes INTEGER)')
    writer.execute('INSERT INTO days VALUES(123)'); writer.commit()
    os.chown(quota, 10000, 10000); quota.chmod(0o600)
    writer.execute('UPDATE days SET bytes=456')
    for path in quota.parent.iterdir():
        os.chown(path, 10000, 10000)
    workshop.mkdir(); os.chown(workshop, 0, 10001); workshop.chmod(0o2770)
    (workshop / 'notes-journal').write_text('project')
    os.link(workshop / 'notes-journal', workshop / 'second-copy')
    (workshop / 'link').symlink_to('notes-journal')
    for name, source in [('desktop-in', inbox), ('desktop-out', output), ('workshop-data', workshop)]:
        bundle = base / (name + '.tar.gz')
        with bundle.open('wb') as stream:
            migration.archive_online(source, stream, [], owner_volume=True)
        fresh = base / ('fresh-' + name)
        fresh.mkdir()
        subprocess.run(['tar', '-xzpf', str(bundle), '-C', str(fresh), '--numeric-owner'], check=True)
        assert (fresh.stat().st_uid, fresh.stat().st_gid, fresh.stat().st_mode & 0o7777) == (
            source.stat().st_uid, source.stat().st_gid, source.stat().st_mode & 0o7777)
    with sqlite3.connect(base / 'fresh-desktop-in/.state/quota.sqlite') as restored:
        assert restored.execute('SELECT bytes FROM days').fetchone() == (123,)
    assert (base / 'fresh-desktop-in/.state/quota.sqlite').stat().st_uid == 10000
    restored_output = base / 'fresh-desktop-out'
    assert (restored_output / '.issued/token').read_text() == '1792100000'
    assert (restored_output / '.issued').stat().st_mode & 0o777 == 0o700
    assert (restored_output / token.name / 'report.txt').stat().st_uid == 20001
    assert (base / 'fresh-workshop-data/link').read_text() == 'project'
    assert (base / 'fresh-workshop-data/second-copy').read_text() == 'project'
    writer.rollback(); writer.close()
    print(json.dumps({'status':'PASS', 'gateway_protected_mount':True, 'fresh_owner_volumes':3,
                      'quota_committed_only':True, 'numeric_owners_modes':True}))
