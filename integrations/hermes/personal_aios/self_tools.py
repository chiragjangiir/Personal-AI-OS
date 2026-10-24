"""Bind the self MCP entry to native owner identity before MCP dispatch."""
import json


SELF_TOOLS = frozenset({"mcp__self__runtime_query", "mcp__self__runtime_status"})


def runtime_identity():
    from hermes_cli import __version__
    from hermes_cli.config import load_config_readonly
    model = load_config_readonly()["model"]
    if isinstance(model, str):
        return {"hermes_version": __version__, "provider": None, "model": model}
    return {"hermes_version": __version__, "provider": model.get("provider"), "model": model.get("default")}


def recent_session_count(session_id):
    from tools.session_search_tool import session_search
    value = json.loads(session_search(query="", limit=10, current_session_id=session_id))
    count = value.get("count")
    if (value.get("success") is not True or value.get("mode") != "browse"
            or type(count) is not int or not 0 <= count <= 10):
        raise ValueError("SELF_SESSION_BROWSE_UNAVAILABLE")
    # Native browse returns a bounded page, excluding the active session. It has
    # no total or continuation contract, so it cannot prove a global L4 total.
    return {"sessions": count, "complete": False}


def register(ctx, provider):
    def bind_self(tool_name, args, session_id="", **kwargs):
        if tool_name not in SELF_TOOLS:
            return None
        try:
            from gateway.run_scope import current_scope
            from gateway.session_context import get_api_run_id
            if current_scope() != "owner":
                return {"action": "block", "message": "SELF_OWNER_REQUIRED"}
            context = {"run_id": get_api_run_id(session_id), "session_id": session_id,
                       "tool_call_id": kwargs.get("tool_call_id", "")}
            if not all(isinstance(value, str) and value for value in context.values()):
                return {"action": "block", "message": "SELF_RUN_BINDING_REQUIRED"}
            owner = provider._request("/internal/hermes/schedule-context", {"context": context})
            if owner.get("allow_owner_mutation") is not True:
                return {"action": "block", "message": "SELF_OWNER_REQUEST_REQUIRED"}
            # Override model-supplied transport claims. Never forward history content.
            trusted = {"_context": context, "_l4": None, "_identity": None, "_local": None}
            if tool_name == "mcp__self__runtime_query" and args.get("source", "metrics") in {"hermes_agent", "hermes_errors", "mcp_stderr", "errands", "release", "resources"}:
                from .self_observe import observe
                trusted["_local"] = observe(args, owner["principal_id"])
            if tool_name == "mcp__self__runtime_status":
                trusted["_l4"] = recent_session_count(session_id)
                trusted["_identity"] = runtime_identity()
            return {"action": "modify", "args": trusted}
        except Exception as error:
            # Hermes continues after escaped hook errors. This authorization hook
            # must return a blocking directive; expose type without sensitive text.
            return {"action": "block", "message": "SELF_CONTEXT_FAILED:" + type(error).__name__}
    ctx.register_hook("pre_tool_call", bind_self)

    def background_status(args, **kwargs):
        from gateway.run_scope import current_scope
        from gateway.session_context import get_api_run_id
        from tools.approval_context import _approval_tool_call_id
        from cron.jobs import list_jobs
        from .cron import job_owner
        if current_scope() != "owner":
            raise ValueError("SELF_OWNER_REQUIRED")
        session = kwargs.get("session_id", "")
        context = {"run_id": get_api_run_id(session), "session_id": session,
                   "tool_call_id": _approval_tool_call_id.get()}
        if not all(context.values()):
            raise ValueError("SELF_RUN_BINDING_REQUIRED")
        owner = provider._request("/internal/hermes/schedule-context", {"context": context})
        if owner.get("allow_owner_mutation") is not True:
            raise ValueError("SELF_OWNER_REQUEST_REQUIRED")
        # Admission owns cross-continuity work and excludes the querying run.
        work = provider._request("/internal/hermes/tools/paios_task_amend",
                                 {"context": context, "args": {"action": "list"}})
        jobs = [{key: job.get(key) for key in ("id", "name", "state", "enabled", "next_run_at")}
                for job in list_jobs(include_disabled=True)
                if job.get("deliver", "").startswith("personal_aios:")
                and job_owner(job)["principal_id"] == owner["principal_id"]]
        return json.dumps({"active_runs": work["tasks"], "scheduled_jobs": jobs,
            "scope": "Current owner's admitted nonterminal runs across all continuities, excluding this query; native cron job configuration. Delegated work remains part of its admitted run. Cron completed describes its trigger, not completion of an admitted run.",
            "complete": True}, ensure_ascii=False)

    schema = {"name": "paios_background_status",
              "description": "Read my current background work before answering whether tasks are running. Uses owner admissions across continuities and native scheduled jobs. Read-only; failures mean unknown, never zero. A completed cron trigger does not complete an active admitted run.",
              "parameters": {"type": "object", "properties": {}, "additionalProperties": False}}
    if ctx.register_tool("paios_background_status", "memory", schema, background_status) is None:
        raise RuntimeError("Personal-AIOS background status tool was not registered")
