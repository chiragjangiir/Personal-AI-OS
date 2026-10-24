"""Portable snapshot contract tests; namespace/mount proof is Linux-only elsewhere."""
import importlib.util
import os
from pathlib import Path
import socket
import stat

import pytest

spec = importlib.util.spec_from_file_location('workshop_snapshot', Path(__file__).parents[2] / 'deploy/cloud/workshop_snapshot.py')
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


@pytest.fixture
def trees(tmp_path):
    source = tmp_path / 'source'
    source.mkdir()
    return source, tmp_path / 'snapshots'


@pytest.fixture
def coarse_timestamps(monkeypatch):
    # Model same-inode, same-length writes within a filesystem timestamp tick.
    for name in ('stat', 'fstat'):
        read = getattr(snapshot.os, name)
        def frozen(*args, _read=read, **kwargs):
            return os.stat_result(_read(*args, **kwargs), {
                'st_mtime': 0, 'st_mtime_ns': 0, 'st_ctime': 0, 'st_ctime_ns': 0})
        monkeypatch.setattr(snapshot.os, name, frozen)


def test_reuse_completed_artifact_and_readonly_inode_isolation(trees):
    source, root = trees
    executable = source / 'run'
    executable.write_text('first')
    executable.chmod(0o755)
    first, fd1 = snapshot.acquire(source, root, 100)
    again, fd2 = snapshot.acquire(source, root, 100)
    assert again == first
    assert (first / 'run').stat().st_ino != executable.stat().st_ino
    assert stat.S_IMODE((first / 'run').stat().st_mode) == 0o555
    assert stat.S_IMODE(first.stat().st_mode) == 0o555
    assert stat.S_IMODE(root.stat().st_mode) == 0o700
    assert (first / 'run').stat().st_uid == os.geteuid()
    executable.write_text('second')
    second, fd3 = snapshot.acquire(source, root, 100)
    assert second != first
    assert (first / 'run').read_text() == 'first'
    assert (second / 'run').read_text() == 'second'
    snapshot.release(root, fd1)
    assert first.exists()
    snapshot.release(root, fd2)
    assert not first.exists()
    snapshot.release(root, fd3)
    assert second.exists()  # latest survives between scopes


def test_internal_symlinks_and_special_files(trees, tmp_path, monkeypatch):
    source, root = trees
    (source / 'nested').mkdir()
    (source / 'nested/file').write_text('inside')
    (source / 'relative').symlink_to('nested/file')
    (source / 'absolute').symlink_to(source / 'nested/file')
    (source / 'outside').symlink_to(tmp_path / 'outside')
    os.mkfifo(source / 'fifo')
    monkeypatch.chdir(source)
    with socket.socket(socket.AF_UNIX) as sock:
        sock.bind('socket')
        tree, fd = snapshot.acquire(source, root, 100)
    assert (tree / 'relative').read_text() == 'inside'
    assert (tree / 'absolute').read_text() == 'inside'
    assert not os.path.isabs(os.readlink(tree / 'absolute'))
    assert not (tree / 'outside').is_symlink()
    assert not (tree / 'fifo').exists()
    assert not (tree / 'socket').exists()
    snapshot.release(root, fd)


def test_fifo_swap_before_open_fails_without_blocking(trees, monkeypatch):
    source, root = trees
    file = source / 'file'
    file.write_text('data')
    original = snapshot.os.open
    swapped = False

    def swap(path, flags, *args, **kwargs):
        nonlocal swapped
        if path == 'file' and not swapped:
            swapped = True
            file.unlink()
            os.mkfifo(file)
            assert flags & os.O_NONBLOCK and flags & os.O_NOFOLLOW
        return original(path, flags, *args, **kwargs)

    monkeypatch.setattr(snapshot.os, 'open', swap)
    with pytest.raises(RuntimeError, match='changed during snapshot'):
        snapshot.acquire(source, root, 100)
    assert not list(root.glob('generation-*'))
    assert not list(root.glob('.building-*'))


def test_directory_swap_cannot_copy_external_data(trees, tmp_path, monkeypatch):
    source, root = trees
    nested = source / 'nested'
    nested.mkdir()
    (nested / 'public').write_text('inside')
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'private').write_text('secret')
    original = snapshot.os.open

    def swap(path, flags, *args, **kwargs):
        if path == 'nested' and nested.is_dir() and not nested.is_symlink():
            nested.rename(source / 'old')
            nested.symlink_to(outside, target_is_directory=True)
        return original(path, flags, *args, **kwargs)

    monkeypatch.setattr(snapshot.os, 'open', swap)
    with pytest.raises(OSError):
        snapshot.acquire(source, root, 100)
    assert not list(root.glob('generation-*'))


def test_cap_preserves_leased_generations_and_reclaims_after_release(trees, coarse_timestamps):
    source, root = trees
    (source / 'file').write_text('1234')
    first, fd1 = snapshot.acquire(source, root, 8)
    (source / 'file').write_text('5678')
    second, fd2 = snapshot.acquire(source, root, 8)
    assert second != first
    assert (first / 'file').read_text() == '1234'
    assert (second / 'file').read_text() == '5678'
    (source / 'file').write_text('abcd')
    with pytest.raises(RuntimeError, match='byte cap exceeded: 12 > 8'):
        snapshot.acquire(source, root, 8)
    assert first.exists() and second.exists()
    snapshot.release(root, fd1)
    assert not first.exists()
    third, fd3 = snapshot.acquire(source, root, 8)
    assert third != second
    snapshot.release(root, fd2)
    snapshot.release(root, fd3)
    assert list(root.glob('generation-*')) == [third.parent]


def test_same_metadata_mutation_during_copy_preserves_existing_lease(trees, coarse_timestamps, monkeypatch):
    source, root = trees
    file = source / 'file'
    file.write_text('1234')
    file.chmod(0o600)
    first, fd = snapshot.acquire(source, root, 100)
    file.write_text('5678')
    file.chmod(0o640)  # Require a new copy even before content identity is fixed.
    walk = snapshot._walk

    def mutate_after_copy(source, destination=None):
        records = walk(source, destination)
        if destination is not None:
            file.write_text('abcd')
        return records

    monkeypatch.setattr(snapshot, '_walk', mutate_after_copy)
    with pytest.raises(RuntimeError, match='changed during snapshot'):
        snapshot.acquire(source, root, 100)
    assert (first / 'file').read_text() == '1234'
    assert (root / 'latest').read_text() == first.parent.name
    assert not list(root.glob('.building-*'))
    assert list(root.glob('generation-*')) == [first.parent]
    snapshot.release(root, fd)


def test_changed_latest_without_leases_can_be_replaced_within_cap(trees):
    source, root = trees
    (source / 'file').write_bytes(b'a' * 150)
    first, fd = snapshot.acquire(source, root, 256)
    snapshot.release(root, fd)
    (source / 'file').write_bytes(b'b' * 151)
    second, fd = snapshot.acquire(source, root, 256)
    assert not first.exists()
    assert (second / 'file').read_bytes() == b'b' * 151
    snapshot.release(root, fd)
    again, fd = snapshot.acquire(source, root, 256)
    assert again == second
    snapshot.release(root, fd)


def test_replacement_budget_preserves_latest_lease_and_oversized_source(trees):
    source, root = trees
    (source / 'file').write_bytes(b'a' * 150)
    first, fd = snapshot.acquire(source, root, 256)
    (source / 'file').write_bytes(b'b' * 151)
    with pytest.raises(RuntimeError, match='301 > 256'):
        snapshot.acquire(source, root, 256)
    assert first.exists()
    snapshot.release(root, fd)
    (source / 'file').write_bytes(b'c' * 257)
    with pytest.raises(RuntimeError, match='byte cap exceeded'):
        snapshot.acquire(source, root, 256)
    assert first.exists()
