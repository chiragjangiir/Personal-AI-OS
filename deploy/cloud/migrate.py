#!/usr/bin/env python3
"""Explicit snapshot/restore; never stops producers or replaces existing volumes."""
import argparse
import glob
from contextlib import contextmanager
import json
import os
import posixpath
import re
import shlex
from pathlib import Path
import subprocess
import tarfile
import tempfile
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from release_watchdog import compose_files
from staging_snapshot_data import staging_private_path
from staging_model_settings import load_projections, staging_environment


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def prepare_workshop(args):
    """Reserve bounded persistent storage before Docker creates its bind volume."""
    if sys.platform != "linux" or os.geteuid() != 0:
        raise ValueError("prepare-workshop requires root on the Linux deployment host")
    compose = compose_cloud(args, "staging" if args.staging else "production")
    definition = json.loads(run(compose + ["config", "--format", "json"], capture_output=True, text=True).stdout)
    project = definition["name"]
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", project):
        raise ValueError("invalid Compose project identity")
    root = Path("/var/lib/paios") / project
    mount = root / ("workshop-staging" if args.staging else "workshop-production")
    image = mount.with_suffix(".ext4")
    device = str(mount / "data")
    suffix = "-staging" if args.staging else ""
    snapshots = root / ("workshop-snapshots-staging" if args.staging else "workshop-snapshots-production")
    for name, directory in (("workshop-data", mount / "data"), ("desktop-out", mount / "owner-out"),
                            ("workshop-snapshots", snapshots)):
        volume = definition["volumes"][name + suffix]
        options = {"type": "none", "o": "bind", "device": str(directory)}
        if volume.get("driver_opts") != options:
            raise ValueError(f"{name} volume must use local bind options {options}")
        inspected = subprocess.run(["docker", "volume", "inspect", volume["name"]], capture_output=True, text=True)
        if inspected.returncode == 0 and json.loads(inspected.stdout)[0].get("Options") != options:
            raise ValueError(f"existing {name} volume has different options; preserve its data and migrate it explicitly")
    entry = f"{image} {mount} ext4 loop,nodev,nosuid,nofail,x-systemd.before=docker.service 0 2"
    fstab = Path("/etc/fstab")
    original = fstab.read_text()
    existing = [line.strip() for line in original.splitlines()
                if line.strip() and not line.lstrip().startswith("#") and len(line.split()) > 1
                and line.split()[1] == str(mount)]
    if existing and existing != [entry]:
        raise ValueError(f"conflicting fstab entry for {mount}")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    mount.mkdir(exist_ok=True, mode=0o700)
    current = subprocess.run(["findmnt", "--json", "--mountpoint", str(mount), "--output", "SOURCE,FSTYPE,OPTIONS"],
                             capture_output=True, text=True)
    if current.returncode == 0:
        filesystem = json.loads(current.stdout)["filesystems"][0]
        backing = run(["losetup", "--noheadings", "--output", "BACK-FILE", filesystem["source"]],
                      capture_output=True, text=True).stdout.strip()
        if (filesystem["fstype"] != "ext4" or backing != str(image)
                or not {"nodev", "nosuid"} <= set(filesystem["options"].split(","))):
            raise ValueError(f"unexpected mounted filesystem at {mount}")
    elif any(mount.iterdir()):
        # The bind source must never exist underneath the bounded filesystem.
        raise ValueError(f"unmounted workshop directory is not empty: {mount}")
    capacity = 1024 ** 3
    if not image.exists():
        # Allocate upfront; workshop writes cannot later consume PostgreSQL's free space.
        free = os.statvfs(root)
        if free.f_bavail * free.f_frsize < capacity + 1024 ** 3:
            raise ValueError("workshop preparation needs 1 GiB allocation plus 1 GiB host headroom")
        with tempfile.TemporaryDirectory(dir=root) as temporary:
            candidate = Path(temporary) / "workshop.ext4"
            with candidate.open("xb") as stream:
                os.posix_fallocate(stream.fileno(), 0, capacity)
            # Formatting must retain allocation rather than punching discard holes.
            run(["mkfs.ext4", "-q", "-F", "-m", "0", "-E", "nodiscard", str(candidate)])
            candidate.rename(image)
    if image.stat().st_size != capacity:
        raise ValueError(f"existing workshop image is not 1 GiB: {image}")
    if current.returncode != 0:
        run(["mount", "-t", "ext4", "-o", "loop,nodev,nosuid", str(image), str(mount)])
    (mount / "data").mkdir(exist_ok=True, mode=0o700)
    os.chown(mount / "data", 0, 10001)
    (mount / "data").chmod(0o2770)
    (mount / "owner-out").mkdir(exist_ok=True, mode=0o711)
    os.chown(mount / "owner-out", 0, 0)
    (mount / "owner-out").chmod(0o711)
    snapshots.mkdir(exist_ok=True, mode=0o700)
    os.chown(snapshots, 0, 0)
    snapshots.chmod(0o700)
    if not existing:
        with fstab.open("a") as stream:
            stream.write(("" if not original or original.endswith("\n") else "\n") + entry + "\n")
    run(["systemctl", "daemon-reload"])
    print(f"Prepared persistent 1 GiB workshop at {device}; no services restarted")


def snapshot(args):
    root, models, output = map(lambda p: Path(p).resolve(), (args.root, args.models, args.output))
    if output.is_relative_to(root) or output.is_relative_to(models):
        raise ValueError("snapshot output must be outside source runtime/models")
    config = json.loads((root / "mac-product.json").read_text())
    pg = config["product_resources"]["postgres"]
    required = ["hermes-home", "central-storage", "secrets", "resources", "state"]
    for name in required:
        if not (root / name).is_dir():
            raise ValueError(f"missing required directory: {name}")
    if not models.is_dir():
        raise ValueError("models directory is missing")
    selected_secrets = staging_secret_files(root / "secrets") if args.consistency == "staging" else None
    selected_models = sorted(cloud_file_names("${PAIOS_MODEL_ROOT}/")) if args.consistency == "staging" else None
    for filename in selected_models or []:
        if not (models / filename).is_file():
            raise ValueError(f"missing required staging model file: {filename}")
    version = run([args.pg_dump, "--version"], capture_output=True, text=True).stdout
    if " 18." not in version:
        raise ValueError("snapshot requires PostgreSQL 18 pg_dump")
    # No mixed-success bundle is accepted: manifest is written last.
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    with tempfile.TemporaryDirectory(dir=output) as tmp:
        password = Path(pg["password_file"]).read_text().strip()
        if "\n" in password or "\r" in password:
            raise ValueError("invalid PostgreSQL password file format")
        escaped = password.replace("\\", "\\\\").replace(":", "\\:")
        passfile = Path(tmp) / "pgpass"
        passfile.write_text(f'{pg["host"]}:{pg["port"]}:{pg["database"]}:{pg["user"]}:{escaped}\n')
        env = dict(os.environ, PGPASSFILE=str(passfile))
        env.pop("PGPASSWORD", None)
        run([args.pg_dump, "--format=custom", "--no-owner", "--no-acl",
             "--host", pg["host"], "--port", str(pg["port"]), "--username", pg["user"],
             "--dbname", pg["database"], "--file", str(output / "postgres.dump")], env=env)
    omitted = VISUAL_PRIVATE_PATHS if args.consistency == "staging" else []
    for name in required:
        with tarfile.open(output / f"{name}.tar.gz", "w:gz") as archive:
            if name == "secrets" and selected_secrets is not None:
                for filename in selected_secrets:
                    archive.add(root / name / filename, arcname=f"./{filename}")
            else:
                exclusions = [str(Path(path).relative_to(name)) for path in omitted if Path(path).is_relative_to(name)]
                if name == "secrets":
                    exclusions += [str(path.relative_to(root / name)) for path in owner_paths(root / name)
                                   if path.name in PRODUCTION_ONLY_KEYS]
                add_owner_tree(archive, root / name, exclusions,
                    hermes=name == "hermes-home", staging=args.consistency == "staging")
    with tarfile.open(output / "models.tar.gz", "w:gz", dereference=True) as archive:
        if selected_models is None:
            archive.add(models, arcname=".")
        else:
            for filename in selected_models:
                archive.add(models / filename, arcname=f"./{filename}")
    manifest = {"format": 1, "consistency": args.consistency,
                "database": pg["database"], "user": pg["user"], "archives": required + ["models"],
                "excluded_owner_paths": omitted}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    for path in output.iterdir():
        path.chmod(0o600)
    print(f"snapshot ready ({args.consistency}); protected bundle: {output}")


# Relative to owner-data; originals and thumbnails share this directory.
RAW_PHOTOS_PATH = "central-storage/visual-memory/frames"
CALL_TURNS_PATH = "state/call-turns"
VOICEPRINTS_PATH = "central-storage/voiceprints"
ONLINE_PRIVATE_PATHS = [VOICEPRINTS_PATH]
LEGACY_ONLINE_PRIVATE_PATHS = ([RAW_PHOTOS_PATH], [RAW_PHOTOS_PATH, CALL_TURNS_PATH],
                               [RAW_PHOTOS_PATH, CALL_TURNS_PATH, VOICEPRINTS_PATH])
VISUAL_PRIVATE_PATHS = [RAW_PHOTOS_PATH, "central-storage/visual-memory/visual.sqlite",
                        "central-storage/visual-memory/visual.sqlite-wal",
                        "central-storage/visual-memory/visual.sqlite-shm", CALL_TURNS_PATH, VOICEPRINTS_PATH]
CLOUD_ARCHIVES = ["hermes-home", "owner-data", "secrets", "models"]
HERMES_IMAGE_PATHS = ["SOUL.md", "plugins/personal_aios", "workshop/plugins/personal_aios", "cache/vision", "temp_vision_images", ".paios-vision.lock"]
ONLINE_ARCHIVES = ["hermes-home", "owner-data", "secrets"]
# Separate owners/mounts: never discover these by walking owner-data's parent.
OWNER_VOLUMES = ("desktop-in", "desktop-out", "workshop-data")
PRODUCTION_ONLY_KEYS = {"voiceprint.key", "payment-executor.key",
                        "owner-mac", "owner-mac-relay.json", "owner-mac-frps.toml"}


def excluded_owner_path(relative, linkname=None, exclusions=(), hermes=False, staging=False):
    """Image bindings are code; owner links are data and are never dereferenced."""
    relative = Path(relative)
    if staging and staging_private_path(relative):
        return True
    if any(relative.is_relative_to(path) for path in exclusions):
        return True
    if hermes and (any(relative.is_relative_to(path) for path in HERMES_IMAGE_PATHS) or
            staging and (relative.name in (".env", ".op.env") or relative.name.startswith(".env."))):
        return True
    if linkname is not None:
        target = Path(posixpath.normpath(posixpath.join(str(relative.parent), linkname)))
        return (any(target.is_relative_to(path) for path in ("/opt/paios", "/opt/hermes")) or
                hermes and any(target.is_relative_to(path) for path in HERMES_IMAGE_PATHS))
    return False


def owner_paths(source, exclusions=(), hermes=False, staging=False):
    """Walk physical directories only, pruning excluded trees before opening them."""
    source = Path(source)
    def visit(path):
        relative = path.relative_to(source)
        link = path.is_symlink()
        if excluded_owner_path(relative, os.readlink(path) if link else None, exclusions, hermes, staging):
            return
        yield path
        if not link and path.is_dir():
            for child in sorted(path.iterdir()):
                yield from visit(child)
    yield from visit(source)


def add_owner_tree(archive, source, exclusions=(), hermes=False, staging=False):
    for path in owner_paths(source, exclusions, hermes, staging):
        def materialize(member):
            if member.islnk():
                member.type, member.linkname, member.size = tarfile.REGTYPE, '', path.stat().st_size
            return member
        archive.add(path, arcname="./" + path.relative_to(source).as_posix(), recursive=False, filter=materialize)


def owner_contract_script():
    # Host tooling injects this same contract into the existing candidate Python image.
    import inspect
    return ("import os,sys,posixpath,sqlite3,tarfile,tempfile,json;from pathlib import Path\n" +
            "HERMES_IMAGE_PATHS=" + repr(HERMES_IMAGE_PATHS) + "\n" +
            "".join(inspect.getsource(function) for function in
                    (staging_private_path, excluded_owner_path, owner_paths, add_owner_tree)))


def cloud_file_names(prefix):
    config = json.loads(Path(__file__).with_name("cloud.json").read_text())
    def paths(value):
        if isinstance(value, dict):
            return set().union(*(paths(item) for item in value.values()))
        if isinstance(value, list):
            return set().union(*(paths(item) for item in value))
        return {value[len(prefix):]} if isinstance(value, str) and value.startswith(prefix) else set()
    return paths(config)


def staging_secret_names():
    # Every staging credential is provisioned by the destination, never from a production bundle.
    return set()


def staging_secret_files(directory):
    return []


def validate_archive(path, forbidden=(), hermes=False, owner_links=False):
    excluded, links, names = [], set(), {}
    with tarfile.open(path) as archive:
        for member in archive:
            name = Path(member.name)
            if any(name.is_relative_to(item) for item in forbidden):
                raise ValueError("voiceprint templates cannot be restored or exported to cloud")
            if (name.is_absolute() or ".." in name.parts or
                    not (member.isfile() or member.isdir() or owner_links and member.issym())):
                raise ValueError("unsafe archive member")
            if member.issym():
                links.add(name)
            if (name == Path(".") and not member.isdir()) or (name in names and not (member.isdir() and names[name])):
                raise ValueError("unsafe archive member: duplicate path")
            names[name] = member.isdir()
            if excluded_owner_path(name, member.linkname if member.issym() else None, hermes=hermes):
                excluded.append(member.name)
    if any(parent in links for name in names for parent in name.parents):
        raise ValueError("unsafe archive member: child of symlink")
    return excluded


def compose_cloud(args, profile="production"):
    command = ["docker", "compose", "--env-file", args.env_file]
    public_env = Path(args.compose).resolve().parent / ".build/production.public.env"
    if public_env.is_file():
        command += ["--env-file", str(public_env)]
    command += compose_files(args.compose, args.env_file)
    if getattr(args, "archive_compose", None):
        command += ["-f", args.archive_compose]
    return command + ["--profile", profile]


def snapshot_sqlite(source, destination, exclusions, hermes=False):
    source, destination = Path(source), Path(destination)
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    for path in owner_paths(source, exclusions, hermes):
        relative = path.relative_to(source)
        if path.is_symlink() or not path.is_file() or relative.is_relative_to("central-storage/objects"):
            continue
        with path.open("rb") as current:
            if current.read(16) != b"SQLite format 3\0":
                continue
        target = destination / relative
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        origin = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
        origin.execute("PRAGMA query_only=ON")
        copied = sqlite3.connect(target)
        try:
            origin.backup(copied)
            if relative == Path("central-storage/visual-memory/visual.sqlite"):
                if copied.execute("SELECT value FROM meta WHERE key='schema'").fetchone() != ("paios.visual-memory.v2",):
                    raise ValueError("online visual checkpoint requires the current schema")
                legacy = "raw_ref IS NULL AND " if "raw_ref" in {row[1] for row in copied.execute("PRAGMA table_info(frames)")} else ""
                rpo = {"ready": copied.execute("SELECT COUNT(*) FROM frames WHERE state='ready'").fetchone()[0],
                       "ready_without_confirmed_cold": copied.execute(f"SELECT COUNT(*) FROM frames WHERE state='ready' AND {legacy}(cold_ref IS NULL OR cold_confirmed!=1)").fetchone()[0],
                       "indexing": copied.execute("SELECT COUNT(*) FROM frames WHERE state='indexing'").fetchone()[0]}
                (destination / "visual-rpo.json").write_text(json.dumps(rpo))
        finally:
            origin.close(); copied.close()
        target.chmod(0o600)


def archive_online(source, output, exclusions, snapshots=None, archive_snapshot=None, hermes=False, owner_volume=False):
    """DB checkpoints precede file metadata, whose immutable object dependencies copy last."""
    source = Path(source)
    def inventory():
        rows = []
        for path in owner_paths(source, exclusions, hermes):
            info = path.lstat()
            sidecar = next((tail for tail in ('-wal', '-shm', '-journal') if path.name.endswith(tail)), None)
            sqlite_sidecar = False
            database_path = path.with_name(path.name[:-len(sidecar)]) if sidecar else None
            if database_path is not None and not database_path.is_symlink() and database_path.is_file():
                with database_path.open('rb') as database:
                    sqlite_sidecar = database.read(16) == b'SQLite format 3\0'
            if sqlite_sidecar and sidecar == '-shm':
                continue  # SQLite reader marks are not authoritative bytes.
            # SQLite fchown()s an opened WAL even when uid/gid already match.
            fields = ('st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_size', 'st_mtime_ns')
            if not sqlite_sidecar:
                fields += ('st_ctime_ns',)
            rows.append((str(path.relative_to(source)), tuple(getattr(info, field) for field in
                fields)))
        return rows
    before_tree = inventory() if owner_volume else None
    if archive_snapshot is not None:
        # Both trees were captured by the archive authority under one publication fence.
        # Never enumerate live owner files after that cut.
        captured = Path(archive_snapshot)
        with tarfile.open(fileobj=output, mode="w|gz") as archive:
            archive.add(captured / '.consumer-state', arcname='.', filter=lambda member:
                None if excluded_owner_path(member.name, member.linkname if member.issym() else None, exclusions) else member)
            archive.add(captured, arcname='central-storage', filter=lambda member:
                None if Path(member.name).is_relative_to('central-storage/.consumer-state') or
                excluded_owner_path(member.name, member.linkname if member.issym() else None, exclusions) else member)
        return
    with tempfile.TemporaryDirectory(dir=os.environ.get("PAIOS_SNAPSHOT_WORK")) as temporary:
        if snapshots is None:
            snapshots = Path(temporary) / "sqlite"
            snapshot_sqlite(source, snapshots, exclusions, hermes)
        snapshots = Path(snapshots)
        with tarfile.open(fileobj=output, mode="w|gz") as archive:
            if owner_volume:
                archive.add(source, arcname='.', recursive=False)
            def append(paths):
                for path in paths:
                    relative = path.relative_to(source)
                    if any(relative.is_relative_to(item) for item in exclusions):
                        continue
                    sidecar = next((tail for tail in ('-wal', '-shm', '-journal') if path.name.endswith(tail)), None)
                    if (sidecar and (not owner_volume or (snapshots / str(relative)[:-len(sidecar)]).is_file()) or
                            not owner_volume and path.name.startswith('.pending-')):
                        continue
                    if path.is_symlink():
                        archive.add(path, arcname=str(relative), recursive=False)
                        continue
                    if path.is_dir():
                        archive.add(path, arcname=str(relative), recursive=False)
                        continue
                    if not path.is_file():
                        raise ValueError('unsafe snapshot file: ' + str(relative))
                    with path.open("rb") as current:
                        before = os.fstat(current.fileno())
                        if current.read(16) == b"SQLite format 3\0" and not path.is_relative_to(source / "central-storage/objects"):
                            checkpoint = snapshots / relative
                            member = archive.gettarinfo(str(path), arcname=str(relative))
                            member.type, member.linkname = tarfile.REGTYPE, ''
                            member.size = checkpoint.stat().st_size
                            with checkpoint.open('rb') as data:
                                archive.addfile(member, data)
                        else:
                            current.seek(0)
                            member = archive.gettarinfo(str(path), arcname=str(relative))
                            member.type, member.linkname = tarfile.REGTYPE, ''
                            member.size = before.st_size
                            archive.addfile(member, current)
                            after = os.fstat(current.fileno())
                            if after.st_size < before.st_size or (after.st_mtime_ns != before.st_mtime_ns and
                                (after.st_size == before.st_size or path.suffix not in (".jsonl", ".ndjson", ".log"))):
                                raise ValueError("mutable file changed during online copy")
            objects = source / "central-storage/objects"
            append(path for path in owner_paths(source, exclusions, hermes) if path != source and (not path.is_relative_to(objects) or path == objects and path.is_symlink()))
            # FileStorage publishes each immutable object before its stream revision/reference.
            if not objects.is_symlink() and objects.exists():
                append(owner_paths(objects, exclusions))
            if owner_volume and inventory() != before_tree:
                raise ValueError('owner volume changed during snapshot')


def backup_privacy_receipt(path, bundle=None):
    """Certify only a checked new cloud bundle; retries must match that ciphertext."""
    import hashlib
    path = Path(path)
    receipt_path = path.with_name(path.name + '.privacy.json')
    if bundle is not None:
        manifest = json.loads((Path(bundle) / 'manifest.json').read_text())
        if (manifest.get('format'), manifest.get('consistency'), manifest.get('excluded_owner_paths')) != (4, 'online', ONLINE_PRIVATE_PATHS):
            raise ValueError('backup privacy certification requires a format-4 voiceprint-free online bundle')
        validate_archive(Path(bundle) / 'owner-data.tar.gz', [VOICEPRINTS_PATH], owner_links=True)
    elif not receipt_path.is_file():
        raise ValueError('backup privacy receipt missing; encrypted file retained; owner decryption and audit required')
    with path.open('rb') as source:
        receipt = {'schema': 'paios.backup.privacy.v1', 'format': 4,
                   'excluded_owner_paths': ONLINE_PRIVATE_PATHS, 'size': path.stat().st_size,
                   'sha256': hashlib.file_digest(source, 'sha256').hexdigest()}
    if bundle is not None:
        with receipt_path.open('x') as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(json.dumps(receipt) + '\n')
            output.flush(); os.fsync(output.fileno())
    elif json.loads(receipt_path.read_text()) != receipt:
        raise ValueError('backup privacy receipt mismatch; encrypted file retained; no upload attempted')
    return receipt_path


def backup_cloud(args):
    """Source-retaining coherent checkpoints, encryption and independently verified upload."""
    compose = compose_cloud(args)
    definition = json.loads(run(compose + ["config", "--format", "json"], capture_output=True, text=True).stdout)
    destination = Path(args.output).resolve()
    if not args.recipient.startswith("age1"):
        raise ValueError("backup requires an age public recipient")
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    completed_today = False
    for pending in sorted(destination.parent.glob("*.age")):
        upload_backup(args, definition, pending)
        completed_today = completed_today or pending.name == destination.name
    if completed_today:
        print("previous encrypted backup uploaded and confirmed; no duplicate daily snapshot")
        return
    with tempfile.TemporaryDirectory(prefix="paios-backup-", dir=destination.parent) as temp:
        bundle = Path(temp) / "bundle"
        snapshot_cloud(argparse.Namespace(**{**vars(args), "output": str(bundle),
                       "consistency": "online", "exclude_owner_path": [], "encrypted_backup": True}))
        with tarfile.open(bundle / "deployment.tar.gz", "w:gz", dereference=True) as archive:
            archive.add(Path(args.compose).resolve().parent, arcname="cloud", filter=lambda member:
                        None if Path(member.name).name in PRODUCTION_ONLY_KEYS else member)
            archive.add(Path(args.env_file).resolve(), arcname="production.env")
            tls = next(m["source"] for m in definition["services"]["front"]["volumes"]
                       if m["target"] == "/etc/paios-tls")
            archive.add(tls, arcname="tls")
        encrypted = Path(temp) / destination.name
        process = subprocess.Popen(["age", "--recipient", args.recipient, "--output", str(encrypted)], stdin=subprocess.PIPE)
        try:
            with tarfile.open(fileobj=process.stdin, mode="w|") as archive:
                archive.add(bundle, arcname="bundle")
            process.stdin.close()
            if process.wait() != 0:
                raise subprocess.CalledProcessError(process.returncode, process.args)
        except BaseException:
            if process.poll() is None:
                process.kill()
            process.wait()
            raise
        encrypted.chmod(0o600)
        os.chown(encrypted, 10000, 10000)
        receipt = backup_privacy_receipt(encrypted, bundle)
        encrypted.rename(destination)
        receipt.rename(destination.with_name(destination.name + '.privacy.json'))
        directory = os.open(destination.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    upload_backup(args, definition, destination)
    print("online encrypted backup uploaded and confirmed; local encrypted file released")


BACKUP_PART_BYTES = 32 * 1024 * 1024


ARCHIVE_HTTP_BRIDGE = r"""
const chunks=[];let size=0;
for await(const chunk of process.stdin){size+=chunk.length;if(size>64*1024*1024+8192)throw Error('ARCHIVE_REQUEST_TOO_LARGE');chunks.push(chunk);}
const input=Buffer.concat(chunks),split=input.indexOf(10);
if(split<0||split>8192)throw Error('ARCHIVE_REQUEST_HEADER_INVALID');
const request=JSON.parse(input.subarray(0,split).toString()),payload=input.subarray(split+1);
const {loadHostConfiguration}=await import('/opt/paios/01-product-half-finished/backend/services/personal-aios-integration/src/host-configuration.ts');
const config=await loadHostConfiguration('/etc/paios/cloud.json');
const key=(await (await import('node:fs/promises')).readFile(config.internal_key_file,'utf8')).trim();
const {request:send}=await import('node:http');
await new Promise((resolve,reject)=>{
 const pending=send({host:'127.0.0.1',port:config.port,path:request.path,method:request.method,signal:AbortSignal.timeout(300000),
  headers:{Authorization:'Bearer '+key,'Content-Type':'application/octet-stream','Content-Length':payload.length}},response=>{
   if(![200,201].includes(response.statusCode)){response.resume();reject(Error('ARCHIVE_AUTHORITY_HTTP_'+response.statusCode));return;}
   response.on('error',reject);response.on('aborted',()=>reject(Error('ARCHIVE_AUTHORITY_READ_ABORTED')));
   response.pipe(process.stdout,{end:false});response.on('end',resolve);
 });pending.on('error',reject);pending.end(payload);
});
"""


@contextmanager
def archive_request(args, method, path, payload=None):
    """Use the existing private gateway namespace; credentials never leave the container."""
    if getattr(args, 'archive_url', None):
        import urllib.request
        from urllib.parse import urlparse
        if not getattr(args, 'archive_key_file', None):
            raise ValueError('--archive-url requires --archive-key-file')
        base = args.archive_url.rstrip('/')
        if urlparse(base).scheme not in ('http', 'https') or urlparse(base).username:
            raise ValueError('archive URL must be an explicit HTTP authority without credentials')
        token = Path(args.archive_key_file).read_text().strip()
        request = urllib.request.Request(base + path, data=payload, method=method,
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/octet-stream'})
        with urllib.request.urlopen(request, timeout=300) as response:
            yield response
        return
    command = compose_cloud(args) + ['exec', '-T', 'gateway', 'node', '--input-type=module', '-e', ARCHIVE_HTTP_BRIDGE]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
        process.stdin.write(json.dumps({'method': method, 'path': path}).encode() + b'\n')
        if payload is not None:
            process.stdin.write(payload)
        process.stdin.close()
        yield process.stdout
        process.stdout.close()
        if process.wait(timeout=330) != 0:
            raise RuntimeError('private archive authority request failed')
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stdout.close()


def upload_backup(args, definition, path):
    privacy_receipt = backup_privacy_receipt(path)
    import hashlib
    from urllib.parse import quote
    size = path.stat().st_size
    split = size > BACKUP_PART_BYTES
    source_digest = hashlib.sha256()
    parts = []
    with path.open('rb') as source:
        remaining = size
        while remaining or not parts:
            name = f"{path.name}.parts-{len(parts):06d}" if split else path.name
            payload = source.read(min(remaining, BACKUP_PART_BYTES))
            if len(payload) != min(remaining, BACKUP_PART_BYTES):
                raise ValueError("encrypted backup changed during upload; hot backup retained")
            source_digest.update(payload)
            digest = hashlib.sha256(payload).hexdigest()
            route = '/v1/archive/backups/' + quote(name, safe='')
            with archive_request(args, 'PUT', route, payload) as response:
                admitted = json.load(response)
            if admitted != {"name": name, "size": len(payload), "sha256": digest}:
                raise ValueError("archive backup admission mismatch; hot backup retained")
            remote_digest, remote_size = hashlib.sha256(), 0
            with archive_request(args, 'GET', route) as response:
                while chunk := response.read(1024 * 1024):
                    remote_digest.update(chunk)
                    remote_size += len(chunk)
                    if remote_size > len(payload):
                        raise ValueError("archive backup readback size mismatch; hot backup retained")
            if remote_size != len(payload) or remote_digest.hexdigest() != digest:
                raise ValueError("archive backup readback verification failed; hot backup retained")
            parts.append({"name": name, "size": len(payload), "sha256": digest})
            remaining -= len(payload)
        if source.read(1) or path.stat().st_size != size:
            raise ValueError("encrypted backup changed during upload; hot backup retained")
    if split:
        manifest = json.dumps({"schema": "paios.backup.parts.v1", "size": size,
            "sha256": source_digest.hexdigest(), "parts": parts}, separators=(',', ':')).encode()
        name = path.name + '.manifest.json'
        route = '/v1/archive/backups/' + quote(name, safe='')
        with archive_request(args, 'PUT', route, manifest) as response:
            admitted = json.load(response)
        if admitted != {"name": name, "size": len(manifest), "sha256": hashlib.sha256(manifest).hexdigest()}:
            raise ValueError("archive backup manifest admission failed; hot backup retained")
        with archive_request(args, 'GET', route) as response:
            if response.read(len(manifest) + 1) != manifest:
                raise ValueError("archive backup manifest readback failed; hot backup retained")
    path.unlink()
    privacy_receipt.unlink()


def snapshot_cloud(args):
    if args.consistency != 'online':
        return _snapshot_cloud(args)
    if args.exclude_owner_path:
        raise ValueError('complete online snapshots cannot exclude owner originals')
    with archive_request(args, 'POST', '/v1/archive/snapshots', b'') as response:
        snapshot = json.load(response)
    identity = snapshot.get('snapshot_id', '')
    if not re.fullmatch(r'[A-Za-z0-9_-]+', identity):
        raise ValueError('invalid archive snapshot identity')
    retained = False
    try:
        if snapshot.get('schema') != 'paios.archive.snapshot.v1' or not isinstance(snapshot.get('dependency_packs'), list):
            raise ValueError('archive authority returned an incomplete snapshot contract')
        if (snapshot.get('consumer_root') != snapshot.get('root', '') + '/.consumer-state' or
                not isinstance(snapshot.get('consumer_bytes'), int) or snapshot['consumer_bytes'] < 0):
            raise ValueError('archive authority must capture owner consumer state in the same snapshot')
        result = _snapshot_cloud(args, snapshot)
        retained = True
        return result
    finally:
        with archive_request(args, 'DELETE', '/v1/archive/snapshots/' + identity + ('?retain_dependencies=true' if retained else '')) as response:
            response.read()


def _snapshot_cloud(args, archive_snapshot=None):
    if args.consistency == "online" and args.exclude_owner_path:
        raise ValueError("complete online snapshots cannot exclude owner originals")
    exclusions = (VISUAL_PRIVATE_PATHS if args.consistency == "staging" else ONLINE_PRIVATE_PATHS if args.consistency == "online" else []) + args.exclude_owner_path
    for path in exclusions:
        if (not path or Path(path).is_absolute() or ".." in Path(path).parts
                or posixpath.normpath(path) == "." or any(c in path for c in "*?[\\")):
            raise ValueError("owner exclusions must be literal relative paths inside owner-data")
    exclusions = list(dict.fromkeys(posixpath.normpath(path) for path in exclusions))
    compose = compose_cloud(args)
    definition = json.loads(run(compose + ["config", "--format", "json"], capture_output=True, text=True).stdout)
    names = {key: value["name"] for key, value in definition["volumes"].items()}
    services = definition["services"]
    owner_volumes = [name for name in OWNER_VOLUMES if name in names]
    gateway = services['gateway']
    errands = next((m['source'] for m in gateway['volumes']
                   if m['target'] == gateway.get('environment', {}).get('PAIOS_DATA_ROOT', '') + '/state/errands'), None)
    consumer_mounts = ['-v', f'{names[errands]}:/source/state/errands:ro'] if errands else []
    pg = services["postgres"]
    reset_marker = None
    if getattr(args, 'reset_marker', None):
        reset_marker = json.loads(Path(args.reset_marker).read_text())
        if reset_marker.get('schema') != 'paios.conversation-reset.backup.v1' or args.consistency != 'frozen':
            raise ValueError('conversation reset requires its prepared marker and frozen consistency')
        target = reset_marker['target']
        for volume, field in [('owner-data', 'data_root'), ('hermes-home', 'hermes_home')]:
            inspected = json.loads(run(['docker', 'volume', 'inspect', names[volume]], capture_output=True, text=True).stdout)[0]
            if Path(inspected['Mountpoint']).resolve() != Path(target[field]).resolve():
                raise ValueError('reset backup source volume does not match marker')
        if target['postgres_identity'] != {'database': pg['environment']['POSTGRES_DB'], 'user': pg['environment']['POSTGRES_USER']}:
            raise ValueError('reset backup PostgreSQL identity does not match marker')
        endpoint = {'host': 'postgres', 'port': int(pg['command'][pg['command'].index('-p') + 1])}
        if target['postgres_endpoint'] != endpoint:
            raise ValueError('reset backup DSN must target the Compose postgres authority and port')
    port = pg["command"][pg["command"].index("-p") + 1]
    mounted = next(m["source"] for m in services["gateway"]["volumes"]
                   if m["target"] == "/run/secrets/postgres.password")
    secrets = Path(mounted).resolve().parent
    output = Path(args.output).resolve()
    if not secrets.is_dir():
        raise ValueError("source secret directory is missing")
    if output.is_relative_to(secrets):
        raise ValueError("snapshot output must be outside source secrets")
    selected_secrets = staging_secret_files(secrets) if args.consistency == "staging" else None
    selected_models = sorted(cloud_file_names("${PAIOS_MODEL_ROOT}/")) if args.consistency == "staging" else None
    # Inspect first: docker run must never silently create an absent source volume.
    for key in ("hermes-home", "owner-data", *owner_volumes) + (() if args.consistency == "online" else ("models",)):
        run(["docker", "volume", "inspect", names[key]], stdout=subprocess.DEVNULL)
    if errands:
        run(['docker', 'volume', 'inspect', names[errands]], stdout=subprocess.DEVNULL)
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    if args.consistency == "online":
        os.chown(output, 10000, 10000)
    if archive_snapshot is not None:
        import shutil
        # Source sizes include SQLite checkpoints and tar headers; age receives tar directly.
        estimated = archive_snapshot['hot_bytes'] + archive_snapshot['consumer_bytes']
        for name in ('hermes-home', *owner_volumes):
            script = owner_contract_script() + "\nprint(sum((p.lstat().st_size+1024) for p in owner_paths(Path('/source'),hermes=" + repr(name == 'hermes-home') + ")))"
            result = run(['docker','run','--rm','--network','none','--read-only','--user','0:0',
                '-v', f'{names[name]}:/source:ro', services['gateway']['image'],'python3','-c',script], capture_output=True,text=True)
            estimated += int(result.stdout)
        result = run(compose + ['exec','-T','postgres','psql','--tuples-only','--no-align','--port',port,
            '--username',pg['environment']['POSTGRES_USER'],'--dbname',pg['environment']['POSTGRES_DB'],
            '--command','SELECT pg_database_size(current_database())'],capture_output=True,text=True)
        estimated += int(result.stdout.strip())
        roots = [secrets, Path(args.compose).resolve().parent]
        if getattr(args,'encrypted_backup',False):
            roots.append(Path(next(m['source'] for m in services['front']['volumes'] if m['target']=='/etc/paios-tls')))
        for root in roots:
            estimated += sum(p.stat().st_size + 1024 for p in root.rglob('*') if p.is_file())
        required = (2 if getattr(args,'encrypted_backup',False) else 1) * (estimated * 2 + 1024 * 1024)
        if shutil.disk_usage(output).free - required < archive_snapshot['reserve_bytes']:
            with archive_request(args,'POST','/v1/archive/alerts',b'') as response:
                response.read()
            raise ValueError('L5_BACKUP_DISK_RESERVE_EXHAUSTED: insufficient workspace for complete backup')
    with (output / "postgres.dump").open("wb") as dump:
        run(compose + ["exec", "-T", "postgres", "pg_dump", "--format=custom", "--no-owner", "--no-acl",
                       "--port", port, "--username", pg["environment"]["POSTGRES_USER"],
                       "--dbname", pg["environment"]["POSTGRES_DB"]], stdout=dump)
    if args.consistency == "online":
        import inspect
        for name in ("hermes-home", "owner-data", "secrets"):
            if name == "owner-data" and archive_snapshot is not None:
                continue  # The authority already checkpointed the consumer tree.
            omitted = exclusions + ["central-storage"] if name == "owner-data" else HERMES_IMAGE_PATHS
            if name == "secrets":
                omitted = sorted(PRODUCTION_ONLY_KEYS)
            source = str(secrets) if name == "secrets" else names[name]
            script = owner_contract_script() + inspect.getsource(snapshot_sqlite) + \
                     "\nsnapshot_sqlite('/source','/work/sqlite/" + name + "'," + repr(omitted) + ",hermes=" + repr(name == "hermes-home") + ")"
            # Owner backups and private secrets need the same root reader as their archives.
            run(["docker", "run", "--rm", "--network", "none", "--read-only", "--user", "10000:10000" if name == "owner-data" else "0:0",
                 "-v", f"{source}:/source:ro", *(consumer_mounts if name == 'owner-data' else []), "-v", f"{output}:/work", services["gateway"]["image"], "python3", "-c", script])
    snapshot_path = None
    if archive_snapshot is not None:
        data_root = services['gateway']['environment']['PAIOS_DATA_ROOT'].rstrip('/')
        expected = data_root + '/central-storage/.snapshots/' + archive_snapshot['snapshot_id']
        if archive_snapshot['root'] != expected:
            raise ValueError('archive snapshot root differs from configured owner-data authority')
        snapshot_path = '/source/central-storage/.snapshots/' + archive_snapshot['snapshot_id']
    archives = (ONLINE_ARCHIVES if args.consistency == "online" else CLOUD_ARCHIVES) + owner_volumes
    for name in archives:
        if name == 'secrets' and args.consistency == 'staging':
            with tarfile.open(output / 'secrets.tar.gz', 'w:gz'):
                pass
            continue
        source = str(secrets) if name == "secrets" else names[name]
        command = ["docker", "run", "--rm", "--network", "none", "--read-only", "--user", "0:0",
                   "-v", f"{source}:/source:ro", *(consumer_mounts if name == 'owner-data' else []), args.utility_image, "tar", "-czf", "-", "-C", "/source"]
        omitted = exclusions if name == "owner-data" else HERMES_IMAGE_PATHS if name == "hermes-home" else sorted(PRODUCTION_ONLY_KEYS) if name == "secrets" else []
        command += [f"--exclude=./{path}" for path in omitted]
        if name == "hermes-home" and args.consistency == "staging":
            command += ["--exclude=.env", "--exclude=.env.*", "--exclude=.op.env"]
        selected = selected_secrets if name == "secrets" else selected_models if name == "models" else None
        if name == "models" and selected_models is not None:
            command += ["--dereference"]
        with (output / f"{name}.tar.gz").open("wb") as archive:
            if args.consistency == "online":
                import inspect
                script = owner_contract_script() + inspect.getsource(snapshot_sqlite) + inspect.getsource(archive_online) + \
                         "\narchive_online('/source',sys.stdout.buffer," + repr(omitted) + "," + repr(None if name in owner_volumes else '/work/sqlite/' + name) + "," + repr(snapshot_path if name == "owner-data" else None) + ",hermes=" + repr(name == "hermes-home") + ",owner_volume=" + repr(name in owner_volumes) + ")"
                run(["docker", "run", "--rm", "--network", "none", "--read-only", "--user", "0:0",
                     "-e", "PAIOS_SNAPSHOT_WORK=/work", "-v", f"{source}:/source:ro", *(consumer_mounts if name == 'owner-data' else []), "-v", f"{output}:/work",
                     services["gateway"]["image"], "python3", "-c", script], stdout=archive)
            elif name in ("hermes-home", "owner-data", *owner_volumes):
                script = owner_contract_script() + "\nwith tarfile.open(fileobj=sys.stdout.buffer,mode='w|gz') as a: add_owner_tree(a,Path('/source')," + repr(omitted) + ",hermes=" + repr(name == "hermes-home") + ",staging=" + repr(args.consistency == "staging") + ")"
                run(["docker", "run", "--rm", "--network", "none", "--read-only", "--user", "0:0",
                     "-v", f"{source}:/source:ro", *(consumer_mounts if name == 'owner-data' else []), services["gateway"]["image"], "python3", "-c", script], stdout=archive)
            else:
                members = [f"./{filename}" for filename in selected] if selected is not None else ["."]
                run(command + members, stdout=archive)
        validate_archive(output / f"{name}.tar.gz", hermes=name == "hermes-home", owner_links=name in ("hermes-home", "owner-data", *owner_volumes))
    if archive_snapshot is not None:
        verify_snapshot_closure(output / 'owner-data.tar.gz', archive_snapshot)
    rpo = None
    if args.consistency == "online":
        import shutil
        rpo_file = output / "sqlite/owner-data/visual-rpo.json"
        rpo = json.loads(rpo_file.read_text()) if rpo_file.exists() else {"ready": 0, "ready_without_confirmed_cold": 0, "indexing": 0}
        shutil.rmtree(output / "sqlite")
    manifest = {"format": 4 if args.consistency == "online" else 2, "consistency": args.consistency,
                "database": pg["environment"]["POSTGRES_DB"], "user": pg["environment"]["POSTGRES_USER"],
                "archives": archives, "excluded_owner_paths": exclusions}
    if owner_volumes:
        manifest['owner_volumes'] = owner_volumes
    if reset_marker is not None:
        manifest['conversation_reset'] = reset_marker
    if archive_snapshot is not None:
        manifest["raw_archive_snapshot"] = archive_snapshot
    if rpo is not None:
        manifest["visual_image_rpo"] = rpo
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    for path in output.iterdir():
        path.chmod(0o600)
    print(f"snapshot ready ({args.consistency}); protected bundle: {output}")


@contextmanager
def seekable_snapshot(path, reserve_bytes):
    """Inflate once. Revision ancestry checks require random access, not gzip rewinds."""
    import gzip
    import shutil
    with tarfile.open(path) as source:
        source.getmembers()
        required = source.offset + 10240
    if shutil.disk_usage(Path(path).parent).free - required < reserve_bytes:
        raise ValueError('L5_BACKUP_DISK_RESERVE_EXHAUSTED: snapshot verification workspace')
    with tempfile.TemporaryFile(dir=Path(path).parent) as spool:
        with gzip.open(path, 'rb') as source:
            shutil.copyfileobj(source, spool)
        spool.seek(0)
        with tarfile.open(fileobj=spool, mode='r:') as archive:
            yield archive


def verify_snapshot_closure(path, snapshot):
    """Verify the coherent hot cut and its immutable remote version set."""
    if snapshot.get('dependency_mode') != 'remote-versioned':
        raise ValueError('complete snapshot requires versioned remote dependencies')
    dependencies = {}
    for pack in snapshot['dependency_packs']:
        if (not re.fullmatch(r'[a-f0-9]{64}', pack['key']) or
                not isinstance(pack['size'], int) or pack['size'] < 0 or pack['key'] in dependencies):
            raise ValueError('invalid archive snapshot dependency')
        dependencies[pack['key']] = pack['size']
    with seekable_snapshot(path, snapshot.get('reserve_bytes', 0)) as archive, tempfile.TemporaryDirectory() as temporary:
        members = {member.name.removeprefix('./'): member for member in archive}
        cold_records = set()
        with archive.extractfile(members['central-storage/snapshot.json']) as stream:
            if json.load(stream) != snapshot:
                raise ValueError('snapshot receipt differs from archive authority')
        def database(name):
            target = Path(temporary) / Path(name).name
            with archive.extractfile(members[name]) as source, target.open('wb') as output:
                import shutil
                shutil.copyfileobj(source, output)
            return sqlite3.connect(f'file:{target}?mode=ro', uri=True)
        if 'central-storage/cold.sqlite' in members:
            with database('central-storage/cold.sqlite') as db:
                versions = dict(db.execute('SELECT DISTINCT packs.key,packs.size FROM locations JOIN packs ON packs.key=locations.pack'))
                missing = db.execute('SELECT 1 FROM locations LEFT JOIN packs ON packs.key=locations.pack WHERE packs.key IS NULL LIMIT 1').fetchone()
                if missing or versions != dependencies:
                    raise ValueError('snapshot remote dependency set is incomplete')
                if {'namespace', 'key'} <= {row[1] for row in db.execute('PRAGMA table_info(locations)')}:
                    cold_records = set(db.execute('SELECT namespace,key FROM locations'))
        elif dependencies:
            raise ValueError('snapshot cold index is missing')
        def contains(namespace, key):
            member = members.get(f'central-storage/{namespace}/{key}')
            return bool(member and member.isfile()) or (namespace, key) in cold_records
        legacy_revisions = None
        import hashlib
        def digest(value):
            return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        for name, member in members.items():
            if not (name.startswith('state/call-turns/') and name.endswith('.json') and member.isfile()):
                continue
            with archive.extractfile(member) as stream:
                row = json.load(stream)
            if row.get('schema') != 'paios.call-turn.v2':
                continue
            for audio in row['audio']:
                if 'silence_samples' in audio:
                    continue
                event = audio['legacy_original']['event'] if 'legacy_original' in audio else audio['event']
                ref, revision = event['raw_ref'], event['archive_revision']
                if not re.fullmatch(r'l5:[a-f0-9]{64}', ref) or not re.fullmatch(r'[a-f0-9]{64}', revision):
                    raise ValueError('invalid collection archive reference')
                if contains('owner-deletions', ref[3:]):
                    continue  # Preserved deletion intent deliberately makes the raw reference unreadable.
                chunk = audio.get('chunk')
                if chunk:
                    revision, seen, first = event['archive_revision'], set(), True
                    while revision:
                        if revision in seen:
                            raise ValueError('complete backup has a dangling collection stream revision')
                        seen.add(revision)
                        member = members.get('central-storage/stream-revisions/' + revision)
                        if member is None:
                            if ('stream-revisions', revision) in cold_records:
                                break  # Restore authority decodes versioned cold metadata and checks the consumer.
                            if legacy_revisions is None:
                                legacy_revisions = {}
                                for name, candidate in members.items():
                                    if name.startswith('central-storage/stream-revisions/') and candidate.isfile():
                                        with archive.extractfile(candidate) as stream:
                                            encoded = stream.read()
                                            record = json.loads(encoded)
                                        if record.get('schema') == 'paios.stream.v1':
                                            legacy_revisions[hashlib.sha256(encoded).hexdigest()] = candidate
                            member = legacy_revisions.get(revision)
                            if member is None:
                                # Legacy revisions have only numbered slot keys, never digest aliases.
                                if ('stream-revisions', digest([event['raw_ref'], 1])) in cold_records:
                                    break
                                raise ValueError('complete backup has a dangling collection stream revision')
                        with archive.extractfile(member) as stream:
                            encoded = stream.read()
                            record = json.loads(encoded)
                        slot = digest([event['raw_ref'], record['revision']])
                        if (record['raw_ref'] != event['raw_ref'] or not contains('stream-revisions', slot) or
                                hashlib.sha256(encoded).hexdigest() != revision):
                            raise ValueError('invalid collection stream revision')
                        chunks = [record['chunk']] if record['schema'] == 'paios.stream.delta.v2' else record['chunks']
                        if first and not any(all(stored.get(key) == value for key, value in chunk.items()) for stored in chunks):
                            raise ValueError('collection audio chunk differs from pinned stream revision')
                        if any(not contains('objects', stored['object_hash']) for stored in chunks):
                            raise ValueError('complete backup has a dangling collection audio object')
                        revision, first = record['parent'], False
                elif not contains('manifests', ref[3:]) or not contains('objects', event['payload_sha256']):
                    raise ValueError('complete backup has a dangling collection archive reference')
        name = 'central-storage/visual-memory/visual.sqlite'
        if name in members:
            with database(name) as db:
                columns = {row[1] for row in db.execute('PRAGMA table_info(frames)')}
                if 'original' in columns:
                    guard = ' WHERE owner_delete=0' if 'owner_delete' in columns else ''
                    raw = 'raw_ref' if 'raw_ref' in columns else "NULL"
                    for original, reference in db.execute('SELECT original,' + raw + ' FROM frames' + guard):
                        if original:
                            original_path = 'central-storage/visual-memory/' + original
                            if original_path not in members or not members[original_path].isfile():
                                raise ValueError('complete backup is missing a retained legacy original')
                        elif not reference:
                            raise ValueError('complete backup has an unresolved legacy original')


def restore(args):
    bundle = Path(args.bundle).resolve()
    manifest = json.loads((bundle / "manifest.json").read_text())
    projection = load_projections(getattr(args, 'model_settings_projection', None),
                                 getattr(args, 'model_settings_build_projection', None),
                                 getattr(args, 'model_settings_environment', None), args.secrets_dir) if args.staging else None
    dependencies = manifest.get('raw_archive_snapshot', {}).get('dependency_packs', [])
    if dependencies and not getattr(args, 'archive_network', None):
        raise ValueError('remote-versioned restore requires --archive-network to reach configured cold authority')
    allowed = ("staging", "frozen", "online") if args.staging else ("frozen", "online")
    online = manifest['format'] in (3, 4)
    if manifest['format'] == 3 and (not args.staging or manifest.get('excluded_owner_paths') not in LEGACY_ONLINE_PRIVATE_PATHS):
        raise ValueError('legacy format-3 online checkpoints omit originals and are staging-only')
    if manifest['format'] == 4 and (manifest.get('excluded_owner_paths') != ONLINE_PRIVATE_PATHS or
            manifest.get('raw_archive_snapshot', {}).get('schema') != 'paios.archive.snapshot.v1'):
        raise ValueError('complete online restore requires its archive authority snapshot')
    if manifest['format'] == 4 and not args.staging and not manifest['raw_archive_snapshot'].get('consumer_root'):
        raise ValueError('legacy online snapshot lacks a coordinated owner consumer cut and is staging-only')
    if manifest['format'] not in (1, 2, 3, 4) or manifest['consistency'] not in allowed or (manifest['consistency'] == 'online' and not online):
        raise ValueError('restore requires frozen or coherent online checkpoints; staging also accepts staging snapshots')
    if not args.staging and manifest.get('excluded_owner_paths') not in (None, [], ONLINE_PRIVATE_PATHS):
        raise ValueError('excluded owner data is staging-only; production restore requires a complete snapshot')
    owner_volumes = manifest.get('owner_volumes', [])
    if owner_volumes != [name for name in OWNER_VOLUMES if name in owner_volumes]:
        raise ValueError('invalid snapshot owner volume contract')
    expected = (ONLINE_ARCHIVES if online else CLOUD_ARCHIVES if manifest['format'] == 2 else ['hermes-home', 'central-storage', 'secrets', 'resources', 'state', 'models']) + owner_volumes
    if manifest.get("archives") != expected:
        raise ValueError("snapshot archive manifest does not match restore contract")
    compose = compose_cloud(args, "staging" if args.staging else "production")
    suffix = "-staging" if args.staging else ""
    pg_service = "postgres" + suffix
    running = run(compose + ["ps", "--status", "running", "--services"], capture_output=True, text=True)
    if running.stdout.strip():
        raise ValueError("stop all target compose services before restore")
    definition = json.loads(run(compose + ["config", "--format", "json"], capture_output=True, text=True).stdout)
    names = {key: value["name"] for key, value in definition["volumes"].items()}
    if args.staging:
        for key in ('model-settings-authority', 'model-settings-projections'):
            target=definition['volumes'][key+suffix]
            if target['name']==names[key] or target.get('external') or target.get('driver_opts'):
                raise ValueError('Staging requires separate local model-settings volumes')
    volumes = [name + suffix for name in ("postgres", "hermes-home", "owner-data", *owner_volumes)] + ["models"]
    gateway = definition['services']['gateway' + suffix]
    errands = next((m['source'] for m in gateway['volumes']
                   if m['target'] == gateway.get('environment', {}).get('PAIOS_DATA_ROOT', '') + '/state/errands'), None)
    if errands:
        volumes.append(errands)
    for name in owner_volumes:
        options = definition['volumes'][name + suffix].get('driver_opts', {})
        if options:
            directory = Path(options['device'])
            if options.get('type') != 'none' or options.get('o') != 'bind' or not directory.is_dir() or any(directory.iterdir()):
                raise ValueError('restore requires an empty prepared workshop bind: ' + str(directory))
    for key in volumes:
        inspected = subprocess.run(["docker", "volume", "inspect", names[key]], capture_output=True)
        if inspected.returncode == 0:
            raise ValueError(f"volume already exists: {names[key]}; use a new compose project")
    secrets = Path(args.secrets_dir).resolve()
    mounts = definition["services"]["gateway" + suffix]["volumes"]
    mounted = next(m["source"] for m in mounts if m["target"] == "/run/secrets/postgres.password")
    if Path(mounted).resolve().parent != secrets:
        raise ValueError("--secrets-dir must match the selected compose secret mount")
    pg_env = definition["services"][pg_service]["environment"]
    pg_command = definition["services"][pg_service]["command"]
    pg_port = pg_command[pg_command.index("-p") + 1]
    if (pg_env["POSTGRES_USER"], pg_env["POSTGRES_DB"]) != (manifest["user"], manifest["database"]):
        raise ValueError("compose PostgreSQL user/database differs from snapshot")
    if secrets.exists() and not args.staging:
        raise ValueError("secrets destination already exists; use an empty new host directory")
    image_members = {}
    for name in manifest["archives"]:
        image_members[name] = validate_archive(bundle / f"{name}.tar.gz",
                         ([VOICEPRINTS_PATH] if name == "owner-data" else ["voiceprints"] if name == "central-storage" else [])
                         if args.staging or online else [], hermes=name == "hermes-home",
                         owner_links=name in ("hermes-home", "owner-data", "central-storage", "resources", "state", *owner_volumes))
    if manifest['format'] == 4:
        verify_snapshot_closure(bundle / 'owner-data.tar.gz', manifest['raw_archive_snapshot'])
    if args.staging:
        for name in manifest['archives']:
            with tarfile.open(bundle / f'{name}.tar.gz') as archive:
                image_members[name] += [member.name.removeprefix('./') for member in archive
                                        if staging_private_path(member.name)]
    try:
        for key in volumes:
            options = definition['volumes'][key].get('driver_opts', {})
            run(["docker", "volume", "create", *[part for k, v in options.items() for part in ('--opt', f'{k}={v}')], names[key]], stdout=subprocess.DEVNULL)
        owner_archives = ["owner-data"] if manifest["format"] in (2, 3, 4) else ["central-storage", "resources", "state"]
        for key, archives in [("hermes-home", ["hermes-home"]), ("owner-data", owner_archives),
                              ("models", ["models"] if "models" in manifest["archives"] else []),
                              *[(name, [name]) for name in owner_volumes]]:
            commands = []
            for name in archives:
                dest = f"/restore/{name}" if key == "owner-data" and manifest["format"] == 1 else "/restore"
                omitted = "".join(" --exclude=" + shlex.quote(glob.escape(path)) for path in image_members[name])
                flags = '-xzpf' if key in owner_volumes else '-xzf'
                numeric = ' --numeric-owner' if key in owner_volumes else ''
                commands.append(f"mkdir -p {dest}; tar {flags} /bundle/{name}.tar.gz -C {dest}{numeric}{omitted}")
            run(["docker", "run", "--rm", "--network", "none", "--user", "0:0",
                 "-v", f"{names[key + suffix if key != 'models' else key]}:/restore",
                 *(['-v', f'{names[errands]}:/restore/state/errands'] if key == 'owner-data' and errands else []),
                 "-v", f"{bundle}:/bundle:ro", args.utility_image,
                 "sh", "-ec", "; ".join(commands + ([] if key in owner_volumes else ["chown -R 10000:10000 /restore"]))])
        if not args.staging:
            secrets.mkdir(mode=0o700)
            with tarfile.open(bundle / "secrets.tar.gz") as archive:
                archive.extractall(secrets, filter="data")
            for path in secrets.rglob("*"):
                path.chmod(0o700 if path.is_dir() else 0o600)
                identity = 1001 if path.relative_to(secrets).is_relative_to('openlist') else 10000
                os.chown(path, identity, identity)
            os.chown(secrets, 10000, 10000)
        else:
            run(['docker', 'run', '--rm', '--interactive', '--network', 'none', '--user', '0:0',
                 '-v', f"{names['hermes-home' + suffix]}:/restore",
                 '-v', f"{names['model-settings-projections' + suffix]}:/restore-projections",
                 '-v', str(Path(__file__).resolve().parent) + ':/opt/paios/deploy/cloud:ro',
                 gateway['image'], 'python3', '/opt/paios/deploy/cloud/staging_model_settings.py',
                 '-', '/restore', '/restore-projections'], input=json.dumps(projection), text=True)
        if manifest['format'] == 4:
            gateway = definition['services']['gateway' + suffix]
            config = next(m['source'] for m in gateway['volumes'] if m['target'] == '/etc/paios/cloud.json')
            data_root = gateway['environment']['PAIOS_DATA_ROOT']
            command = ['docker', 'run', '--rm', '--network', args.archive_network if dependencies else 'none', '--read-only', '--user', '10000:10000',
                '--memory', '512m', '--memory-swap', '512m', '--cpus', '1',
                '-v', f"{names['owner-data' + suffix]}:{data_root}", '-v', f'{config}:/etc/paios/cloud.json:ro']
            scoped_password = secrets / 'cold-webdav.password'
            if scoped_password.exists():
                command += ['-v', str(scoped_password) + ':' + gateway['environment']['PAIOS_SECRET_ROOT'] + '/cold-webdav.password:ro']
            for key, value in gateway['environment'].items():
                command += ['-e', f'{key}={value}']
            command += [gateway['image'], 'node',
                '/opt/paios/01-product-half-finished/backend/services/personal-aios-integration/tools/turn-eval.ts',
                '--restore-archive', '/etc/paios/cloud.json']
            run(command)
        run(compose + ["up", "-d", "--wait", pg_service])
        # PG18 initializes /var/lib/postgresql/18/docker; never copy the Mac pgdata tree.
        with (bundle / "postgres.dump").open("rb") as dump:
            run(compose + ["exec", "-T", pg_service, "pg_restore", "--exit-on-error", "--no-owner", "--no-acl",
                           "--port", pg_port, "--username", manifest["user"], "--dbname", manifest["database"]], stdin=dump)
    except Exception as error:
        target = ', '.join(names[key] for key in volumes)
        raise RuntimeError(
            f'Restore failed after target creation began. Target volumes are preserved and may be partial: {target}. '
            f'Secrets are preserved at {secrets} if created; bundle is preserved at {bundle}. '
            f'{pg_service} may already be running. Restore has not started gateway/Hermes/ingress; keep them stopped. '
            'Preserve this target for inspection and repair the reported cause, then retry with a different '
            'COMPOSE_PROJECT_NAME and a new --secrets-dir matching newly rendered Compose secret mounts. '
            'Do not reuse or delete this partial target until replacement recovery is accepted.'
        ) from error
    print(f"restored fresh volumes; {pg_service} only is running; gateway/Hermes remain stopped")


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    workshop = sub.add_parser("prepare-workshop", help="reserve and mount persistent 1 GiB workshop storage on Linux")
    workshop.add_argument("--compose", required=True)
    workshop.add_argument("--env-file", required=True)
    workshop.add_argument("--staging", action="store_true")
    snap = sub.add_parser("snapshot")
    snap.add_argument("--root", required=True)
    snap.add_argument("--models", required=True)
    snap.add_argument("--output", required=True)
    snap.add_argument("--pg-dump", required=True)
    snap.add_argument("--consistency", choices=["staging", "frozen"], default="staging",
                      help="frozen asserts ALL Mac writers have already been stopped by owner")
    cloud = sub.add_parser("snapshot-cloud", help="read production Compose volumes and pg_dump; starts no services")
    cloud.add_argument("--compose", required=True)
    cloud.add_argument("--env-file", required=True)
    cloud.add_argument("--output", required=True)
    cloud.add_argument("--utility-image", default="alpine:3.22")
    cloud.add_argument('--reset-marker', help='bind a prepared offline conversation-reset marker to the frozen source volumes')
    cloud.add_argument("--exclude-owner-path", action="append", default=[],
                       help="additional relative owner-data exclusion; staging also excludes visual private stores")
    cloud.add_argument("--consistency", choices=["staging", "frozen", "online"], default="staging",
                       help="staging is a live test copy; online uses SQLite/PG checkpoints; frozen asserts all writers stopped")
    backup = sub.add_parser("backup-cloud", help="online SQLite/PG checkpoints, age encryption and verified HTTP archive copy")
    backup.add_argument("--compose", required=True)
    backup.add_argument("--archive-compose")
    backup.add_argument("--env-file", required=True)
    backup.add_argument("--output", required=True)
    backup.add_argument("--recipient", required=True)
    backup.add_argument("--utility-image", default="alpine:3.22")
    for command in (cloud, backup):
        command.add_argument("--archive-url", help="optional host-reachable private RawArchive HTTP authority; default uses gateway Docker exec")
        command.add_argument("--archive-key-file", help="private integration bearer token file")
    target = sub.add_parser("restore")
    target.add_argument("--bundle", required=True)
    target.add_argument("--compose", required=True)
    target.add_argument("--env-file", required=True)
    target.add_argument("--secrets-dir", required=True)
    target.add_argument("--archive-network", help="existing private Docker network reaching the configured cold archive; required for remote-versioned dependencies")
    target.add_argument("--staging", action="store_true", help="restore isolated staging volumes; never starts production")
    target.add_argument('--model-settings-environment', type=staging_environment, metavar='staging-NAME')
    target.add_argument('--model-settings-projection', help='target authority projection inside --secrets-dir')
    target.add_argument('--model-settings-build-projection', help='target workshop authority projection inside --secrets-dir')
    target.add_argument("--utility-image", default="alpine:3.22")
    args = parser.parse_args()
    {"snapshot": snapshot, "snapshot-cloud": snapshot_cloud, "restore": restore,
     "backup-cloud": backup_cloud, "prepare-workshop": prepare_workshop}[args.command](args)


if __name__ == "__main__":
    main()
