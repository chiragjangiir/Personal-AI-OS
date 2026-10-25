import {createInterface} from 'node:readline';
import {readFileSync} from 'node:fs';
import {succeeded, value, to_mcp_result} from '/opt/yimi/capability/sdk/ts/receipt.ts';

// Alternative entry for mcp.json. Select one language and remove the unused entry.
for await (const line of createInterface({input: process.stdin})) {
  const request = JSON.parse(line);
  if (!Object.hasOwn(request, 'id')) continue;
  let result: unknown;
  switch (request.method) {
    case 'initialize': result = {protocolVersion: '2024-11-05', capabilities: {tools: {}},
      serverInfo: {name: 'capability', version: '0.1.0'}}; break;
    case 'tools/list': result = {tools: [{name: 'sample', description: 'Inspect a sample value',
      inputSchema: {type: 'object', properties: {}, additionalProperties: false},
      outputSchema: JSON.parse(readFileSync('/opt/yimi/capability/contracts/receipt.v1.schema.json', 'utf8'))}]}; break;
    case 'tools/call': result = to_mcp_result(succeeded({values: [value(
      'sample', 1, 'none', 'computed', 'sample', '2026-10-24T00:00:00Z')]})); break;
    case 'ping': result = {}; break;
    default: process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: request.id,
      error: {code: -32601, message: 'Unknown method'}}) + '\n'); continue;
  }
  process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: request.id, result}) + '\n');
}
