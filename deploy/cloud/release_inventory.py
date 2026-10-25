"""Transfer current installed inventory independently of the older owner-data snapshot."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

from staging_snapshot_stack import Stack

ROOTS = ('skills', '.paios-production-plugins', '.paios-production-registry.json')


def _copy_sources(source, destination, plugins=False):
    source = Path(source)
    if source.is_symlink():
        raise ValueError('NONPORTABLE_INVENTORY_SYMLINK: ' + str(source))
    def ignored(directory, names):
        omitted = {name for name in names if name.startswith('.') or name == '__pycache__'}
        for name in set(names) - omitted:
            path = Path(directory) / name
            if path.is_symlink():
                if (plugins and Path(directory) == source and name == 'personal_aios'
                        and path.resolve() == Path('/opt/paios/integrations/hermes/personal_aios')):
                    omitted.add(name)
                else:
                    raise ValueError('NONPORTABLE_INVENTORY_SYMLINK: ' + str(path))
            elif not path.is_dir() and not path.is_file():
                raise ValueError('NONPORTABLE_INVENTORY_OBJECT: ' + str(path))
        return omitted
    if source.exists():
        shutil.copytree(source, destination, ignore=ignored)
    else:
        Path(destination).mkdir()


def pack(home, archive, expected=None):
    """Carry complete nonhidden package sources, never home configuration or credentials."""
    import yaml
    home, archive = Path(home), Path(archive)
    with tempfile.TemporaryDirectory(dir=archive.parent) as directory:
        inventory = Path(directory)
        _copy_sources(home / 'skills', inventory / 'skills')
        _copy_sources(home / 'plugins', inventory / ROOTS[1], plugins=True)
        config = yaml.safe_load((home / 'config.yaml').read_text())
        (inventory / ROOTS[2]).write_text(json.dumps({'mcp_servers': sorted(config.get('mcp_servers', {}))}))
        if expected is not None:
            from release_identity import NATIVE
            shutil.copyfile(home / 'config.yaml', inventory / 'config.yaml')
            image_plugin = home / 'plugins/personal_aios'
            if image_plugin.is_symlink() and image_plugin.resolve() == Path('/opt/paios/integrations/hermes/personal_aios'):
                (inventory / 'plugins').mkdir()
                (inventory / 'plugins/personal_aios').symlink_to(image_plugin.resolve(), target_is_directory=True)
            environment = {**os.environ, 'HERMES_HOME': str(inventory), 'PAIOS_STAGE': 'staging',
                           'HERMES_ENABLE_PROJECT_PLUGINS': 'false'}
            observed = json.loads(subprocess.run([sys.executable, '-c', NATIVE], env=environment,
                check=True, capture_output=True, text=True).stdout)
            (inventory / 'config.yaml').unlink()
            if any(observed[key] != value for key, value in expected.items()):
                raise ValueError('INVENTORY_SOURCE_CHANGED')
        with tarfile.open(archive, 'w:gz') as target:
            for name in ROOTS:
                target.add(inventory / name, arcname=name)


def export(host, state):
    key = hashlib.sha256(json.dumps({k: state[k] for k in ('skill_catalog', 'package_registry')},
                                    sort_keys=True).encode()).hexdigest()
    relative = 'sync/inventory-' + key + '.tar.gz'
    archive = Path(host.config['incoming']) / relative
    receipt = archive.with_suffix(archive.suffix + '.sha256')
    if archive.exists() and receipt.exists():
        return {'file': relative, 'sha256': receipt.read_text().strip()}
    archive.parent.mkdir(parents=True, exist_ok=True)
    settings = json.loads(Path(host.config['snapshot_settings']).read_text())
    stack = Stack(settings)
    with tempfile.TemporaryDirectory(prefix='inventory-', dir=archive.parent) as directory:
        work = Path(directory)
        stack.tools(['/opt/paios/deploy/cloud/release_inventory.py', 'export', '/source/home',
                     '/work/inventory.tar.gz', json.dumps({key: state[key] for key in ('skill_catalog', 'package_registry')})],
                    work, [(stack.volume('hermes-home'), '/source/home:ro')],
                    image=stack.definition['services']['hermes']['image'], entrypoint='/opt/hermes/.venv/bin/python')
        packed = work / 'inventory.tar.gz'
        digest = hashlib.sha256()
        with packed.open('rb') as stream:
            for block in iter(lambda: stream.read(16 << 20), b''):
                digest.update(block)
        packed.replace(archive)
        receipt.write_text(digest.hexdigest() + '\n')
    return {'file': relative, 'sha256': digest.hexdigest()}


def install(work, home):
    """Replace only staging installed sources, after validating the entire envelope."""
    if os.environ.get('PAIOS_STAGE') != 'staging':
        raise ValueError('INVENTORY_INSTALL_REQUIRES_STAGING')
    home = Path(home)
    with tempfile.TemporaryDirectory(prefix='.inventory-install-', dir=home) as directory:
        temporary = Path(directory)
        seen = set()
        with tarfile.open(work, 'r:gz') as archive:
            for member in archive:
                path = Path(member.name)
                if (path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] not in ROOTS
                        or not (member.isfile() or member.isdir()) or path in seen
                        or path.parts[0] == ROOTS[2] and (len(path.parts) != 1 or not member.isfile())):
                    raise ValueError('UNSAFE_INVENTORY_MEMBER: ' + member.name)
                seen.add(path)
                target = temporary / path
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True, mode=0o700)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    with archive.extractfile(member) as source, target.open('xb') as destination:
                        shutil.copyfileobj(source, destination)
                    target.chmod(0o700 if member.mode & 0o100 else 0o600)
        for name in ROOTS[:2]:
            if not (temporary / name).is_dir():
                raise ValueError('INCOMPLETE_INVENTORY: ' + name)
        names = json.loads((temporary / ROOTS[2]).read_text())['mcp_servers']
        if not isinstance(names, list) or not all(isinstance(name, str) for name in names) or names != sorted(set(names)):
            raise ValueError('INVALID_INVENTORY_MCP_REGISTRY')
        for path in [temporary, *temporary.rglob('*')]:
            os.chown(path, 10000, 10000)
        for name in ROOTS:
            target = home / name
            if target.is_symlink() or target.is_file():
                target.unlink()
            elif target.exists():
                shutil.rmtree(target)
            (temporary / name).replace(target)


if __name__ == '__main__':
    if len(sys.argv) not in (4, 5) or sys.argv[1] not in ('export', 'install') or len(sys.argv) == 5 and sys.argv[1] != 'export':
        raise SystemExit('Usage: release_inventory.py export HOME ARCHIVE [EXPECTED_JSON] | install ARCHIVE HOME')
    if sys.argv[1] == 'export':
        pack(sys.argv[2], sys.argv[3], json.loads(sys.argv[4]) if len(sys.argv) == 5 else None)
    else:
        install(sys.argv[2], sys.argv[3])
