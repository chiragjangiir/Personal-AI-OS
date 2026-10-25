"""Keep native live channel adapters while loading the package through the gateway's switch."""
import json
from capability.packages.messaging.server.server import create, parameters, prepare
from capability.sdk.python.yimi_receipt import to_mcp_result


def register(ctx):
    from tools.send_message_tool import send_message_tool
    delivery = create(sender=send_message_tool)
    def pin(tool_name,args,**kwargs):
        if tool_name != 'send_message':
            return None
        try:
            pinned, _ = prepare(args)
            return {'action':'modify','args':{**pinned,'owner_requested':args.get('owner_requested') is True}}
        except ValueError:
            return {'action':'block','message':'EFFECT_RECIPIENT_REQUIRED'}
    ctx.register_hook('pre_tool_call',pin)
    schema = {'name': 'send_message', 'description': '发送到已核实的稳定平台地址，或 action=list 查询联系人。',
              'parameters': parameters()}

    def send(args, **kwargs):
        if 'effect' in args:
            raise ValueError('EFFECT_ARGUMENT_REMOVED')
        args = {k: v for k, v in args.items() if k != 'owner_requested'}
        return json.dumps(to_mcp_result(delivery.invoke(**args)), ensure_ascii=False)

    ctx.register_tool('send_message', 'messaging', schema, send, override=True)
    schema = {'name': 'message_status', 'description': '只读核对原发送调用的执行回执。',
              'parameters': {'type': 'object', 'required': ['idempotency_key'],
                             'properties': {'idempotency_key': {'type': 'string'}, 'owner_requested': {'type': 'boolean'}}}}
    ctx.register_tool('message_status', 'messaging', schema,
                      lambda args, **kw: json.dumps(to_mcp_result(delivery.status(args['idempotency_key'])), ensure_ascii=False))
    # The explicit effect classifier is retired on this path; invoke a manifest-declared capability instead.
