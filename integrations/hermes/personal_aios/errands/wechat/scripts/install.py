"""Build the skill's Mac primitives once per source version; never touches the GUI."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time


ROOT = Path(__file__).resolve().parent.parent
ENTRIES = ("activate", "ax-read", "ax-write", "click", "clipboard", "key", "paste", "restore", "screenshot")


def sources(root):
    return sorted([*root.glob("scripts/*.swift"), root / "scripts/install.py",
                   root / "references/wechat-bridge-mac-LICENSE"])


def source_key(root):
    digest = hashlib.sha256()
    for path in sources(root):
        digest.update(path.relative_to(root).as_posix().encode() + b"\0" + path.read_bytes() + b"\0")
    return digest.hexdigest()


def install(root, cache, key):
    started = time.monotonic()
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = cache / key
    with (cache / (key + ".lock")).open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if all((target / name).is_file() and os.access(target / name, os.X_OK) for name in ENTRIES):
            return {"path": str(target), "source_key": key, "compiled": False, "seconds": time.monotonic() - started}
        if source_key(root) != key:
            raise ValueError("Source key differs from the skill manifest; reload the current skill")
        with tempfile.TemporaryDirectory(prefix=".build-", dir=cache) as scratch:
            staged = Path(scratch)
            for source in sources(root):
                dest = staged / source.relative_to(root)
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, dest)
            for name in ENTRIES:
                inputs = [staged / "scripts/Support.swift", staged / f"scripts/{name}.swift"]
                if name.startswith("ax-"):
                    inputs.append(staged / "scripts/AX.swift")
                subprocess.run(["/usr/bin/xcrun", "swiftc", "-module-cache-path", str(staged / "modules"),
                                *map(str, inputs), "-o", str(staged / name)], check=True)
            shutil.rmtree(staged / "modules")
            target.mkdir(mode=0o700, exist_ok=True)
            for name in ENTRIES:
                os.replace(staged / name, target / name)
            for folder in ("scripts", "references"):
                shutil.copytree(staged / folder, target / folder, dirs_exist_ok=True)
    return {"path": str(target), "source_key": key, "compiled": True, "seconds": time.monotonic() - started}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--print-key", action="store_true", help="Release preparation: print the source manifest key")
    parser.add_argument("--key", help="Exact key from references/cache-key.txt")
    parser.add_argument("--cache-root", type=Path, default=Path.home() / "Library/Application Support/PersonalAIOS/wechat")
    args = parser.parse_args()
    if args.print_key:
        print(source_key(ROOT))
    else:
        if not args.key or len(args.key) != 64 or any(c not in "0123456789abcdef" for c in args.key):
            parser.error("--key must be the source manifest's 64 lowercase hex characters")
        os.umask(0o077)
        print(json.dumps(install(ROOT, args.cache_root, args.key)))
