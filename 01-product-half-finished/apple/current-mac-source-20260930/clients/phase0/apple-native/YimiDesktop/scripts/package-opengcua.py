#!/usr/bin/env python3
"""Package the pinned SDK, relocatable Python and original signed CuaDriver."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile


WHEEL = "qwen_intelligence_sdk-0.1.2-cp312-cp312-macosx_11_0_arm64.whl"
WHEEL_SHA = "3013502d5dd6afbdeb38372a22e3924d751d9161dbbf20ff6cdaea13177509e0"
SDK_COMMIT = "b753f4c645b499e362d70303c23c26bd4ce24937"
DRIVER_COMMIT = "6d6c734c127025fb39ad5d585a10382808b39dc1"
MACHO = {b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xfe\xed\xfa\xcf"}


def run(*args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def download(path, url, digest, verified_cache=False):
    if path.exists() and verified_cache:
        return path
    if not path.exists():
        partial = path.with_suffix(path.suffix + ".partial")
        with urllib.request.urlopen(url) as response, partial.open("wb") as output:
            shutil.copyfileobj(response, output)
        partial.rename(path)
    with path.open("rb") as source:
        actual = hashlib.file_digest(source, "sha256").hexdigest()
    if actual != digest:
        raise SystemExit(f"Checksum mismatch: {path}")
    return path


def byte_count(root):
    return sum(p.stat().st_size for p in root.rglob("*") if p.is_file() and not p.is_symlink())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--toolchain", type=Path, required=True)
    args = parser.parse_args()
    identity = os.environ.get("EXPANDED_CODE_SIGN_IDENTITY")
    signing_allowed = os.environ.get("CODE_SIGNING_ALLOWED") != "NO"
    if signing_allowed and not identity:
        raise SystemExit("EXPANDED_CODE_SIGN_IDENTITY is required when code signing is enabled")
    toolchain = args.toolchain.resolve()
    source = toolchain / "OpenGCUA"
    cua = toolchain / "cua-source"
    for checkout, expected in ((source, SDK_COMMIT), (cua, DRIVER_COMMIT)):
        actual = subprocess.check_output(["git", "-C", str(checkout), "rev-parse", "HEAD"], text=True).strip()
        if actual != expected:
            raise SystemExit(f"Source pin mismatch: {checkout}")
    lock_path = source / "packages/sdk/adapters/macos/cua-driver.lock.json"
    lock = json.loads(lock_path.read_text())
    cache = toolchain / "packaging"
    cache.mkdir(exist_ok=True)
    archive = download(cache / "cua-driver-0.36.0.tar.gz", lock["archive"]["url"], lock["archive"]["sha256"])
    wheel = download(toolchain / WHEEL,
                     f"https://github.com/Tongyi-MAI/OpenGCUA/releases/download/v0.1.2/{WHEEL}", WHEEL_SHA,
                     verified_cache=True)
    # Reuse the already provisioned managed interpreter without changing its installation.
    existing = toolchain / ".venv/bin/python"
    home = Path(subprocess.check_output([str(existing), "-I", "-B", "-c", "import sys; print(sys.base_prefix)"], text=True).strip())
    if (home / "BUILD").read_text().strip() != "20260414":
        raise SystemExit("Expected python-build-standalone build 20260414")
    version = subprocess.check_output([str(home / "bin/python3.12"), "-I", "-B", "-c",
                                      "import platform; print(platform.python_version(), platform.machine())"], text=True).strip()
    if version != "3.12.13 arm64":
        raise SystemExit(f"Expected Python 3.12.13 arm64, found {version}")
    resources = args.app / "Contents/Resources/opengcua"
    destination = resources / "python"
    helpers = args.app / "Contents/Helpers"
    resources.mkdir(parents=True, exist_ok=True)
    helpers.mkdir(parents=True, exist_ok=True)
    shutil.copy2(Path(__file__).resolve().parents[1] / "Helpers/opengcua/run.py", resources / "run.py")
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(home, destination, symlinks=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    site = destination / "lib/python3.12/site-packages"
    # The SDK has no Python dependencies; exclude copied development/package tooling.
    for relative in ("include", "share", "lib/pkgconfig", "lib/python3.12/site-packages",
                     "lib/python3.12/config-3.12-darwin", "lib/python3.12/ensurepip",
                     "lib/python3.12/idlelib", "lib/python3.12/lib2to3", "lib/python3.12/turtledemo",
                     "lib/python3.12/tkinter", "lib/itcl4.3.5", "lib/tcl9", "lib/tcl9.0",
                     "lib/thread3.0.4", "lib/tk9.0"):
        shutil.rmtree(destination / relative)
    for relative in ("lib/libtcl9.0.dylib", "lib/libtcl9tk9.0.dylib",
                     "lib/python3.12/lib-dynload/_tkinter.cpython-312-darwin.so"):
        (destination / relative).unlink()
    site.mkdir(exist_ok=True)
    (destination / "lib/python3.12/EXTERNALLY-MANAGED").unlink(missing_ok=True)
    with zipfile.ZipFile(wheel) as package:
        package.extractall(site)
    for entry in (destination / "bin").iterdir():
        if entry.name not in {"python", "python3", "python3.12"} and (entry.is_file() or entry.is_symlink()):
            entry.unlink()
    requirement = ('=anchor apple generic and identifier "com.trycua.driver" '
                   'and certificate leaf[subject.OU] = "YCK386LBJ7"')
    target = helpers / "CuaDriver.app"
    with tempfile.TemporaryDirectory(prefix="driver-", dir=cache) as stage:
        with tarfile.open(archive) as package:
            members = package.getmembers()
            if any("perception" in m.name.lower() or "omniparser" in m.name.lower() for m in members):
                raise SystemExit("Unexpected perception asset in pinned CuaDriver archive")
            selected = [m for m in members if "/CuaDriver.app" in m.name
                        or Path(m.name).name in {"LICENSE", "THIRD_PARTY_NOTICES.md"}]
            package.extractall(stage, members=selected, filter="data")
        driver = Path(stage) / "cua-driver-rs-0.36.0-darwin-universal/CuaDriver.app"
        info = plistlib.loads((driver / "Contents/Info.plist").read_bytes())
        if (info["CFBundleIdentifier"], info["CFBundleShortVersionString"]) != ("com.trycua.driver", "0.36.0"):
            raise SystemExit("Pinned CuaDriver bundle version/identifier mismatch")
        run("codesign", "--verify", "--deep", "--strict", "-R", requirement, driver)
        if target.exists():
            shutil.rmtree(target)
        run("ditto", driver, target)
        licenses = resources / "licenses"
        licenses.mkdir(exist_ok=True)
        # Dependency notices: astral-sh/python-build-standalone tag 20260414 (runtime BUILD).
        shutil.copytree(Path(__file__).resolve().parents[1] / "Resources/OpenGCUA-Licenses/Python",
                        licenses / "Python-dependencies", dirs_exist_ok=True)
        for original, name in (
            (source / "LICENSE", "OpenGCUA-Apache-2.0.txt"),
            (source / "packages/sdk/python/mai_ui/THIRD_PARTY_NOTICES.md", "SDK-THIRD_PARTY_NOTICES.md"),
            (cua / "LICENSE.md", "CuaDriver-MIT.txt"),
            (cua / "libs/cua-driver/rust/THIRD_PARTY_NOTICES.md", "CuaDriver-THIRD_PARTY_NOTICES.md"),
            (home / "lib/python3.12/LICENSE.txt", "Python-LICENSE.txt"),
            (lock_path, "cua-driver.lock.json"),
        ):
            shutil.copy2(original, licenses / name)
        # Preserve all release-provided notices outside the unmodified signed bundle.
        for original in Path(stage).rglob("*"):
            if original.is_file() and any(t in original.name.lower() for t in ("license", "notice", "copying")):
                relative = original.relative_to(stage)
                notice = licenses / "driver-release" / relative
                notice.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(original, notice)
    if signing_allowed:
        signing = ["--force", "--sign", identity]
        if identity != "-":
            signing += ["--options", "runtime", "--timestamp"]
        for path in destination.rglob("*"):
            if path.is_symlink() or not path.is_file() or any(p.endswith(".dSYM") for p in path.parts):
                continue
            with path.open("rb") as stream:
                magic = stream.read(4)
            if magic in MACHO:
                run("codesign", *signing, path)
    run(destination / "bin/python3.12", "-I", "-B", "-c",
        "import mai_ui, qwen_intelligence; assert qwen_intelligence.Runtime is mai_ui.Runtime; print('Bundled SDK import OK')")
    run("codesign", "--verify", "--deep", "--strict", "-R", requirement, target)
    print(json.dumps({"python": str(destination / "bin/python3.12"), "driver": str(target),
                      "archive_bytes": archive.stat().st_size, "wheel_bytes": wheel.stat().st_size,
                      "python_sdk_bytes": byte_count(destination), "driver_bytes": byte_count(target),
                      "license_bytes": byte_count(licenses)}))


if __name__ == "__main__":
    main()
