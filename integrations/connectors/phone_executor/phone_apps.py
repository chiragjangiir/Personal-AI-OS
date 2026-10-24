"""Install pinned official APKs, then restore the existing per-app contexts."""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import tempfile
import time
import urllib.request
from pathlib import Path

from agentbay import BWList, ContextSync, DownloadPolicy, SyncPolicy, UploadPolicy, WhiteList
from agentbay.api.models import SyncContextRequest

APP_PACKAGES = ("com.aliyun.tongyi", "com.taobao.taobao", "com.eg.android.AlipayGphone",
                "com.xiaomi.smarthome")
ROOTS = ("/data/data/", "/data/user_de/0/", "/sdcard/Android/data/")
APK_ROOT = "/data/local/tmp/apks"


def _manifest():
    return json.loads(Path(__file__).with_name("phone-apks.json").read_text())


def _filename(entry):
    return entry["package"] + "-" + entry["sha256"][:12] + ".apk"


# Measured Qwen resources regenerate on launch; credential stores stay included.
RESOURCE_EXCLUSIONS = {
    "com.aliyun.tongyi": ("files/pars", "app_u4sdk", "files/dy_lib", "HeatMap",
                          "app_unet_ng", "Cameo", "apollo64", "app_qigsaw"),
    "com.taobao.taobao": (),
    "com.eg.android.AlipayGphone": (),
    "com.xiaomi.smarthome": (),
}


def _context_name(package):
    return os.environ.get("PAIOS_AGENTBAY_CONTEXT_PREFIX", "paios-app-") + package


def _policy(package, root):
    return SyncPolicy(download_policy=DownloadPolicy(auto_download=False),
                      upload_policy=UploadPolicy(auto_upload=False),
                      bw_list=BWList(white_lists=[WhiteList(path="", exclude_paths=[
                          "/" + relative for relative in RESOURCE_EXCLUSIONS[package]
                      ] if root == ROOTS[0] else [])]))


def contexts(client, check, packages=APP_PACKAGES):
    syncs = []
    for package in packages:
        context = check(client.context.get(_context_name(package), create=True)).context
        syncs.extend(ContextSync.new(context.id, root + package, _policy(package, root)) for root in ROOTS)
    cache = check(client.context.get("paios-phone-apks", create=True)).context
    syncs.append(ContextSync(cache.id, APK_ROOT, SyncPolicy(download_policy=DownloadPolicy(auto_download=False),
                                                          upload_policy=UploadPolicy(auto_upload=False)),
                             beta_wait_for_completion=False))
    return syncs


def install(serial, adb, session, packages=APP_PACKAGES, progress=None):
    start = time.monotonic()
    installed = []
    cache_changed = False
    manifest = [entry for entry in _manifest()
                if entry["package"] in packages or entry["package"] not in APP_PACKAGES]
    installed_versions = dict(re.findall(r"^package:(\S+) versionCode:(\d+)$",
                    adb("-s", serial, "shell", "pm list packages --show-versioncode"), re.M))
    adb("-s", serial, "shell", f"mkdir -p {APK_ROOT}")
    for entry in manifest:
        package = entry["package"]
        if package in installed_versions and int(installed_versions[package]) >= entry["version_code"]:
            continue
        if progress:
            progress("install", "started", app=package)
        remote = f"{APK_ROOT}/{_filename(entry)}"
        digest = adb("-s", serial, "shell", f"if [ -f {remote} ]; then sha256sum {remote}; fi")
        if digest.split(" ", 1)[0] != entry["sha256"]:
            cache_changed = True
            if entry.get("transfer") == "gzip":
                with tempfile.TemporaryDirectory() as directory:
                    target = Path(directory) / "app.apk.gz"
                    digest = hashlib.sha256()
                    with urllib.request.urlopen(entry["url"], timeout=120) as response, gzip.open(target, "wb") as output:
                        while chunk := response.read(1024 * 1024):
                            digest.update(chunk)
                            output.write(chunk)
                    if digest.hexdigest() != entry["sha256"]:
                        raise RuntimeError(f"APK content changed; package/signer pin no longer applies: {package}")
                    transfer = session.file_system.upload_file(str(target), remote + ".gz", wait_timeout=120)
                    if not transfer.success:
                        raise RuntimeError(f"AgentBay APK transfer failed for {package}: HTTP {transfer.http_status}")
                adb("-s", serial, "shell", f"gzip -dc {remote}.gz > {remote} && rm {remote}.gz")
            else:
                download = remote + ".download"
                adb("-s", serial, "shell", f"curl -fsSL --max-time 120 '{entry['url']}' -o {download}", timeout=150)
                if "archive_path" in entry:
                    adb("-s", serial, "shell", f"tar -xzOf {download} {entry['archive_path']} > {remote} && rm {download}")
                else:
                    adb("-s", serial, "shell", f"mv {download} {remote}")
            digest = adb("-s", serial, "shell", f"sha256sum {remote}")
            if digest.split(" ", 1)[0] != entry["sha256"]:
                raise RuntimeError(f"APK content changed; package/signer pin no longer applies: {package}")
        output = adb("-s", serial, "shell", f"pm install -r -g {remote}", timeout=120)
        if output != "Success":
            raise RuntimeError(f"APK install failed for {package}: {output}")
        installed.append(package)
        if progress:
            progress("install", "completed", app=package)
    for package in packages:
        adb("-s", serial, "shell", f"am force-stop {package}")
    return {"install_s": round(time.monotonic() - start, 3), "installed": installed, "cache_changed": cache_changed}


def sync_context(session, client, check, context_id, path, mode):
    """Wait for this sync generation; SDK sync() can accept a previous task."""
    def tasks():
        result = check(session.context.info(context_id=context_id, path=path, task_type=mode))
        return [item for item in result.context_status_data
                if item.context_id == context_id and item.path == path and item.task_type == mode]

    previous = max((item.start_time for item in tasks()), default=0)
    if previous > 0:
        time.sleep(1.01)  # SDK 0.22.3 task generations use server Unix seconds.
    response = client.client.sync_context(SyncContextRequest(
        authorization="Bearer " + client.api_key, session_id=session.session_id,
        context_id=context_id, path=path, mode=mode))
    if not response.body.success:
        raise RuntimeError(f"AgentBay {mode} {path}: [{response.body.code}] {response.body.message}")
    deadline = time.monotonic() + 750
    interval = 0.5
    while time.monotonic() < deadline:
        current = [item for item in tasks() if item.start_time > previous]
        if current:
            latest = max(current, key=lambda item: item.start_time)
            if latest.status == "Failed":
                raise RuntimeError(f"AgentBay {mode} {path}: {latest.error_message}")
            if latest.status == "Success":
                return
        time.sleep(min(interval, max(0, deadline - time.monotonic())))
        interval = min(interval * 1.1, 5)
    raise TimeoutError(f"AgentBay {mode} {path}: no completed new sync generation within 750s")


def sync_apps(session, client, check, mode, packages=APP_PACKAGES, progress=None):
    for package in packages:
        context = check(client.context.get(_context_name(package), create=False)).context
        for root in ROOTS:
            path = root + package
            if progress:
                progress(mode, "started " + path, app=package)
            sync_context(session, client, check, context.id, path, mode)
            if progress:
                progress(mode, "completed " + path, app=package)


def repair(serial, adb, packages=APP_PACKAGES):
    for package in packages:
        paths = " ".join(root + package for root in ROOTS)
        adb("-s", serial, "shell", 'test "$(id -u)" = 0 || exit 1; '
            f'uid=$(pm list packages -U --user 0 {package} | sed -n "s/^package:{re.escape(package)} uid://p"); '
            '[ -n "$uid" ] || exit 1; '
            f'for p in {paths}; do if [ -d "$p" ]; then '
            'chown -R "$uid:$uid" "$p" && restorecon -RF "$p" || exit $?; fi; done')
