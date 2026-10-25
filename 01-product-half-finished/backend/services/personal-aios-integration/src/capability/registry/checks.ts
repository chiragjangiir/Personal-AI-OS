import Ajv2020Module from 'ajv/dist/2020.js';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {posix} from 'node:path';
import {admitReceipt} from '../receipt.ts';
import type {ContractEvidence, PackageFiles} from './interfaces.ts';

const contracts = new URL('../../../../../../../capability/contracts/', import.meta.url);
const ajv = new Ajv2020Module.default({strict: true});
const schema = (name: string) => JSON.parse(readFileSync(new URL(name, contracts), 'utf8'));
const wrapper = ajv.compile<Record<string, any>>(schema('upstream/plugin-1.0.0.schema.json'));
const extension = ajv.compile<Record<string, any>>(schema('manifest.v1.schema.json'));
const secret = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b|Bearer\s+[A-Za-z0-9._~+/-]{12,}|(?:https?:\/\/)[^\s/:]+:[^\s/@]+@|(?:api[_-]?key|password|access[_-]?token|client[_-]?secret)\s*["']?\s*[:=]\s*["'][^"'\s$]{8,}["']/iu;

export function packageDigest(files: PackageFiles): string {
  return createHash('sha256').update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
}

/** Uploaded files are the trust boundary. Error messages never echo file contents. */
export function inspectPackage(files: PackageFiles) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('package_files_invalid');
  for (const [path, text] of Object.entries(files)) {
    if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..') ||
        posix.normalize(path) !== path || typeof text !== 'string' || text.includes('\0')) throw new Error('package_path_invalid');
    if (['plugin.yaml', 'plugin.yml', '__init__.py', 'hooks.json'].includes(path) || path.startsWith('hooks/')) {
      throw new Error('portable_package_only');
    }
    if (/(?:^|\/)(?:\.env(?:\..*)?|id_rsa|id_ed25519|[^/]+\.(?:key|p12|pfx))$/iu.test(path) || secret.test(text)) {
      throw new Error('secret_value_in_package:' + path);
    }
  }
  const manifest = JSON.parse(files['plugin.json'] ?? 'null');
  if (!wrapper(manifest)) throw new Error('manifest_invalid:' + ajv.errorsText(wrapper.errors));
  const cap = manifest.extensions?.['ai.yimi.capability'];
  if (!extension(cap)) throw new Error('manifest_invalid:' + ajv.errorsText(extension.errors));
  if (cap.maintainer !== 'yimi') throw new Error('workshop_requires_yimi_maintainer');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)) throw new Error('package_version_invalid');
  for (const host of cap.network.egress) {
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/iu.test(host)) throw new Error('egress_hostname_invalid');
  }
  const mcp = JSON.parse(files['mcp.json'] ?? 'null');
  const server = mcp?.mcpServers?.[cap.runtime.server];
  if (!server || mcp.$schema !== 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' ||
      Object.keys(mcp).some(key => !['$schema', 'mcpServers'].includes(key)) || server.type !== 'stdio' ||
      Object.keys(mcp.mcpServers).length !== 1 || !['python3', 'node'].includes(server.command) || !Array.isArray(server.args) ||
      server.env || server.url || !server.args.every((arg: unknown) => typeof arg === 'string') ||
      Object.keys(server).some(key => !['type', 'command', 'args'].includes(key)) ||
      !Object.hasOwn(files, server.args[0])) throw new Error('package_stdio_entry_invalid: mcpServers key must match runtime.server; require portable schema, stdio type and a package-relative entry');
  if (!files[cap.tests.contract] || !Object.keys(files).some(p => /^skills\/[^/]+\/SKILL\.md$/u.test(p)) ||
      !Object.keys(files).some(p => p.startsWith('fake/')) || !files['scripts/test.py']) throw new Error('package_layout_invalid');
  if (!cap.provenance.adapter_modules.includes(server.args[0])) throw new Error('adapter_entry_undeclared:declare_the_MCP_entry_and_keep_it_within_200_lines');
  let adapterLines = 0;
  for (const path of cap.provenance.adapter_modules) {
    if (!Object.hasOwn(files, path)) throw new Error('adapter_budget_exceeded:' + path);
    adapterLines += files[path]!.split(/\r?\n/u).length - Number(files[path]!.endsWith('\n'));
  }
  if (adapterLines > 200) throw new Error('adapter_budget_exceeded:combined_conversion_modules');
  const sizes = Object.values(files).map(text => Buffer.byteLength(text));
  // The existing reason/approval policy remains available to the legacy lifecycle. New
  // package publication has hard caps: exceeding them asks the builder to reduce scope.
  if (sizes.some(size => size > 131072) || sizes.length > 32 || sizes.reduce((a, b) => a + b, 0) > 524288) {
    throw new Error('package_budget_exceeded');
  }
  return {manifest, cap, digest: packageDigest(files)};
}

function declaredEffect(tool: any, args: Record<string, unknown>): string | undefined {
  if (tool.effect) return tool.effect;
  const [path, choices] = Object.entries(tool.effect_by_arg)[0] as [string, Record<string, string>];
  const keys = path.slice(2).replace(/\[['"]?([^\]'" ]+)['"]?\]/gu, '.$1').split('.');
  let value: any = args;
  for (const key of keys) value = value?.[key];
  return choices[String(value)];
}
export {declaredEffect};

export function verifyEvidence(cap: any, evidence: ContractEvidence): void {
  if (!evidence.success || !evidence.cases.length) throw new Error('contract_failed:' + evidence.errors.join(','));
  for (const name of Object.keys(cap.tools)) {
    for (const implementation of ['fake', 'server']) {
      if (!evidence.cases.some(row => row.tool === name && row.implementation === implementation)) {
        throw new Error('contract_coverage_missing:' + name + ':' + implementation);
      }
    }
  }
  for (const row of evidence.cases) {
    const rule = cap.tools[row.tool];
    if (!rule || !declaredEffect(rule, row.args)) throw new Error('contract_effect_unmapped:' + row.tool);
    if (declaredEffect(rule, row.args) === 'observe' && row.writes.length) throw new Error('contract_observe_write:' + row.tool);
    const result = row.result as any;
    const admitted = admitReceipt(result?.structuredContent);
    if (JSON.stringify(admitted) !== JSON.stringify(result?.structuredContent) ||
        result.content?.length !== 1 || result.content[0].type !== 'text' || typeof result.content[0].text !== 'string') {
      throw new Error('contract_receipt_invalid:' + row.tool);
    }
    if (row.network.length) throw new Error('contract_egress_violation:' + row.tool);
  }
}
