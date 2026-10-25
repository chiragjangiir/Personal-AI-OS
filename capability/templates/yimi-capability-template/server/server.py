"""Minimal JSON-lines MCP entry; the receipt implementation is the shared SDK."""
import json
import sys
from pathlib import Path
from capability.sdk.python.yimi_receipt import succeeded, to_mcp_result, value


def call(name, args):
    if name != 'sample':
        raise ValueError('Unknown tool')
    return to_mcp_result(succeeded(values=[value(
        'sample', 1, 'none', 'computed', 'sample', '2026-10-24T00:00:00Z')]))


def serve():
    for line in sys.stdin:
        request = json.loads(line)
        if 'id' not in request:
            continue
        method = request['method']
        if method == 'initialize':
            result = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}},
                      'serverInfo': {'name': 'capability', 'version': '0.1.0'}}
        elif method == 'tools/list':
            result = {'tools': [{'name': 'sample', 'description': 'Inspect a sample value',
                                 'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False},
                                 'outputSchema': json.loads(Path('/opt/yimi/capability/contracts/receipt.v1.schema.json').read_text())}]}
        elif method == 'tools/call':
            result = call(request['params']['name'], request['params'].get('arguments', {}))
        elif method == 'ping':
            result = {}
        else:
            print(json.dumps({'jsonrpc': '2.0', 'id': request['id'],
                              'error': {'code': -32601, 'message': 'Unknown method'}}), flush=True)
            continue
        print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)


if __name__ == '__main__':
    serve()
