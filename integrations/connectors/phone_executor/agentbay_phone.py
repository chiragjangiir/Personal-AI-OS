"""AgentBay phone leases; app contexts own persistent data, the state file owns one session."""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

os.environ.setdefault("AGENTBAY_LOG_FILE", os.devnull)
from agentbay import AgentBay, AgentBayLogger, CreateSessionParams, LifecyclePolicy
import phone_apps
from phone_apps import APP_PACKAGES

AgentBayLogger.setup(enable_console=False, enable_file=False)  # SDK INFO logs include session access tokens.

MAX_RUNTIME_MIN = 60
_client = None
_progress = {"stage": "closed", "summary": "云手机已关闭", "since": time.time(), "view_url": None}


def progress(stage, summary, **fields):
    global _progress
    if stage != _progress["stage"] or "app" in fields and fields["app"] != _progress.get("app"):
        fields.setdefault("since", time.time())
        fields.setdefault("error", None)
    _progress = {**_progress, "stage": stage, "summary": summary, **fields}


def status():
    snapshot = _progress
    return {**{k: v for k, v in snapshot.items() if k != "since"},
            "elapsed_s": round(time.time() - snapshot["since"], 1)}


def _check(result):
    if not result.success:
        raise RuntimeError(f"AgentBay: {result.error_message}")
    return result


@dataclass
class CloudPhone:
    session_id: str
    serial: str
    _session: object = field(init=False, repr=False, default=None)
    _purpose: str = field(init=False, repr=False, default="errand")
    _heartbeat: asyncio.Task | None = field(init=False, repr=False, default=None)
    _created_at: float = field(init=False, repr=False, default_factory=time.time)
    _ready: bool = field(init=False, repr=False, default=False)
    _image: str = field(init=False, repr=False, default_factory=lambda: os.environ.get("PAIOS_AGENTBAY_IMAGE", "mobile-use-android-12"))
    _partial: set = field(init=False, repr=False, default_factory=set)
    timings: dict = field(init=False, default_factory=dict)

    def view_url(self) -> str:
        return _check(self._session.info()).data.resource_url


def _state() -> Path:
    return Path(os.environ["PAIOS_AGENTBAY_STATE"]).expanduser()


def _record(phone, ready=False):
    path = _state()
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    with open(temp, "w", opener=lambda p, flags: os.open(p, flags, 0o600)) as stream:
        json.dump(dict(session_id=phone.session_id, serial=phone.serial, purpose=phone._purpose,
                       ready=ready, created_at=phone._created_at, image_id=phone._image,
                       partial=sorted(phone._partial)), stream)
        stream.flush()
        os.fsync(stream.fileno())
    temp.replace(path)


def _adb(*args, timeout=30):
    return subprocess.run([os.environ.get("PAIOS_ADB", "adb"), *args], stdin=subprocess.DEVNULL, capture_output=True, text=True,
                          check=True, timeout=timeout,
                          env=os.environ | {"ADB_VENDOR_KEYS": os.environ["PAIOS_AGENTBAY_ADBKEY"]}).stdout.strip()


def _forget(phone):
    path = _state()
    if path.exists() and json.loads(path.read_text())["session_id"] == phone.session_id:
        path.unlink()
        if phone.serial:
            # Cleanup only: adb no longer knowing the serial (expired session, restarted adb server) must not fail the
            # lease that is replacing this phone.
            with contextlib.suppress(subprocess.CalledProcessError, subprocess.TimeoutExpired):
                _adb("disconnect", phone.serial)


def session_exists(phone):
    """Query the exact owned session, including deletion that succeeded despite a lost response."""
    result = _client.get(phone.session_id)
    if not result.success and result.code == "InvalidMcpSession.NotFound":
        _forget(phone)
        return False
    phone._session = _check(result).session
    status = phone._session.get_status()
    if (not status.success and status.code == "InvalidMcpSession.NotFound") or (status.success and status.status == "FINISH"):
        _forget(phone)
        return False
    _check(status)
    return True


def _dispose(phone, keep_warm=False, sync=True):
    if phone._purpose == "login" and not session_exists(phone):
        progress("closed", "云手机已关闭", view_url=None)
        return
    # SDK 0.22.3 deletes even after a failed sync. Require a successful upload first.
    if sync and phone._purpose == "errand" and phone._ready:
        if phone._partial:
            raise RuntimeError("App 恢复未完成，不能覆盖已保存的数据")
        progress("saving", "正在保存办事 App 数据")
        phone_apps.sync_apps(phone._session, _client, _check, "upload")
    if keep_warm:
        _check(phone._session.keep_alive())
        progress("ready", "云手机已就绪")
        return
    _check(_client.delete(phone._session, sync_context=False))
    _forget(phone)
    progress("closed", "云手机已关闭", view_url=None)


def _connect(phone, ready=False):
    public_key = Path(os.environ["PAIOS_AGENTBAY_ADBKEY"] + ".pub").read_text().strip()
    command = _check(phone._session.mobile.get_adb_url(public_key)).data
    match = re.fullmatch(r"adb connect ([\w.-]+:\d+)", command.strip())
    if not match:
        raise ValueError("AgentBay returned an invalid adb target")
    phone.serial = match[1]
    _record(phone, ready=ready)
    _adb("connect", phone.serial)
    _adb("-s", phone.serial, "wait-for-device", timeout=60)
    _adb("-s", phone.serial, "shell", 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 1; done', timeout=60)


def _recorded():
    """The session a previous lease recorded (this or an earlier process), or None once AgentBay no longer has it."""
    global _client
    if _client is None:
        _client = AgentBay(api_key=Path(os.environ["PAIOS_AGENTBAY_KEY_FILE"]).read_text().strip())
    state = _state()
    if not state.exists():
        return None
    record = json.loads(state.read_text())
    phone = CloudPhone(record["session_id"], record.get("serial", ""))
    if not session_exists(phone):
        return None
    phone._purpose = record.get("purpose", "errand")
    phone._created_at = record.get("created_at", 0)
    phone._ready = bool(record.get("ready"))
    phone._image = record.get("image_id", "")
    phone._partial = set(record.get("partial", []))
    return phone


def _lease(purpose, extra_budget_s=0):
    budget = int(os.environ.get("PAIOS_PHONE_TASK_TIMEOUT", "600")) + 60 + extra_budget_s
    if purpose not in ("errand", "login") or purpose == "errand" and budget >= MAX_RUNTIME_MIN * 60:
        raise ValueError("purpose must be errand or login; errand timeout must fit the 60-minute lifecycle")
    start = time.monotonic()
    progress("creating", "正在启动云手机", since=time.time(), view_url=None, error=None, app=None)
    image = os.environ.get("PAIOS_AGENTBAY_IMAGE", "mobile-use-android-12")
    phone = _recorded()
    if phone is not None:
        status = _check(phone._session.get_status()).status
        if (phone._image == image and phone._ready and purpose == phone._purpose == "errand" and status == "RUNNING"
                and time.time() + budget < phone._created_at + MAX_RUNTIME_MIN * 60):
            try:
                _connect(phone, ready=True)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                pass  # A running but unreachable phone must be deleted before replacement.
            else:
                _check(phone._session.keep_alive())
                progress("ready", "云手机已就绪", view_url=phone.view_url())
                return phone
        _dispose(phone, sync=phone._ready)
    syncs = phone_apps.contexts(_client, _check)
    policy = LifecyclePolicy(manual_release=True) if purpose == "login" else LifecyclePolicy(idle_release_timeout=10, max_runtime=MAX_RUNTIME_MIN)
    create_started = time.monotonic()
    session = _check(_client.create(CreateSessionParams(image_id=image,
                                                       context_syncs=syncs[-1:], lifecycle_policy=policy))).session
    phone = CloudPhone(session.session_id, "")
    phone._session, phone._purpose = session, purpose
    try:
        _record(phone)  # Record before adb/repair so a restart can recover or delete it.
        progress("installing", "云手机可控制，正在准备 App", view_url=phone.view_url())
        # Only APKs are bound before installation; app data must not restore into uninstalled packages.
        phone_apps.sync_context(session, _client, _check, syncs[-1].context_id, phone_apps.APK_ROOT, "download")
        _connect(phone)
        provision = phone_apps.install(phone.serial, _adb, session)
        phone.timings.update(provision)
        if provision["cache_changed"]:
            phone_apps.sync_context(session, _client, _check, syncs[-1].context_id, phone_apps.APK_ROOT, "upload")
        # Install first: PackageManager may recreate private directories. Restore only after it finishes.
        _check(session.context.bind(*syncs[:-1]))
        if purpose == "errand":
            sync_data(phone, APP_PACKAGES, "download")
        phone.timings["create_ready_s"] = round(time.monotonic() - create_started, 3)
        phone.timings["lease_ready_s"] = round(time.monotonic() - start, 3)
        if purpose == "errand":
            _check(session.keep_alive())
        phone._ready = True
        _record(phone, ready=True)
        progress("ready", "云手机已就绪")
        return phone
    except BaseException:
        _dispose(phone, sync=False)  # Never upload a partial restore over the owner's saved context.
        raise


def sync_data(phone, packages, mode):
    """Explicit app selection; persist an incomplete download before it can touch saved app data."""
    if mode == "upload" and phone._partial.intersection(packages):
        raise RuntimeError("App 恢复未完成，不能覆盖已保存的数据")
    for package in packages:
        stage, verb = ("restoring", "恢复") if mode == "download" else ("saving", "保存")
        name = dict(zip(APP_PACKAGES, ("千问", "淘宝", "支付宝", "米家")))[package]
        progress(stage, f"正在{verb}{name}数据", app=name)
        if mode == "download":
            phone._partial.add(package)
            _record(phone, ready=phone._ready)
        _adb("-s", phone.serial, "shell", f"am force-stop {package}")
        phone_apps.sync_apps(phone._session, _client, _check, mode, packages=(package,))
        if mode == "download":
            phone_apps.repair(phone.serial, _adb, packages=(package,))
            phone._partial.remove(package)
            _record(phone, ready=phone._ready)
    progress("ready", "云手机已就绪", app=None)


def reap_login(*, force=False) -> bool:
    """Delete a manual-release session left by a dead process without uploading unconfirmed login data. The caller must hold the phone lease (no live process owns the session)."""
    phone = _recorded()
    if phone is None or not force and phone._purpose != "login" and phone._ready:
        return False
    _dispose(phone, sync=False)
    return True


async def _heartbeat(phone, holder):
    while True:
        await asyncio.sleep(180)
        result = await asyncio.to_thread(phone._session.keep_alive)
        if not result.success:
            holder.cancel()
        _check(result)


async def _join_cleanup(work):
    while True:
        try:
            return await asyncio.shield(work)
        except asyncio.CancelledError:
            if work.cancelled():
                raise
            continue  # Repeated executor stops cannot interrupt an SDK lifecycle operation.


async def lease(purpose: str = "errand", extra_budget_s: float = 0) -> CloudPhone:
    work = asyncio.create_task(asyncio.to_thread(_lease, purpose, extra_budget_s))
    try:
        phone = await asyncio.shield(work)
    except asyncio.CancelledError:
        phone = await _join_cleanup(work)
        await _join_cleanup(asyncio.create_task(asyncio.to_thread(_dispose, phone, sync=False)))
        raise
    if purpose == "errand":
        phone._heartbeat = asyncio.create_task(_heartbeat(phone, asyncio.current_task()))
    return phone


async def release(phone: CloudPhone, keep_warm: bool = True, *, sync: bool = True) -> None:
    work = asyncio.create_task(asyncio.to_thread(_dispose, phone, keep_warm=keep_warm and phone._purpose == "errand", sync=sync))
    try:
        await asyncio.shield(work)
    except asyncio.CancelledError:
        await _join_cleanup(work)
        raise
    finally:
        if phone._heartbeat:
            phone._heartbeat.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await phone._heartbeat
