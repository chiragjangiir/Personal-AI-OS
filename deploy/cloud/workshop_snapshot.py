"""Broker-owned disk snapshots. Caller serializes acquire/release/reclaim with outputs.lock."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import uuid
from contextlib import nullcontext


def _record(name, info):
    return [name, stat.S_IFMT(info.st_mode), stat.S_IMODE(info.st_mode),
            info.st_size, info.st_ino, info.st_ctime_ns]


def _walk(source, destination=None):
    records = []
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    source = source.resolve()

    def visit(fd, relative):
        records.append(_record(relative, os.fstat(fd)))
        for name in sorted(os.listdir(fd)):
            path = f'{relative}/{name}' if relative else name
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            row = _record(path, info)
            target = destination / path if destination is not None else None
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, flags | os.O_DIRECTORY, dir_fd=fd)
                try:
                    if _record(path, os.fstat(child)) != row:
                        raise RuntimeError(f'workshop changed during snapshot: {path}')
                    if target is not None:
                        target.mkdir(mode=0o700)
                    visit(child, path)
                finally:
                    os.close(child)
            else:
                records.append(row)
                if stat.S_ISREG(info.st_mode):
                    child = os.open(name, flags, dir_fd=fd)
                    try:
                        opened = os.fstat(child)
                        if not stat.S_ISREG(opened.st_mode) or _record(path, opened) != row:
                            raise RuntimeError(f'workshop changed during snapshot: {path}')
                        # Same-length writes can share ctime: identity must include the captured bytes.
                        digest = hashlib.sha256()
                        with os.fdopen(os.dup(child), 'rb') as reader, (
                                target.open('xb') if target is not None else nullcontext()) as writer:
                            remaining = info.st_size
                            while remaining:
                                chunk = reader.read(min(remaining, 1024 * 1024))
                                if not chunk:
                                    raise RuntimeError(f'workshop changed during snapshot: {path}')
                                digest.update(chunk)
                                if writer is not None:
                                    writer.write(chunk)
                                remaining -= len(chunk)
                            if reader.read(1):
                                raise RuntimeError(f'workshop changed during snapshot: {path}')
                        if _record(path, os.fstat(child)) != row:
                            raise RuntimeError(f'workshop changed during snapshot: {path}')
                        row.append(digest.hexdigest())
                        if target is not None:
                            target.chmod(0o444 | (info.st_mode & 0o111))
                    finally:
                        os.close(child)
                elif stat.S_ISLNK(info.st_mode):
                    link = os.readlink(name, dir_fd=fd)
                    row.append(link)
                    resolved = (source / path).resolve()
                    if resolved.is_relative_to(source) and target is not None:
                        # Absolute source links must resolve inside the mounted snapshot too.
                        if os.path.isabs(link):
                            link = os.path.relpath(resolved, (source / path).parent)
                        target.symlink_to(link)
    fd = os.open(source, flags | os.O_DIRECTORY)
    try:
        visit(fd, '')
    finally:
        os.close(fd)
    return records


def _remove(path):
    for base, directories, _ in os.walk(path):
        os.chmod(base, 0o700)
    shutil.rmtree(path)


def reclaim(root):
    """Remove old generations only when no broker or namespace holds their lease."""
    root = Path(root)
    latest = (root / 'latest').read_text() if (root / 'latest').exists() else None
    for abandoned in root.glob('.building-*'):
        _remove(abandoned)
    for generation in root.glob('generation-*'):
        if generation.name == latest:
            continue
        with (generation / 'lease').open('rb') as lease:
            try:
                fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                continue
            _remove(generation)


def acquire(source, root, cap):
    """Return an immutable tree and shared lease fd; fail on mutation or total byte cap."""
    source, root = Path(source), Path(root)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    reclaim(root)
    before = _walk(source)
    latest = (root / 'latest').read_text() if (root / 'latest').exists() else None
    generation = root / latest if latest else None
    retained = sum(json.loads((p / 'bytes').read_text()) for p in root.glob('generation-*'))
    if retained > cap:
        raise RuntimeError(f'workshop snapshot byte cap exceeded: {retained} > {cap}')
    if generation is None or json.loads((generation / 'manifest').read_text()) != before:
        size = sum(row[3] for row in before if row[1] == stat.S_IFREG)
        if size <= cap < size + retained and generation is not None:
            # The cached latest is expendable only when no namespace holds it.
            with (generation / 'lease').open('rb') as lease:
                try:
                    fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    pass
                else:
                    retained -= json.loads((generation / 'bytes').read_text())
                    (root / 'latest').unlink()
                    _remove(generation)
        if size + retained > cap:
            raise RuntimeError(f'workshop snapshot byte cap exceeded: {size + retained} > {cap}')
        candidate = root / f'.building-{uuid.uuid4().hex}'
        candidate.mkdir(mode=0o700)
        try:
            tree = candidate / 'tree'
            tree.mkdir(mode=0o700)
            copied = _walk(source, tree)
            if copied != before or _walk(source) != before:
                raise RuntimeError('workshop changed during snapshot')
            for base, _, _ in os.walk(tree):
                os.chmod(base, 0o555)
            (candidate / 'manifest').write_text(json.dumps(before))
            (candidate / 'bytes').write_text(json.dumps(size))
            (candidate / 'lease').touch(mode=0o600)
            generation = root / f'generation-{uuid.uuid4().hex}'
            candidate.rename(generation)
            (root / '.latest').write_text(generation.name)
            (root / '.latest').replace(root / 'latest')
        finally:
            if candidate.exists():
                _remove(candidate)
    fd = os.open(generation / 'lease', os.O_RDONLY)
    fcntl.flock(fd, fcntl.LOCK_SH)
    reclaim(root)
    return generation / 'tree', fd


def release(root, fd):
    os.close(fd)
    reclaim(root)
