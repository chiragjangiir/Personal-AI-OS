"""Stand-in for the phone executor in the staging Hermes: same MCP tools and arguments, nothing touches a phone.
Every call is appended to $PAIOS_FAKE_PHONE_LOG (JSONL) so a scenario can assert what the main agent dispatched."""

from __future__ import annotations

import asyncio
import datetime
import hashlib
import json
import os
import time
import uuid
import sys
from pathlib import Path

from mcp.server import MCPServer

mcp = MCPServer("phone")
LOG = os.environ["PAIOS_FAKE_PHONE_LOG"]
_jobs: dict[str, dict] = {}
_stall_once_used = False
_one_phone = asyncio.Lock()
_cashier: FakeCashier | None = None
_cashier_scope: tuple[str, str | None] | None = None


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _spool(job_id: str, record: dict, state: str) -> None:
    """Use the executor's durable running/done spool protocol, without importing its phone drivers."""
    folder = Path(os.environ["PAIOS_ERRAND_SPOOL"])
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = folder / f"{job_id}.{state}.json.tmp"
    with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as stream:
        json.dump(record, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, folder / f"{job_id}.{state}.json")
    fd = os.open(folder, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    if state == "done":
        (folder / f"{job_id}.running.json").unlink(missing_ok=True)


def _checkpoint_module():
    # Source checkout execution; deployed Hermes supplies this module on PYTHONPATH.
    sibling = Path(__file__).resolve().parents[3] / "connectors/phone_executor"
    if sibling.is_dir() and str(sibling) not in sys.path:
        sys.path.insert(0, str(sibling))
    import payment_checkpoint
    return payment_checkpoint


class FakeCashier:
    """A deterministic screen and driver; it has no authorization state or payment policy."""
    def __init__(self, scenario: dict):
        if type(scenario.get("amount_fen")) is not int or scenario["amount_fen"] <= 0:
            raise ValueError("fake cashier amount_fen must be a positive integer")
        if not isinstance(scenario.get("items"), list) or not all(isinstance(v, str) for v in scenario["items"]):
            raise ValueError("fake cashier items must be a string list")
        if not isinstance(scenario.get("payee"), (str, type(None))):
            raise ValueError("fake cashier payee must be text or null")
        changed = scenario.get("change_after_grant_to")
        if changed is not None and (type(changed) is not int or changed <= 0):
            raise ValueError("change_after_grant_to must be a positive integer")
        self.scenario, self.reads, self.taps = scenario, 0, 0
        self.order_id = "fake-order-" + uuid.uuid4().hex
        self.status = "unpaid"
        # This fake's configured catalog is authoritative; no OCR/display headings enter the item identity.
        self.item_identity = tuple((f"catalog:{i}", item) for i, item in enumerate(scenario["items"]))

    async def read(self):
        module = _checkpoint_module()
        self.reads += 1
        reread = self.reads > 1
        amount = self.scenario.get("change_after_grant_to", self.scenario["amount_fen"]) if reread else self.scenario["amount_fen"]
        verify = reread and self.scenario.get("verify_prompt_after_grant", False)
        visible = json.dumps({"amount_fen": amount, "payee": self.scenario["payee"],
                              "items": self.scenario["items"], "verify": verify, "taps": self.taps, "status": self.status}, sort_keys=True)
        return module.Screen(amount_fen=amount, payee=self.scenario["payee"], items=tuple(self.scenario["items"]),
            screen_sha256=hashlib.sha256(visible.encode()).hexdigest(), read_at=_now(),
            pay_buttons=((100, 200),) if self.status == "unpaid" else (), verify=bool(verify),
            payment_statuses=({"paid": ("支付状态：已支付",), "unpaid": ("支付状态：待支付",)}.get(
                self.status, ("支付状态：处理中",))), order_id=self.order_id,
            region=("fake", self.order_id), page_title="订单详情", order_namespace="staging.fake_cashier", item_identity=self.item_identity, item_facts=self.item_identity)

    async def tap(self, x, y):
        assert (x, y) == (100, 200)
        self.taps += 1
        outcomes = self.scenario.get("tap_results", ["paid"])
        self.status = outcomes[min(self.taps - 1, len(outcomes) - 1)]
        if self.scenario.get("crash_after_tap"):
            raise RuntimeError("synthetic crash after tap")

    async def cancel_order(self):
        return {"outcome": "done" if self.scenario.get("order_cancel_ok", True) else "failed"}


async def _cashier_job(job_id: str, job: dict, scenario: dict) -> None:
    global _cashier, _cashier_scope
    intent_id = job["payment_intent"]
    record = {"principal_id": job["principal_id"], "job_id": job_id, "task": job["goal"][:4000], "app": job["app"], "tier": job["tier"],
              "payment_intent": intent_id, "started_at": job["started_at"],
              "phone_started_at": job.get("phone_started_at"),
              **{key: job[key] for key in ("origin_processed_event_id", "self_check_of") if key in job}}
    checkpoint = cashier = None
    try:
        async with _one_phone:
            job["state"] = "running"
            job["phone_started_at"] = _now()
            record["phone_started_at"] = job["phone_started_at"]
            _spool(job_id, {**record, "title": job["title"], "state": "running", "started_at": job["started_at"],
                            "step": 0, "max_steps": job["max_steps"]}, "running")
            module = _checkpoint_module()
            import payment_lineage
            continuing = job["goal"].startswith("从当前页面继续：")
            if continuing:
                if _cashier is None or _cashier_scope != (job["principal_id"], job["app"]):
                    raise ValueError("No same-app fake order to continue")
                cashier = _cashier
            else:
                cashier = _cashier = FakeCashier(scenario)
                _cashier_scope = (job["principal_id"], job["app"])
            config = module.CheckpointConfig.from_env()
            client = module.PaymentHTTPClient.from_env(config=config)
            async def read():
                screen = await cashier.read()
                if "payment_binding" not in record:
                    record["payment_binding"] = payment_lineage.remember(module.PaymentBinding(screen.order_id, screen.payee, screen.amount_fen,
                        screen.order_namespace, screen.item_identity, screen.item_facts))
                    _spool(job_id, {**record, "title": job["title"], "state": "running", "started_at": job["started_at"],
                                    "step": 0, "max_steps": job["max_steps"]}, "running")
                return screen
            checkpoint = module.PaymentCheckpoint(client, read, cashier.tap, cashier.cancel_order, config=config)
            result = await checkpoint.run(intent_id, job_id, job["app"])
    except asyncio.CancelledError:
        result = {"success": False, "answer": "【付款结果不明】模拟执行手机已停止，请核对订单；不会再付一次。"}
    except Exception:
        # Never put HTTP credentials or grant-bearing exception text into model-visible results.
        result = {"success": False, "answer": "【付款结果不明】模拟收银台执行失败，请核对订单；不会再付一次。"}
    finally:
        _jobs.pop(job_id, None)
    if checkpoint is not None:
        _record("payment_checkpoint", result={"checkpoint_reached": bool(checkpoint.payment_id),
            "success": bool(result["success"]), "terminal_reason": "completed" if result["success"] else "failed",
            "taps": cashier.taps, "order_id": cashier.order_id}, payment_intent=intent_id, job_id=job_id, app=job["app"])
    import payment_lineage
    _spool(job_id, {**record, **payment_lineage.terminal(record, result), "success": bool(result["success"]), "answer": result["answer"][:4000],
                    "finished_at": _now(), "terminal_reason": "completed" if result["success"] else "failed",
                    "retryable": False}, "done")


async def _reconcile_job(job_id: str, job: dict) -> None:
    """A no-intent continuation is private only while a durable payment is unresolved."""
    _checkpoint_module()
    import payment_lineage
    record = {"principal_id": job["principal_id"], "job_id": job_id, "task": job["goal"], "app": job["app"], "tier": job["tier"],
              "started_at": job["started_at"], "payment_owner": job.get("payment_owner"),
              **{key: job[key] for key in ("origin_processed_event_id", "self_check_of") if key in job}}
    result = {"success": False, "answer": "模拟执行手机核对失败。"}
    reason = "failed"
    try:
        async with _one_phone:
            owner = payment_lineage.capture(os.environ.get("PAIOS_ERRAND_SPOOL"), job)
            record.update(payment_owner=owner, phone_started_at=_now(), title=job["title"],
                          state="running", step=0, max_steps=job["max_steps"])
            record["evidence_ref"] = {"tool": "phone_status", "job_id": job_id}
            _spool(job_id, record, "running")
            if owner:
                bound = payment_lineage.binding(owner)
                evidence = {"state": "unknown"}
                if _cashier is not None and _cashier_scope == (job["principal_id"], job["app"]) and bound:
                    _cashier.status = _cashier.scenario.get("reconcile_state", _cashier.status)
                    screen = await _cashier.read()
                    evidence = {**screen.reconciliation(bound), "taps": _cashier.taps}
                result = {"success": True, "answer": "【付款核对】" + json.dumps(evidence, ensure_ascii=False),
                          "payment_observation": evidence}
                _record("payment_reconcile", result=evidence, job_id=job_id, app=job["app"], payment_intent=None)
            elif job.get("synthetic_stall"):
                import step_trace
                trace = job["_trace"] = step_trace.StepTrace()
                trace.model(type("LLMChatStartEvent", (), {"span_id": "staging.synthetic"})())
                await asyncio.sleep(0.1)
                trace.stall()
                record["trace"] = trace.snapshot()
                result = {"success": False, "answer": "测试合成故障：模拟模型等待超时；不是真实模型测量。"}
                reason = "timed_out"
            else:
                result = {"success": True, "answer": "模拟继续办理完成。"}
                if not job["goal"].startswith("从当前页面继续"):
                    record["payment_page_left"] = True
            if result["success"]:
                reason = "completed"
    except asyncio.CancelledError:
        result = {"success": False, "answer": "模拟执行手机已停止。"}
        reason = "cancelled_by_user"
    except TimeoutError:
        reason = "timed_out"
    except Exception:
        reason = "failed"  # A background reconciliation still delivers its explicit failure result.
    finally:
        _spool(job_id, {**record, **payment_lineage.terminal(record, result), "success": result["success"],
            "answer": result["answer"], "finished_at": _now(), "terminal_reason": reason, "retryable": False}, "done")
        _jobs.pop(job_id, None)


def _record(tool: str, result: dict | None = None, **args) -> None:
    with open(LOG, "a") as out:
        out.write(json.dumps({"at": time.time(), "tool": tool, "args": args, "result": result}, ensure_ascii=False) + "\n")


@mcp.tool()
async def phone_task(goal: str, max_steps: int = 80, latitude: float | None = None, longitude: float | None = None,
                     payment_intent: str | None = None, app: str | None = None, tier: str = "fast",
                     ride_ok: bool = False, title: str = "", repeat: bool = False, principal_id: str = "", *, effect: dict,
                     job_id: str | None = None, origin_processed_event_id: str | None = None,
                     context: dict | None = None, self_check_of: str | None = None) -> dict:
    """在执行手机上替用户办一件事（后台执行，立刻返回 started；结果之后以 errand_result 事件回来）。参数含义同正式执行器。
    需要付款的跑腿先调用 paios_payment(action=request)，把返回的 intent_id 作为 payment_intent 传入；goal 写到『点「支付宝付款」付款』为止。执行手机在付款前会自动停下，等主人在付款卡上授权（最多 5 分钟），授权后由执行手机核对屏幕金额等于授权金额才点；没授权就取消这张未付款订单。不传 payment_intent 就停在付款前，绝不付款。永远不输入支付密码。"""
    if not principal_id:
        raise ValueError("ERRAND_PRINCIPAL_REQUIRED")
    scenario = None
    if payment_intent:
        if not app:
            return {"success": False, "answer": "付款跑腿必须传 app，与 paios_payment 申请的 App 相同；任务未开始。"}
        scenario = json.loads(Path(os.environ["PAIOS_FAKE_CASHIER"]).read_text())
        FakeCashier(scenario)
        if not os.environ.get("PAIOS_ERRAND_SPOOL"):
            raise ValueError("PAIOS_ERRAND_SPOOL is required for fake payments")
    _checkpoint_module()
    import payment_lineage
    global _stall_once_used
    job_id = job_id or f"job-{uuid.uuid4().hex[:12]}"
    _record("phone_task", result={"status": "started", "job_id": job_id}, goal=goal, max_steps=max_steps, latitude=latitude, longitude=longitude,
            payment_intent=payment_intent, app=app, tier=tier, ride_ok=ride_ok, title=title, repeat=repeat, principal_id=principal_id,
            effect=effect, origin_processed_event_id=origin_processed_event_id, self_check_of=self_check_of)
    _jobs[job_id] = {"principal_id": principal_id, "goal": goal, "app": app, "since": time.time(), "payment_intent": payment_intent, "tier": tier,
                     "started_at": _now(), "phone_started_at": None, "payment_owner": payment_lineage.capture(os.environ.get("PAIOS_ERRAND_SPOOL"),
                         {"principal_id": principal_id, "app": app, "goal": goal, "payment_intent": payment_intent})}
    job = _jobs[job_id]
    job.update(title=" ".join((title or goal).split())[:40], max_steps=max(1, min(max_steps, 120)), state="waiting")
    job.update({key: value for key, value in {"origin_processed_event_id": origin_processed_event_id,
                "self_check_of": self_check_of}.items() if value is not None})
    if (os.environ.get("PAIOS_FAKE_PHONE_STALL_ONCE") == "1" and not _stall_once_used
            and effect.get("kind") == "read" and not payment_intent and not job["payment_owner"]):
        job["synthetic_stall"] = True
        _stall_once_used = True
    if payment_intent:
        _spool(job_id, {"principal_id": principal_id, "job_id": job_id, "task": goal[:4000], "title": job["title"], "app": app, "tier": tier,
                        "payment_intent": job["payment_intent"], "phone_started_at": None,
                        "state": "waiting", "started_at": job["started_at"], "step": 0, "max_steps": job["max_steps"],
                        **{key: job[key] for key in ("origin_processed_event_id", "self_check_of") if key in job}}, "running")
        job["task"] = asyncio.create_task(_cashier_job(job_id, job, scenario))
    elif os.environ.get("PAIOS_ERRAND_SPOOL"):
        job = _jobs[job_id]
        _spool(job_id, {"principal_id": principal_id, "job_id": job_id, "task": goal, "app": app, "tier": tier,
            "started_at": job["started_at"], "phone_started_at": None, "payment_owner": job["payment_owner"],
            "title": job["title"], "state": "waiting", "step": 0, "max_steps": job["max_steps"],
            **{key: job[key] for key in ("origin_processed_event_id", "self_check_of") if key in job}}, "running")
        _jobs[job_id]["task"] = asyncio.create_task(_reconcile_job(job_id, _jobs[job_id]))
    return {"status": "started", "job_id": job_id,
            "answer": "已在执行手机上开始办理。现在只需告诉用户已经开始、大概几分钟；办完结果会作为 errand_result 事件自动送回，"
                      "届时再汇报。不要等待，也不要重复派同一件事。"}


@mcp.tool()
async def phone_status(context: dict | None = None, principal_id: str = "", job_id: str | None = None) -> dict:
    """查询当前主人的运行中任务和最近 600 秒的持久终态（state/success/terminal_reason/answer/finished_at）。
    principal_id 由原生 run 绑定；空列表不证明结果或确认状态。"""
    _record("phone_status", job_id=job_id)
    _checkpoint_module()
    from errand_status import job_status
    return job_status(os.environ.get("PAIOS_ERRAND_SPOOL"), _jobs, principal_id, job_id=job_id)


@mcp.tool()
async def phone_cancel(job_id: str | None = None) -> dict:
    """立刻让执行手机停手。"""
    _record("phone_cancel", job_id=job_id)
    stopped = [j for j in list(_jobs) if job_id in (None, j)]
    for j in stopped:
        job = _jobs.pop(j)
        if job.get("task"):
            job["task"].cancel()
            try:
                await job["task"]
            except asyncio.CancelledError:  # Cancelled before the background coroutine started: no inputs ran.
                import payment_lineage
                _spool(j, {"principal_id": job["principal_id"], **payment_lineage.terminal(job, {}), "payment_owner": job.get("payment_owner"), "job_id": j, "task": job["goal"][:4000], "app": job["app"], "tier": job["tier"],
                    **({"payment_intent": job["payment_intent"]} if job["payment_intent"] else {}),
                    "started_at": job["started_at"], "phone_started_at": job.get("phone_started_at"),
                    "success": False, "answer": "【没有付款】已停止；未尝试取消未付款订单，请你在 App 里核对。",
                    "finished_at": _now(), "terminal_reason": "cancelled_by_user", "retryable": False}, "done")
    return {"stopped": stopped, "answer": "执行手机已停手，停在当时的页面。" if stopped else "执行手机上没有正在办的任务。"}


def _recover_interrupted():
    """Keep the real producer's interrupted-result shape after a fake process restart."""
    _checkpoint_module()
    import payment_lineage
    folder = os.environ.get("PAIOS_ERRAND_SPOOL")
    if not folder:
        return
    for marker in Path(folder).glob("job-*.running.json"):
        record = json.loads(marker.read_text())
        if record.get("state") == "waiting" and "phone_started_at" not in record:
            record["phone_started_at"] = None
        _spool(record["job_id"], {**record, **payment_lineage.terminal(record, {}), "success": False,
            "answer": "模拟执行手机重启，结果未知，请只读核对。", "finished_at": _now(),
            "terminal_reason": "interrupted", "retryable": False}, "done")


if __name__ == "__main__":
    _recover_interrupted()
    mcp.run(transport="stdio")
