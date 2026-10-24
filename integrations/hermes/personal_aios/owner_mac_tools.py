"""Bind owner Mac MCP operations to the current native owner run."""


def register(ctx):
    import os
    phone = {'phone_task', 'phone_status', 'phone_start', 'phone_control_link'}
    def bind(tool_name, args, session_id='', **kwargs):
        if tool_name not in {'mcp__owner_mac__exec', 'mcp__owner_mac__read', 'mcp__owner_mac__write',
                             'mcp__owner_mac__fetch', 'mcp__owner_mac__put'} and not (
                os.environ.get('PAIOS_PHONE_PROVIDER') == 'mac-android' and tool_name.removeprefix('mcp__phone__') in phone):
            return None
        try:
            from gateway.run_scope import current_scope
            from gateway.session_context import get_api_run_id
            context = {'run_id': get_api_run_id(session_id), 'session_id': session_id,
                       'tool_call_id': kwargs.get('tool_call_id', '')}
            if current_scope() != 'owner' or not all(context.values()):
                return {'action': 'block', 'message': 'OWNER_MAC_RUN_BINDING_REQUIRED'}
            return {'action': 'modify', 'args': {**args, 'context': context}}
        except Exception as error:
            # Native hook failures otherwise continue dispatch with untrusted arguments.
            return {"action": "block", "message": "OWNER_MAC_CONTEXT_FAILED:" + type(error).__name__}

    ctx.register_hook('pre_tool_call', bind)
