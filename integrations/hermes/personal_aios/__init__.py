"""Thin Personal-AIOS provider; TS owns tool contracts, Hermes owns loop/history."""
import copy
import json
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen
from agent.memory_provider import MemoryProvider
from .effects import http_error_result, http_error_block


class PersonalAIOSProvider(MemoryProvider):
    name = "personal_aios"

    def __init__(self):
        from hermes_constants import get_hermes_home
        from hermes_cli.config import _expand_env_vars
        import yaml
        config_path = get_hermes_home() / "config.yaml"
        config = yaml.safe_load(config_path.read_text()) if config_path.exists() else {}
        config = _expand_env_vars((config or {}).get("personal_aios", {}))
        self.base_url = config.get("internal_base_url", "")
        # One tool RPC may include a cold download and the bounded native vision call.
        self.timeout = float(config.get("timeout_seconds", 600))
        self.key_file = config.get("internal_key_file", "")
        self._schemas = None

    def is_available(self):
        url = urlsplit(self.base_url)
        return (url.scheme == "http" and url.hostname in {"127.0.0.1", "::1", "localhost"}
                and not url.username and Path(self.key_file).is_file())

    def initialize(self, session_id, **kwargs):
        # Every call carries native keys; central Admission owns their D binding.
        pass

    def _request(self, path, body=None, max_bytes=1048576):
        if not self.is_available():
            raise ValueError("internal_loopback_configuration_required")
        request = Request(self.base_url.rstrip("/") + path,
            data=None if body is None else json.dumps(body).encode(), headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + Path(self.key_file).read_text().strip()})
        with urlopen(request, timeout=self.timeout) as response:
            payload = response.read(max_bytes + 1)
        if len(payload) > max_bytes:
            raise ValueError("internal_response_budget_exceeded")
        return json.loads(payload)

    def errand_report_context(self, context, job_ids):
        return self._request('/internal/hermes/errand-report-context',
                             {'context': context, 'job_ids': job_ids})['prior_reports']

    def get_tool_schemas(self):
        if self._schemas is None:
            schemas = self._request("/internal/hermes/tool-contracts", max_bytes=131072)
            if not isinstance(schemas, list) or not 1 <= len(schemas) <= 40:
                raise ValueError("invalid_tool_contract_snapshot")
            if any(not isinstance(schema, dict) or
                   not isinstance(schema.get("name"), str) or
                   not isinstance(schema.get("description"), str) or
                   not isinstance(schema.get("parameters"), dict) or
                   not isinstance(schema["parameters"].get("properties"), dict)
                   for schema in schemas):
                raise ValueError("invalid_tool_contract_snapshot")
            self._schemas = schemas
        return copy.deepcopy(self._schemas)

    def handle_tool_call(self, tool_name, args, **kwargs):
        context = {key: kwargs.get(key, "") for key in ("session_id", "run_id", "tool_call_id")}
        try:
            result = self._request("/internal/hermes/tools/" + quote(tool_name, safe=""), {"context": context, "args": args})
            return json.dumps(result, ensure_ascii=False)
        except HTTPError as exc:
            return json.dumps({"status": "rejected", **http_error_result(exc)})
        except (URLError, TimeoutError, ValueError):
            return json.dumps({"status": "failed", "error_code": "internal_service_unavailable"})


def register(ctx):
    heading = '### 只报告记录支持的事实'
    rules = (Path(__file__).parent / 'skills/personal-aios-main/SKILL.md').read_text()
    section = heading + rules.split(heading, 1)[1].split('\n### ', 1)[0]
    ctx.register_system_prompt_section('personal-aios.reporting', section, max_chars=4000)
    provider = PersonalAIOSProvider()
    ctx.register_memory_provider(provider)
    from .self_tools import register as register_self_tools
    register_self_tools(ctx, provider)
    from .owner_mac_tools import register as register_owner_mac_tools
    register_owner_mac_tools(ctx)
    from .cron import register as register_cron
    register_cron(ctx, provider)
    from .effects import register as register_effects, register_execution_gate
    register_effects(ctx, provider)
    lifecycle = {"phone_start", "phone_restore_apps", "phone_save_apps", "phone_close"}
    def phone_source(tool_name, args, session_id="", **kwargs):
        if tool_name.removeprefix("mcp__phone__") in {"phone_status", "phone_control_link"}:
            from gateway.session_context import get_api_run_id
            run = get_api_run_id(session_id)
            if not run:
                return {"action": "block", "message": "Phone status requires a bound owner run."}
            try:
                owner = provider._request("/internal/hermes/schedule-context", {"context": {
                    "run_id": run, "session_id": session_id, "tool_call_id": kwargs.get("tool_call_id", "")}})
                return {"action": "modify", "args": {"principal_id": owner["principal_id"]}}
            except HTTPError as exc:
                return http_error_block(exc)
            except Exception as exc:
                # An escaped middleware error would let Hermes execute model-supplied identity.
                return {"action": "block", "message": "PHONE_SOURCE_CHECK_FAILED: " + type(exc).__name__}
        if tool_name.removeprefix("mcp__phone__") in lifecycle:
            # Background cloud-phone steps carry the request's job lineage so its activity card shows them.
            from gateway.session_context import get_api_run_id
            run = get_api_run_id(session_id)
            if not run:
                return None
            owner = provider._request("/internal/hermes/phone-task-context", {"context": {
                "run_id": run, "session_id": session_id, "tool_call_id": kwargs.get("tool_call_id", "")}})
            return {"action": "modify", "args": {key: owner[key] for key in ("principal_id", "job_id", "origin_processed_event_id")}}
        if tool_name not in {"phone_task", "mcp__phone__phone_task"}:
            return None
        if "pay_limit_yuan" in args:
            return {"action": "block", "message": "pay_limit_yuan 已取消：先调用 paios_payment(action=request)，再传 payment_intent"}
        from .effects import check_effect
        gate = check_effect(provider, tool_name, args, session_id, kwargs.get("tool_call_id", ""))
        if gate and gate.get("action") == "block":
            return gate
        payment, ride = args.get("payment_intent"), bool(args.get("ride_ok"))
        try:
            from gateway.session_context import get_api_run_id
            run = get_api_run_id(session_id)
            owner = provider._request("/internal/hermes/phone-task-context", {"context": {
                "run_id": run, "session_id": session_id, "tool_call_id": kwargs.get("tool_call_id", "")}}) if run else {}
            principal = owner.get("principal_id")
            body = {"run_id": run, **({"intent_id": payment} if payment else {})}
            source = provider._request("/internal/hermes/payment-source", body) if run and (payment or ride) else {}
            allowed = (isinstance(principal, str) and bool(principal) and isinstance(source, dict)
                       and (not payment or source.get("allowed") is True) and (not ride or source.get("ride_allowed") is True))
            if not allowed:
                return {"action": "block", "message": "Phone work requires a bound owner run. Payment requires a live intent from this run. A real ride requires an owner request or a verified affirmative ride-card answer."}
            # The server's approval record rides in effect to the tool result (effects.report_approval).
            approval = {"effect": {**args["effect"], "approval": gate}} if gate else {}
            return {"action": "modify", "args": {**{key: owner[key] for key in ("principal_id", "job_id", "origin_processed_event_id")}, **approval}}
        except HTTPError as exc:
            return http_error_block(exc)
        except (URLError, TimeoutError, ConnectionError) as exc:
            return {"action": "block", "message": "PHONE_SOURCE_UNAVAILABLE: " + type(exc).__name__}
        except Exception as exc:
            # Native execution middleware skips escaped errors; expose the failure and block here.
            return {"action": "block", "error_code": "PHONE_SOURCE_CHECK_FAILED", "error_type": type(exc).__name__,
                    "message": f"PHONE_SOURCE_CHECK_FAILED: {type(exc).__name__}"}
    register_execution_gate(ctx, phone_source)
    if __import__('os').environ.get('PAIOS_WORKSHOP_HOST'):
        from .workshop import register as register_workshop
        register_workshop(ctx, provider)
