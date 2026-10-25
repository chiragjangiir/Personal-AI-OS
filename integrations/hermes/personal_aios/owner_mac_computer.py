"""Bind Hermes' native Computer Use to the current owner's paired Mac."""
import copy
import json
import os
from pathlib import Path
import shlex
import sys

READ_ACTIONS = {'capture', 'list_apps', 'list_windows', 'wait'}
# macOS observation only: no AX request, GUI activation, clipboard read or input event.
IDLE = '''import ctypes
c=ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
c.CGEventSourceSecondsSinceLastEventType.argtypes=[ctypes.c_int,ctypes.c_uint32]
c.CGEventSourceSecondsSinceLastEventType.restype=ctypes.c_double
print(min(c.CGEventSourceSecondsSinceLastEventType(1,t) for t in (1,3,5,6,7,10,11,22)))
'''


def handle(args, provider, **kwargs):
    from .effects import check_effect, blocked
    if args['effect'].get('kind') == 'payment':
        raise ValueError('COMPUTER_USE_PAYMENT_FORBIDDEN')
    gate = check_effect(provider, 'computer_use', args, kwargs.get('session_id', ''), kwargs.get('tool_call_id', ''))
    if blocked(gate):
        return json.dumps({'error': gate['message']}, ensure_ascii=False)
    result = execute(args, **kwargs)
    if gate and isinstance(result, str):
        result = json.dumps({**json.loads(result), 'approval': gate}, ensure_ascii=False)
    return result


def execute(args, **kwargs):
    """Existing paired-Mac transport, after the caller's consent authority admitted the call."""
    from . import owner_mac
    from tools.computer_use.cua_backend import CuaDriverBackend
    from tools.computer_use.tool import handle_computer_use
    context = args['context']
    action = args['action']
    read_only = action in READ_ACTIONS
    binding = (owner_mac.resolve(context, args.get('device_id', ''), read_only=True) if read_only else
               owner_mac.resolve(context, args.get('device_id', '')))
    if args.get('bring_to_front') or args.get('raise_window'):
        raise ValueError('Owner Mac Computer Use does not persistently raise windows')
    if action not in READ_ACTIONS:
        with owner_mac.environment(context, binding['device_id']) as env:
            probe = env.execute(shlex.join(['python3', '-c', IDLE]), timeout=10, bounded_capture=True)
        if probe['returncode'] or float(probe['output'].strip()) < 2:
            raise RuntimeError('Owner input active or idle state unavailable; no computer input posted')
    forwarded = {key: value for key, value in args.items() if key not in {'context', 'device_id', 'effect'}}
    forwarded['delivery_mode'] = args.get('delivery_mode', 'background')
    inherited = {name: os.environ[name] for name in (
        'PAIOS_INTEGRATION_PORT', 'PAIOS_HERMES_SOURCE', 'PAIOS_OWNER_MAC_ROOT',
        'PAIOS_OWNER_MAC_HOST', 'PAIOS_OWNER_MAC_CUA_DRIVER') if name in os.environ}
    inherited['PAIOS_OWNER_MAC_CUA_OBSERVE'] = '1' if read_only else '0'
    transport = {'command': sys.executable, 'args': [str(Path(__file__).with_name('owner_mac_cua.py')),
        json.dumps(context), binding['device_id']], 'env': inherited}
    def factory(permission_mode):
        return CuaDriverBackend(permission_mode=permission_mode, driver_transport=transport)
    factory.cache_key = (context['run_id'], binding['device_id'], read_only)
    return handle_computer_use(forwarded, backend_factory=factory, approval_gate=lambda action, arguments: None, **kwargs)


def register(ctx, provider):
    from tools.computer_use.schema import COMPUTER_USE_SCHEMA
    schema = copy.deepcopy(COMPUTER_USE_SCHEMA)
    schema['description'] += (' This tool drives the current owner Mac through its existing owner_mac relay. '
        'Read local-tools and owner-mac-computer-use first. Background is default; foreground only after observed '
        'background failure and owner idle. Never handle permission/login dialogs or payments. '
        'Before any external send call paios_effect_check and require allowed=true. '
        'Tool results are observations, not proof of an external effect.')
    schema['parameters']['properties'].update(
        device_id={'type': 'string', 'description': 'Select an exact paired Mac when several are online.'},
        effect={'type': 'object', 'description': 'Actual effect, using the paios_effect_check contract.'})
    schema['parameters']['required'] = [*schema['parameters'].get('required', []), 'effect']
    def execute(args, **kwargs):
        return handle(args, provider, **kwargs)
    if ctx.register_tool('computer_use', 'computer_use', schema, execute, override=True) is None:
        raise RuntimeError('Owner Mac native Computer Use was not registered')
