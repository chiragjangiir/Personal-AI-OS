"""Unknown payments permit only a targeted screen check, never a new phone operation."""
import asyncio
from pathlib import Path


class OrderCheckRequired(RuntimeError):
    code = "PAYMENT_ORDER_CHECK_REQUIRED"


def before_operation(executor, job):
    if job.get("tier") != "payment_check" and unresolved(executor, job["principal_id"]):
        raise OrderCheckRequired("付款结果未知，必须先只读核对原订单。")


def unresolved(executor, principal_id):
    import payment_lineage
    if not executor.SPOOL:
        return None
    apps = set()
    for path in Path(executor.SPOOL).glob("job-*.json"):
        if path.suffixes[-2:] not in [["." + state, ".json"] for state in payment_lineage._SPOOL_STATES]:
            continue
        record = payment_lineage._read_spool_job(path)
        if not isinstance(record, dict) or not record.get("principal_id"):
            raise ValueError("PAYMENT_LINEAGE_UNREADABLE")
        if record.get("principal_id") == principal_id:
            apps.add(record.get("app"))
    for app in sorted(apps, key=lambda item: item or ""):
        if owner := payment_lineage.unresolved(executor.SPOOL, principal_id, app):
            return owner
    return None


async def check_order(executor, task):
    import payment_lineage
    from payment_checkpoint import PaymentError
    job = executor._jobs[executor._job_id.get()]
    observation = {"state": "unknown"}
    mac_binding = None
    if executor.PHONE_PROVIDER == "mac-android":
        mac_binding, _ = await asyncio.to_thread(executor.mac_android.request, task.get("context"))
    async with executor._errand(None, None, continuation=True, mac_binding=mac_binding):
        owner = job["payment_owner"]
        bound = payment_lineage.binding(owner)
        if owner == task["check_owner"] and bound:
            driver = await executor._driver()
            observer = executor.CheckoutStop(driver)
            try:
                observation = (await executor._payment_screen(observer)).reconciliation(bound)
            except PaymentError:
                pass
    return {"success": observation["state"] in {"paid", "unpaid"},
            "payment_observation": observation,
            "answer": "原订单付款核对：" + observation["state"]}


def start_check(executor, owner, check_job_id, origin_processed_event_id, context=None, self_check_of=None):
    for jid, job in executor._jobs.items():
        if job.get("tier") == "payment_check" and job.get("payment_owner") == owner:
            return jid
    jid = check_job_id
    task = {"goal": "从当前页面继续：只读核对原订单付款状态", "app": owner["app"],
            "tier": "payment_check", "max_steps": 1, "payment_check": True,"check_owner":owner,"context":context}
    if executor._same_errand(task["goal"], owner["app"], owner["principal_id"], job_id=jid) is not None:
        return jid
    executor._start(jid, task, "核对原订单付款状态", owner["principal_id"], origin_processed_event_id, self_check_of)
    executor._jobs[jid]["task_type"] = "read_app"
    executor._write_running(jid, force=True)
    return jid
