import {readFileSync, readdirSync} from 'node:fs';
import type {TSHostTool} from '../src/capability/ts/host.ts';
export const packagesRoot = new URL('../../../../../capability/packages/', import.meta.url);
export const packageNames = readdirSync(packagesRoot).filter(name => name.startsWith('ts-') && name !== 'ts-host');
export const manifest = (name: string) => JSON.parse(readFileSync(new URL(`${name}/plugin.json`, packagesRoot), 'utf8'));
export const cases = (name: string): {id: string; tool: string; args: Record<string, unknown>; raw: any; expected: {state: string}}[] =>
  JSON.parse(readFileSync(new URL(`${name}/tests/contract.yaml`, packagesRoot), 'utf8')).cases;
/** Test catalog seam: production receives the existing enabled-package catalog. */
export function catalogStub(names = packageNames) {
  const tools = new Map<string, TSHostTool>();
  for (const name of names) {
    const extension = manifest(name).extensions['ai.yimi.capability'];
    for (const [tool, policy] of Object.entries(extension.tools)) tools.set(`mcp__${extension.runtime.server}__${tool}`,
      {package: name, server: extension.runtime.server, name: tool, ...policy as object});
  }
  return tools;
}
/** Test-only gateway context injection; runtime re-resolves these keys through admission on every call. */
export function gatewayContextStub(context: {run_id: string; session_id: string; tool_call_id: string}, args: Record<string, unknown>) {
  return {...args, _context: {...context}};
}
