"""Standing observations use the native cron record and admitted tool dispatcher."""
import json


WATCH_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {"query_tool": {"type": "string"}, "query_args": {"type": "object"},
                   "status_field": {"type": "string"}, "from_status": {"type": "string"},
                   "to_status": {"type": "string"}, "message": {"type": "string"}},
    "required": ["query_tool", "query_args", "status_field", "from_status", "to_status", "message"],
}


def query_result(tool, raw):
    """Decode Hermes' MCP envelope; native tools already return their own JSON."""
    result = json.loads(raw) if isinstance(raw, str) else raw
    if tool.startswith('mcp__') and 'error' not in result:
        result = result.get('structuredContent', result['result'])
        result = json.loads(result) if isinstance(result, str) else result
    return result


def definition(value):
    if (not isinstance(value, dict) or set(value) != set(WATCH_SCHEMA["required"])
            or not isinstance(value["query_args"], dict)
            or any(not isinstance(value[key], str) or not value[key].strip()
                   for key in WATCH_SCHEMA["required"] if key != "query_args")
            or len(value["message"]) > 2000 or value["from_status"] == value["to_status"]
            or value["query_tool"] in {"paios_watch_check", "cronjob_manage"}):
        raise ValueError("Standing watch requires an exact query tool, arguments, status field, distinct states and notification text.")
    return {"definition": value, "last_status": None, "sequence": 0}


def register(ctx, provider):
    from cron.jobs import get_job, update_job, _jobs_lock, _fire_job_lock
    from gateway.session_context import get_api_run_id
    from tools.approval_context import _approval_tool_call_id

    def check(args, **kwargs):
        from .cron import job_owner
        session = kwargs.get("session_id", "")
        owner = provider._request("/internal/hermes/schedule-context", {"context": {
            "run_id": get_api_run_id(session), "session_id": session,
            "tool_call_id": _approval_tool_call_id.get()}})
        job = get_job(owner.get("scheduled_job_id", ""))
        if not job or job_owner(job)["principal_id"] != owner["principal_id"] or not job.get("standing_watch") or not job.get("enabled", True):
            raise ValueError("Standing watch requires its admitted scheduled run.")
        with _fire_job_lock(job["id"]) as acquired:
            if not acquired:
                raise RuntimeError("Standing watch native job fence is unavailable.")
            current = get_job(job["id"])
            if not current or not current.get("enabled", True) or current.get("standing_watch") != job["standing_watch"]:
                return json.dumps({"status": "silent", "reason": "watch_changed_before_query"})
            return observe(current, owner, kwargs)

    def observe(job, owner, kwargs):
        from .cron import job_owner
        from tools.personal_aios_dispatch import dispatch_nested_tool
        state = job["standing_watch"]
        pending = state.get("pending")
        if not pending:
            watch = state["definition"]
            raw = dispatch_nested_tool(watch["query_tool"], watch["query_args"], **kwargs)
            result = query_result(watch['query_tool'], raw)
            if not isinstance(result, dict) or result.get("error") or result.get("success") is False or result.get("error_code") or result.get("status") in {"failed", "rejected", "unavailable"}:
                raise ValueError("Standing watch query failed; observation was not consumed.")
            observed = result
            for part in watch["status_field"].split("."):
                observed = observed[part]
            if not isinstance(observed, str) or not observed:
                raise ValueError("Standing watch query status must be a nonempty string.")
            with _jobs_lock():
                current = get_job(job["id"])
                if not current or not current.get("enabled", True) or current.get("standing_watch") != state:
                    return json.dumps({"status": "silent", "reason": "watch_changed_during_query"})
                changed = state["last_status"] in {None, watch["from_status"]} and observed == watch["to_status"]
                state = {**state, "last_status": observed}
                if changed:
                    state["sequence"] = state["sequence"] + 1
                    pending = {"principal_id": owner["principal_id"], "device_id": job_owner(job)["device_id"],
                               "id": "watch:" + job["id"] + ":" + str(state["sequence"]), "text": watch["message"],
                               "captured_at": owner["scheduled_captured_at"]}
                    state["pending"] = pending
                if update_job(job["id"], {"standing_watch": state}) is None:
                    raise RuntimeError("Standing watch disappeared before observation persistence.")
        if not pending:
            return json.dumps({"status": "silent", "observed_status": state["last_status"]})
        current = get_job(job["id"])
        if not current or not current.get("enabled", True) or current.get("standing_watch", {}).get("pending") != pending:
            return json.dumps({"status": "silent", "reason": "watch_changed_before_delivery"})
        response = provider._request("/internal/hermes/scheduled-delivery", pending)
        if response.get("status") != "delivered":
            raise ValueError("Standing watch delivery was not acknowledged; retry the admitted watch check.")
        with _jobs_lock():
            current = get_job(job["id"])
            state = current.get("standing_watch", {}) if current else {}
            if state.get("pending") == pending:
                state = {**state, "delivered_sequence": state["sequence"]}
                state.pop("pending", None)
                if update_job(job["id"], {"standing_watch": state}) is None:
                    raise RuntimeError("Standing watch disappeared before delivery acknowledgment persistence.")
        return json.dumps({"status": "delivered", "notification_id": pending["id"]})

    schema = {"name": "paios_watch_check", "description": "In an admitted standing-watch run, invoke its saved query tool and notify the owner once for each occurrence of its saved transition. All other states are silent. Do not add a chat reply.",
              "parameters": {"type": "object", "properties": {}, "additionalProperties": False}}
    if ctx.register_tool("paios_watch_check", "cronjob", schema, check) is None:
        raise RuntimeError("Standing watch tool was not registered")
