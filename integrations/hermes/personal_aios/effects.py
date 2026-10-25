"""Tool-execution admission; TS owns durable first-consent scope."""
import json
from pathlib import Path
import re
import uuid
from urllib.error import HTTPError, URLError
from http.client import IncompleteRead
from copy import deepcopy


def http_error_result(error):
    code = "internal_http_error"
    try:
        payload = json.loads(error.read(4096))
        if isinstance(payload, dict) and re.fullmatch(r"[A-Z0-9_]{1,100}", str(payload.get("error_code", ""))):
            code = payload["error_code"]
    except (ValueError, UnicodeDecodeError, OSError, IncompleteRead):
        pass
    return {"error_code": code, "http_status": error.code}


def http_error_block(error):
    result = http_error_result(error)
    return {"action": "block", **result, "message": result["error_code"]}


def check_effect(provider, tool_name, args, session_id, tool_call_id):
    """A block directive, or the server's approval record (None when no confirmation applies) for an allowed effect."""
    try:
        return _check_effect(provider, args, session_id, tool_call_id)
    except HTTPError as error:
        return http_error_block(error)
    except (URLError, TimeoutError, ConnectionError) as error:
        return {"action": "block", "message": "EFFECT_CONSENT_UNAVAILABLE: " + type(error).__name__}
    except Exception as error:
        # Execution middleware continues dispatch after escaped errors. Fail closed.
        return {"action": "block", "message": "EFFECT_CONSENT_FAILED: " + type(error).__name__}


def _check_effect(provider, args, session_id, tool_call_id):
    from gateway.session_context import get_api_run_id
    from tools.approval_context import get_current_session_key, _approval_tool_call_id
    from tools.approval import _gateway_notify_cb
    from tools.approval_gateway_wait import _await_gateway_decision
    effect = args.get("effect")
    if not isinstance(effect, dict):
        return {"action": "block", "message": "EFFECT_CLASSIFICATION_REQUIRED: provide effect={kind:read|file_edit|send|login|delete|external, task_type, requested:boolean, recipient (required for send)}. Describe actual effects; do not label a send as read."}
    context = {"run_id": get_api_run_id(session_id), "session_id": session_id,
               "tool_call_id": tool_call_id or _approval_tool_call_id.get()}
    summary = effect.get("summary", str(args.get("goal", ""))[:240])
    if not isinstance(summary, str) or len(summary) > 240:
        return {"action": "block", "message": "EFFECT_SUMMARY_INVALID: summary 最多 240 字，仅供确认界面展示。"}
    body = {"context": context, "effect": effect, "ride_ok": args.get("ride_ok") is True}
    decision = provider._request("/internal/hermes/effect-consent", body)
    if decision.get("status") == "allowed":
        return decision.get("approval")
    if decision.get("status") != "confirmation_required":
        return {"action": "block", "message": "EFFECT_CONSENT_NOT_GRANTED"}
    session_key = get_current_session_key()
    notify = _gateway_notify_cb(session_key)
    if notify is None:
        return {"action": "block", "message": "EFFECT_CONFIRMATION_REQUIRES_OWNER_PHONE"}
    scope = decision["scope"]
    kind = {"send": "发送内容", "login": "登录", "delete": "删除", "read": "读取", "file_edit": "修改文件", "external": "外部操作"}[scope["kind"]]
    task = scope["task_type"]
    if task.startswith("send_message:") and task.count(":") == 2:
        _, channel, action = task.split(":", 2)
        channel = {"email": "邮件", "weixin": "微信", "dingtalk": "钉钉", "wecom": "企业微信", "feishu": "飞书", "telegram": "Telegram"}.get(channel, channel)
        task = channel + {"send": "发送", "react": "表情回应", "unreact": "撤回回应"}.get(action, action)
    command = f"{kind}；任务：{task}；收件人：{scope.get('recipient', '不涉及收件人')}"
    # Native coalescing uses the exact server scope, never display text alone.
    pattern = "paios_effect:" + json.dumps(scope, ensure_ascii=False, sort_keys=True)
    preview = " ".join(summary.split())[:80]
    # The card's request id names the durable native decision the server links to this consent.
    request_id = uuid.uuid4().hex
    answer = _await_gateway_decision(session_key, notify, {
        "command": command, "description": "请确认：" + command + ("\n内容预览：" + preview if preview else ""),
        "pattern_key": pattern, "allow_permanent": False, "allow_session": False, "request_id": request_id})
    if not answer.get("resolved") or answer.get("choice") != "once" or answer.get("cancelled"):
        status = ("cancelled" if answer.get("cancelled") else "unavailable" if answer.get("notify_failed") else
                  "denied" if answer.get("choice") == "deny" else "expired" if not answer.get("resolved") else "not_granted")
        return {"action": "block", "status": "confirmation_" + status, "approval_request_id": request_id,
                "message": "EFFECT_CONFIRMATION_" + status.upper()}
    if not answer.get("confirmation"):
        return {"action": "block", "message": "EFFECT_CONFIRMATION_RECEIPT_REQUIRED"}
    decision = provider._request("/internal/hermes/effect-consent", {**body, "approved": True, "approval_request_id": request_id,
        "confirmation": answer["confirmation"]})
    return decision["approval"] if decision.get("status") == "allowed" else {"action": "block", "message": "EFFECT_CONSENT_NOT_GRANTED"}


def blocked(gate):
    return bool(gate) and gate.get("action") == "block"


def report_approval(tool_name, args, result, **kwargs):
    """Carry the server's decision from this execution into its tool result."""
    approval = args.get("effect", {}).get("approval") if tool_name in {"send_message", "phone_task", "mcp__phone__phone_task"} else None
    return json.dumps({**json.loads(result), "approval": approval}, ensure_ascii=False) if approval else None


def register_execution_gate(ctx, gate):
    """Human waits belong to one execution, never the process-wide bounded policy hook."""
    def execute(tool_name, args, next_call, **kwargs):
        from tools.interrupt import is_interrupted
        try:
            directive = gate(tool_name, args, **kwargs)
        except (Exception, SystemExit) as error:
            # Native middleware skips a callback that raises before next_call. Never fail open.
            return json.dumps({"error": "EFFECT_GATE_FAILED: " + type(error).__name__})
        if blocked(directive):
            return json.dumps({"error": directive["message"],
                **{key: value for key, value in directive.items() if key not in {"action", "message"}}}, ensure_ascii=False)
        if is_interrupted():
            return json.dumps({"error": "EFFECT_EXECUTION_CANCELLED", "status": "cancelled"})
        if not directive or directive.get("action") != "modify":
            return next_call(args)
        final_args = {**args, **directive["args"]}
        result = next_call(final_args)
        return report_approval(tool_name, final_args, result) or result
    ctx.register_middleware("tool_dispatch", execute)


def register(ctx, provider):
    packaged=callable(getattr(provider,'capability_enabled',None)) and provider.capability_enabled('messaging') is True
    if packaged:
        from .packaged_messaging import register as register_messaging
        register_messaging(ctx)
        if all(provider.capability_enabled(family) is True for family in ('wechat-mac','phone','owner-mac')):
            return
    from tools.send_message_tool import send_message_tool

    def sending(tool_name, args, session_id="", **kwargs):
        if tool_name != "send_message" or args.get("action") == "list":
            return None
        try:
            try:
                pinned, effect = prepare_message(args, args.get('requested'))
            except ValueError as error:
                if str(error) != 'static_webhook_recipient':
                    raise
                return {"action": "block", "message": "EFFECT_RECIPIENT_REQUIRED: 当前原生钉钉发送使用静态机器人 webhook，不按 target 选择收件人。请改用能核实真实收件人的 Mac 发送路径，并先调用 paios_effect_check。"}
            gate = check_effect(provider, tool_name, {"effect": effect}, session_id, kwargs.get("tool_call_id", ""))
            return gate if blocked(gate) else {"action": "modify", "args": {
                "target": pinned['target'], "effect": {**effect, "approval": gate}}}
        except ValueError:
            return {"action": "block", "message": "EFFECT_RECIPIENT_REQUIRED: 请先查询联系人，提供已核实的平台账号地址；不能用昵称、默认目标或空收件人发送。"}
        except Exception as error:
            return {"action": "block", "message": "EFFECT_CONSENT_FAILED: " + type(error).__name__}

    def explicit(args, **kwargs):
        gate = check_effect(provider, "paios_effect_check", args, kwargs.get("session_id", ""), kwargs.get("tool_call_id", ""))
        return json.dumps({"allowed": False, "reason": gate["message"],
                          **{key: gate[key] for key in ("status", "approval_request_id") if key in gate}} if blocked(gate) else
                          {"allowed": True, **({"approval": gate} if gate else {})}, ensure_ascii=False)

    schema = send_message_schema()
    schema["description"] = "向明确的平台账号发送消息、文件或回应，或用 action=list 查询联系人。首次发送由服务器确认，同人同类在新会话沿用。"
    schema["parameters"]["properties"]["target"]["description"] = (
        "已核实的平台稳定地址，不能只填平台名或默认目标。先用 action=list 查询联系人；"
        "例如 email:li@example.com、telegram:12345678、telegram:-1001234567890:17585、feishu:ou_verified_id。")
    schema["parameters"]["properties"]["requested"] = {
        "type": "boolean", "description": "仅主人明确要求本次发送时为 true；否则每次确认。收件人和任务类型由实际 target 和 action 推导。"}
    if not packaged and ctx.register_tool("send_message", "messaging", schema, send_message_tool, override=True) is None:
        raise RuntimeError("Effect-gated sender was not registered")
    schema = {"name": "paios_effect_check", "description": "自制工具、terminal/execute_code 脚本和未接入代码门禁的 Mac 发送，执行前必须调用。只有 allowed=true 才执行同一效果；拒绝或不可达立即停止。服务器保存同一人同一任务类型的首次确认，原生 memory 不保存授权。",
              "parameters": {"type": "object", "additionalProperties": False, "required": ["effect"], "properties": {"effect": {
                  "type": "object", "additionalProperties": False, "required": ["kind", "task_type", "requested"], "properties": {
                      "kind": {"type": "string", "enum": ["read", "file_edit", "send", "login", "delete", "external"]},
                      "recipient": {"type": "string", "minLength": 1, "maxLength": 200, "description": "发送必填。已核实的平台稳定账号地址，不能填昵称。"},
                      "task_type": {"type": "string", "minLength": 1, "maxLength": 100}, "requested": {"type": "boolean"},
                      "summary": {"type": "string", "maxLength": 240, "description": "仅确认展示的短预览，不含密钥，不属于授权键。"}}}}}}
    if ctx.register_tool("paios_effect_check", "effects", schema, explicit) is None:
        raise RuntimeError("Explicit effect check was not registered")
    if not packaged:
        register_execution_gate(ctx, sending)


# The upstream sender no longer exports its schema or e-mail pattern; the package and the legacy path share these.
_EMAIL_TARGET_RE = re.compile(r"^\s*[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\s*$")


def send_message_schema():
    return json.loads(Path(__file__).with_name("send-message.schema.json").read_text())


def prepare_message(args, requested=False):
    from tools.send_message_tool import _resolve_tool_target
    from tools.send_message_targets import _parse_target_ref
    from gateway.channel_directory import load_directory
    target = args.get('target', '')
    if not isinstance(target, str) or ':' not in target:
        raise ValueError('recipient')
    platform, reference = target.split(':', 1)
    platform, reference = platform.strip().lower(), reference.strip()
    if platform == 'dingtalk' and args.get('action', 'send') == 'send':
        raise ValueError('static_webhook_recipient')
    _, _, explicit_address = _parse_target_ref(platform, reference)
    if not explicit_address or platform == 'wecom':
        entries = load_directory().get('platforms', {}).get(platform, [])
        if not any(entry.get('id') == reference for entry in entries):
            raise ValueError('recipient')
    platform, recipient, thread, error = _resolve_tool_target(target)
    if error or not recipient or recipient.startswith(('user_name:', 'http:', 'https:')):
        raise ValueError('recipient')
    if platform == 'email' and not _EMAIL_TARGET_RE.fullmatch(recipient):
        raise ValueError('recipient')
    effect = {'kind': 'send', 'recipient': f'{platform}:{recipient}',
              'task_type': f"send_message:{platform}:{args.get('action', 'send')}",
              'requested': requested is True,
              'summary': str(args.get('message') or args.get('emoji') or '撤回回应')[:240]}
    address = recipient.removeprefix('user:') if platform == 'slack' else recipient
    return {**args, 'target': f'{platform}:{address}' + (f':{thread}' if thread else '')}, effect
