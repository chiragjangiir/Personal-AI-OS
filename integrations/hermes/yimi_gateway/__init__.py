"""Documented Hermes hooks; platform admission owns policy and receipt facts."""
import json
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


def _binding(task_id, session_id):
    from gateway.session_context import get_api_run_id
    from tools.delegate_tool_registry import _active_subagents, _active_subagents_lock
    # N12 reports the root conversation in hook session_id. task_id identifies the actual child.
    with _active_subagents_lock:
        row = _active_subagents.get(task_id)
        while row:
            session_id = row["owner_agent_session_id"] or session_id
            row = _active_subagents.get(row.get("parent_id"))
    return session_id, get_api_run_id(session_id)


def _unknown():
    body = {"receipt": 1, "status": {"state": "unknown", "reason_code": "gateway_unavailable"},
            "effects": [], "values": [], "content": [],
            "unknowns": [{"about": "执行结果", "why": "回执服务暂时不可用"}],
            "next": {"retry": "after_check", "waiting_on": "none"}}
    return "结果尚未核实，需要先核查，再决定是否重试。\n" + json.dumps(body, ensure_ascii=False)


def _retain_media(result, view):
    # Hermes' documented transform hook returns text. A native multimodal result is mutable;
    # replace its receipt text in place so the original envelope and coordinate notes survive.
    if isinstance(result, dict) and result.get('_multimodal'):
        result['content'][0] = {'type': 'text', 'text': view}
        result['text_summary'] = view
        return None
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except ValueError:
            pass
    if isinstance(result, dict) and isinstance(result.get('result'), str):
        media = [line for line in result['result'].splitlines() if line.startswith('MEDIA:')]
        if media:
            view += '\n' + '\n'.join(media)
    return view


class Gateway:
    def __init__(self, config):
        self.config = config
        self.tools = set(config.get("capability_tools", []))

    def rpc(self, operation, body=None):
        base = self.config["internal_base_url"]
        address = urlsplit(base)
        if address.scheme != "http" or address.hostname not in {"127.0.0.1", "::1", "localhost"} or address.username:
            raise ValueError("internal_loopback_configuration_required")
        request = Request(base.rstrip("/") + "/internal/hermes/gateway/" + operation,
            data=None if body is None else json.dumps(body).encode(), headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + Path(self.config["internal_key_file"]).read_text().strip()})
        with urlopen(request, timeout=3) as response:
            payload = response.read(1048577)
            if len(payload) > 1048576:
                raise ValueError("gateway_response_budget_exceeded")
            return json.loads(payload) if payload else None

    @staticmethod
    def envelope(tool_name, args, fields, *, result=False, post=False):
        body = {key: fields.get(key, "") for key in ("task_id", "session_id", "tool_call_id", "turn_id", "api_request_id")}
        body["session_id"], body["api_request_id"] = _binding(body["task_id"], body["session_id"])
        body.update(tool_name=tool_name, args=args)
        if result:
            body.update({key: fields.get(key) for key in ("result", "error_type", "error_message")})
            body.update(duration_ms=fields.get("duration_ms", 0), status=fields.get("status", ""))
        if not result or post:
            body["middleware_trace"] = fields.get("middleware_trace", [])
        return body

    def pre(self, tool_name, args, **fields):
        try:
            catalog = self.rpc("catalog")
            if tool_name not in catalog["tools"]:
                return ({'action': 'block', 'message': 'CAPABILITY_TOOL_NOT_ENABLED'}
                        if tool_name.startswith('mcp__yimi_shared__') else None)
            decision = self.rpc("decide", self.envelope(tool_name, args, fields))
            if decision["action"] == "allow":
                return None
            if decision["action"] == "block" and decision.get("message"):
                return decision
            if decision["action"] == "modify" and isinstance(decision.get("args"), dict):
                return decision
            if decision["action"] == "approve" and decision.get("message") and decision.get("rule_key"):
                return decision  # Native approval gate; the platform shows the owner's card and answers it.
            raise ValueError("invalid_gateway_decision")
        except Exception:
            return ({"action": "block", "message": "能力判定服务暂时不可用，本次未执行。"}
                    if tool_name in self.tools or tool_name.startswith('mcp__yimi_shared__') else None)

    def transform(self, tool_name, args, **fields):
        try:
            if tool_name not in self.rpc("catalog")["tools"]:
                return None
            view = self.rpc("receipt", self.envelope(tool_name, args, fields, result=True))["model_view"]
            if not isinstance(view, str) or not view.strip():
                raise ValueError("invalid_gateway_receipt_view")
            return _retain_media(fields.get('result'), view)
        except Exception:
            return _retain_media(fields.get('result'), _unknown()) if tool_name in self.tools or tool_name.startswith('mcp__yimi_shared__') else None

    def post(self, tool_name, args, **fields):
        try:
            if tool_name in self.rpc("catalog")["tools"]:
                self.rpc("observe", self.envelope(tool_name, args, fields, result=True, post=True))
        except Exception:
            pass  # Observation failure cannot undo execution or change an admitted receipt.


def register(ctx):
    from hermes_constants import get_hermes_home
    import yaml
    config = yaml.safe_load((get_hermes_home() / "config.yaml").read_text())["personal_aios"]
    gateway = Gateway(config)
    ctx.register_hook("pre_tool_call", gateway.pre)
    ctx.register_hook("transform_tool_result", gateway.transform)
    ctx.register_hook("post_tool_call", gateway.post)
