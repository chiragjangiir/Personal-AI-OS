"""Rootless namespace launcher. The package sees no owner files, keys or host network."""
import json
import os
from pathlib import Path
import subprocess
import sys

from trace import trace


def main():
    package, scratch, sdk = map(Path, sys.argv[1:4])
    command = json.loads(sys.argv[4])
    dependencies = Path(sys.argv[5]) if len(sys.argv) > 5 else None
    root = scratch / 'root'
    root.mkdir()

    def mount(*args):
        subprocess.run(['/usr/bin/mount', *map(str, args)], check=True, stdout=subprocess.DEVNULL)

    def bind(source, target):
        target = root / target.lstrip('/')
        if source.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.touch()
        mount('--rbind', source, target)
        mount('-o', 'remount,bind,ro,nosuid' + (',dev' if str(source).startswith('/dev/') else ',nodev'), target)

    mount('--make-rprivate', '/')
    mount('-t', 'tmpfs', '-o', 'size=128m,mode=0755,nosuid,nodev', 'tmpfs', root)
    for path in ('/usr', '/lib', '/lib64', '/bin'):
        if Path(path).exists():
            bind(Path(path), path)
    bind(package, '/package')
    bind(sdk, '/opt/yimi/capability')
    if dependencies:
        bind(dependencies, '/opt/deps')
    if command[0] == 'node':
        import shutil
        bind(Path(shutil.which('node')).resolve().parent.parent, '/opt/node')
    for device in ('null', 'urandom'):
        bind(Path('/dev') / device, '/dev/' + device)
    # No proc mount inside the chroot: neither parent fds nor its root are reachable.
    (root / 'work').mkdir()
    fixture = json.loads((scratch / 'fixtures.json').read_text())
    import base64
    for name, value in fixture.items():
        destination = root / 'work' / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(base64.b64decode(value['base64']) if isinstance(value, dict) else value.encode())
    status = trace(command, root, scratch / 'audit.json')
    audit_path = scratch / 'audit.json'
    audit = json.loads(audit_path.read_text())
    artifacts = [path for path in (root / 'work').rglob('*')
                 if path.is_file() and not path.is_symlink() and path.stat().st_size <= 1048576]
    audit['artifacts'] = {path.relative_to(root / 'work').as_posix(): base64.b64encode(path.read_bytes()).decode()
                          for path in artifacts[:16]}
    audit_path.write_text(json.dumps(audit))
    raise SystemExit(status if status >= 0 else 1)


if __name__ == '__main__':
    main()
