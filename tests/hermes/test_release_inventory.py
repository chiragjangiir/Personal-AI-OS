"""Real inventory envelopes cover changes made after the owner-data snapshot."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'deploy/cloud'))
import release_inventory as inventory


@pytest.fixture
def homes(tmp_path, monkeypatch):
    production, staging = tmp_path / 'production', tmp_path / 'staging'
    for home in (production, staging):
        (home / 'skills').mkdir(parents=True)
    (production / 'config.yaml').write_text('model: production-model\nproviders:\n  secret:\n    api_key: NEVER-TRANSFER\nmcp_servers:\n  custom: {}\n')
    (production / '.env').write_text('NEVER-TRANSFER')
    (production / 'skills/new').mkdir()
    (production / 'skills/new/SKILL.md').write_text('latest installed skill')
    (production / 'plugins/new-plugin').mkdir(parents=True)
    (production / 'plugins/new-plugin/plugin.yaml').write_text('name: new-plugin\nversion: 2\n')
    (production / 'plugins/new-plugin/__init__.py').write_text('raise RuntimeError("plugin must stay dormant")')
    (production / 'plugins/new-plugin/.env').write_text('NEVER-TRANSFER')
    (staging / 'skills/deleted').mkdir()
    (staging / 'skills/deleted/SKILL.md').write_text('older snapshot')
    (staging / '.paios-production-plugins/removed').mkdir(parents=True)
    (staging / 'config.yaml').write_text('model: staging-model\n')
    monkeypatch.setenv('PAIOS_STAGE', 'staging')
    monkeypatch.setattr(os, 'chown', lambda path, uid, gid: None)
    return production, staging


def test_latest_inventory_replaces_old_snapshot_without_model_or_secret(homes, tmp_path):
    production, staging = homes
    archive = tmp_path / 'inventory.tar.gz'
    inventory.pack(production, archive)
    with tarfile.open(archive) as packed:
        members = packed.getnames()
        assert all(Path(name).parts[0] in inventory.ROOTS for name in members)
        assert not any(name.endswith(('.env', 'config.yaml')) for name in members)
        assert b'NEVER-TRANSFER' not in b''.join(packed.extractfile(member).read() for member in packed if member.isfile())
    inventory.install(archive, staging)
    assert (staging / 'skills/new/SKILL.md').read_text() == 'latest installed skill'
    assert not (staging / 'skills/deleted').exists()
    assert not (staging / '.paios-production-plugins/removed').exists()
    assert (staging / '.paios-production-plugins/new-plugin/__init__.py').exists()
    assert not (staging / 'plugins').exists()
    assert json.loads((staging / inventory.ROOTS[2]).read_text()) == {'mcp_servers': ['custom']}
    assert (staging / 'config.yaml').read_text() == 'model: staging-model\n'


@pytest.mark.parametrize('name,kind', [('../escape', 'file'), ('/absolute', 'file'),
                                     ('config.yaml', 'file'), ('skills/link', 'link'),
                                     ('.paios-production-registry.json/extra', 'file')])
def test_unsafe_inventory_rejected_before_install(homes, tmp_path, name, kind):
    archive = tmp_path / 'unsafe.tar.gz'
    with tarfile.open(archive, 'w:gz') as packed:
        member = tarfile.TarInfo(name)
        if kind == 'link':
            member.type, member.linkname = tarfile.SYMTYPE, '/outside'
        packed.addfile(member, io.BytesIO())
    with pytest.raises(ValueError, match='UNSAFE_INVENTORY_MEMBER'):
        inventory.install(archive, homes[1])
    assert (homes[1] / 'skills/deleted/SKILL.md').exists()


def test_install_forbidden_outside_staging(homes, monkeypatch):
    monkeypatch.setenv('PAIOS_STAGE', 'production')
    with pytest.raises(ValueError, match='INVENTORY_INSTALL_REQUIRES_STAGING'):
        inventory.install('/unused', homes[1])


def test_export_uses_readonly_home_and_caches_one_digest(homes, tmp_path, monkeypatch):
    calls = []
    class Stack:
        definition = {'services': {'hermes': {'image': 'sha256:native-fixture'}}}
        def __init__(self, settings):
            assert settings == {'stage': 'production'}
        def volume(self, name):
            assert name == 'hermes-home'
            return 'production-home-volume'
        def tools(self, args, work, mounts, image, entrypoint):
            assert image == self.definition['services']['hermes']['image']
            assert entrypoint == '/opt/hermes/.venv/bin/python'
            assert json.loads(args[-1]) == {'skill_catalog': 'latest-skills', 'package_registry': 'latest-plugins'}
            calls.append((args, mounts))
            inventory.pack(homes[0], work / 'inventory.tar.gz')
    monkeypatch.setattr(inventory, 'Stack', Stack)
    settings = tmp_path / 'settings.json'
    settings.write_text(json.dumps({'stage': 'production'}))
    host = SimpleNamespace(config={'incoming': str(tmp_path / 'incoming'), 'snapshot_settings': str(settings)})
    state = {'skill_catalog': 'latest-skills', 'package_registry': 'latest-plugins'}
    result = inventory.export(host, state)
    assert calls[0][1] == [('production-home-volume', '/source/home:ro')]
    assert (tmp_path / 'incoming' / result['file']).exists()
    original = inventory.hashlib.sha256
    def key_only(*args):
        assert args, 'hashed unchanged artifact'
        return original(*args)
    monkeypatch.setattr(inventory.hashlib, 'sha256', key_only)
    monkeypatch.setattr(inventory, 'Stack', lambda settings: (_ for _ in ()).throw(AssertionError('recaptured cached inventory')))
    assert inventory.export(host, state) == result



def test_package_support_files_preserve_native_catalog_after_install(homes, tmp_path):
    production, staging = homes
    for root in (production / 'skills/new', production / 'plugins/new-plugin/skills/inside'):
        (root / 'references').mkdir(parents=True)
        (root / 'references/config.yaml').write_text('format: supported\n')
        (root / 'references/auth.json').write_text('{"fixture": "public schema"}')
        (root / 'cache').mkdir()
        (root / 'cache/fixture.txt').write_text('package fixture')
        (root / 'run.sh').write_text('#!/bin/sh\nprintf "inventory executable\\n"\n')
        (root / 'run.sh').chmod(0o755)
        (root / '.ignored').write_text('hidden')
        (root / '__pycache__').mkdir()
        (root / '__pycache__/fixture.pyc').write_bytes(b'bytecode')
    def catalog(root):
        return {str(path.relative_to(root)): path.read_bytes() for path in root.rglob('*')
                if path.is_file() and not any(part.startswith('.') or part == '__pycache__'
                                               for part in path.relative_to(root).parts)}
    archive = tmp_path / 'inventory.tar.gz'
    inventory.pack(production, archive)
    inventory.install(archive, staging)
    assert catalog(production / 'skills') == catalog(staging / 'skills')
    assert catalog(production / 'plugins') == catalog(staging / inventory.ROOTS[1])
    for script in (staging / 'skills/new/run.sh', staging / inventory.ROOTS[1] / 'new-plugin/skills/inside/run.sh'):
        assert script.stat().st_mode & 0o777 == 0o700
        assert subprocess.run([str(script)], check=True, capture_output=True, text=True).stdout == 'inventory executable\n'
    assert not (staging / 'skills/deleted').exists()
    assert not (staging / inventory.ROOTS[1] / 'removed').exists()
    assert (staging / 'config.yaml').read_text() == 'model: staging-model\n'


@pytest.mark.parametrize('builtin', [True, False])
def test_inventory_skips_only_image_owned_plugin_symlink(homes, tmp_path, builtin):
    plugins = homes[0] / 'plugins'
    (plugins / ('personal_aios' if builtin else 'external')).symlink_to(
        '/opt/paios/integrations/hermes/personal_aios' if builtin else tmp_path / 'outside', target_is_directory=True)
    archive = tmp_path / 'inventory.tar.gz'
    if builtin:
        inventory.pack(homes[0], archive)
        with tarfile.open(archive) as packed:
            assert not any('personal_aios' in name for name in packed.getnames())
    else:
        with pytest.raises(ValueError, match='NONPORTABLE_INVENTORY_SYMLINK'):
            inventory.pack(homes[0], archive)



def test_native_frozen_inventory_rejects_source_drift_before_caching(homes, tmp_path, monkeypatch):
    import release_identity
    source = Path(os.environ.get('HERMES_NATIVE_SOURCE') or os.environ.get('PAIOS_NATIVE_SOURCE_TEST_ROOT') or
                  Path(__file__).resolve().parents[2] / '.scratch/hermes-composed')
    if not source.is_dir():
        pytest.skip('local composed native source is not present')
    code = release_identity.NATIVE.replace("'/opt/hermes'", repr(str(source)))
    monkeypatch.setattr(release_identity, 'NATIVE', code)
    monkeypatch.setenv('PYTHONPATH', str(source))
    production, staging = homes
    environment = {**os.environ, 'HERMES_HOME': str(production), 'PAIOS_STAGE': 'production',
                   'HERMES_ENABLE_PROJECT_PLUGINS': 'false'}
    observed = json.loads(subprocess.run([sys.executable, '-c', code], env=environment,
        check=True, capture_output=True, text=True).stdout)
    state = {key: observed[key] for key in ('skill_catalog', 'package_registry')}
    valid = tmp_path / 'valid.tar.gz'
    inventory.pack(production, valid, expected=state)
    with tarfile.open(valid) as packed:
        assert b'NEVER-TRANSFER' not in b''.join(packed.extractfile(member).read() for member in packed if member.isfile())
    (production / 'skills/new/SKILL.md').write_text('source changed after identity capture')
    class NativeBoundary:
        definition = {'services': {'hermes': {'image': 'native-fixture'}}}
        def __init__(self, settings): pass
        def volume(self, name): return 'production-home-volume'
        def tools(self, args, work, mounts, **options):
            assert options == {'image': 'native-fixture', 'entrypoint': '/opt/hermes/.venv/bin/python'}
            inventory.pack(production, work / 'inventory.tar.gz', expected=json.loads(args[-1]))
    monkeypatch.setattr(inventory, 'Stack', NativeBoundary)
    settings = tmp_path / 'settings.json'
    settings.write_text('{}')
    incoming = tmp_path / 'incoming'
    host = SimpleNamespace(config={'incoming': str(incoming), 'snapshot_settings': str(settings)})
    with pytest.raises(ValueError, match='INVENTORY_SOURCE_CHANGED'):
        inventory.export(host, state)
    assert not list((incoming / 'sync').glob('inventory-*'))
