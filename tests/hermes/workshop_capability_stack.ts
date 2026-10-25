/** Test-only P1/P3 seams around the real registry and real namespace runner. */
import {createInterface} from 'node:readline';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {CapabilityRegistry} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/capability/registry/registry.ts';
import {OfflineRegistrationRunner} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/capability/registry/runner.ts';
import {declaredEffect} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/capability/registry/checks.ts';
import {admitReceipt} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/capability/receipt.ts';
import type {PackageVersion, PackageFiles} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/capability/registry/interfaces.ts';
const exec = promisify(execFile);
const [root, out, deps] = process.argv.slice(2) as [string, string, string];
const python = process.env.PAIOS_HERMES_PYTHON!;
const context = {principal_id: 'synthetic-owner', run_id: 'model-probe', scope: 'owner'};
const enabled = new Map<string, PackageVersion>(), drafts = new Map<string, PackageFiles>();
try {drafts.set('pdf-batch', JSON.parse(await readFile(join(out,
  process.env.PAIOS_CAPABILITY_RESUME_DRAFT === '1' ? 'unverified-draft.json' : 'model-package.json'), 'utf8')).files);}
catch (error: any) {if (error.code !== 'ENOENT') throw error;}
const outcomes = new Map<string, {total: number; failed: number; unknown: number}>();
let unhealthy = false;
const runner = new OfflineRegistrationRunner(python, deps);
const notify = () => process.stdout.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/tools/list_changed'}) + '\n');
const events: unknown[] = [];
async function record(event: unknown) {events.push(event); await writeFile(join(out, 'stack-events.json'), JSON.stringify(events, null, 2));}
async function invoke(version: PackageVersion, method: string, params = {}) {
  return new Promise<any>((resolve, reject) => {
    const child = spawn(python, ['-B', join(root,
      '01-product-half-finished/backend/services/personal-aios-integration/src/capability/registry/runner.py'), version.root, 'invoke'], {
      env: {...process.env, PAIOS_CAPABILITY_TEST_DEPS: deps}, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => {stdout += data;}); child.stderr.on('data', data => {stderr += data;});
    child.on('error', reject); child.on('exit', code => {
      try {if (code) throw new Error(stderr || stdout); resolve(JSON.parse(stdout));} catch (error) {reject(error);}
    });
    readFile(join(out, 'sample-files.json'), 'utf8').then(files => child.stdin.end(JSON.stringify({method, params, files: JSON.parse(files)})), reject);
  });
}
const registry = new CapabilityRegistry(join(out, 'registry'), {
  installed: async () => [...enabled.values()],
  enabled: async () => [...enabled.values()],
  replace: async (_context, {name, expected, next}) => {
    if ((enabled.get(name)?.digest ?? null) !== expected) throw new Error('authority_cas_failed');
    if (next) {
      const check = await invoke(next, 'tools/list');
      if (check.exit) throw new Error('host_load_failed');
      enabled.set(name, next);
    } else enabled.delete(name);
    await record({action: 'replace', name, expected, next: next?.digest ?? null, hermes_restart: false}); notify();
  },
}, {check: path => runner.check(path), health: version => unhealthy ? Promise.resolve(false) : runner.health(version)},
{outcomes: async (_p, _n, digest) => outcomes.get(digest) ?? {total: 0, failed: 0, unknown: 0}}, {
  hub: async query => {
    const {stdout} = await exec(python, ['-c',
      "import sys;sys.path.insert(0,sys.argv[1]);from personal_aios.workshop import local_hub;import json;print(json.dumps(local_hub('search',sys.argv[2])))",
      join(root, 'integrations/hermes'), query], {timeout: 45000, maxBuffer: 1 << 20}); return JSON.parse(stdout);
  },
  mcp: async query => {
    const {stdout} = await exec(python, ['-c',
      "import json,sys,urllib.request,urllib.parse;print(json.dumps(json.load(urllib.request.urlopen('https://registry.modelcontextprotocol.io/v0.1/servers?'+urllib.parse.urlencode({'search':sys.argv[1],'limit':5}),timeout=15))['servers']))", query],
      {timeout: 30000, maxBuffer: 1 << 20}); return JSON.parse(stdout);
  },
});
const definitions = [
  ['capability_find', 'Find reusable capabilities before building', {query: {type: 'string'}}, ['query']],
  ['capability_build', 'Build or repair your PDF package with your isolated Hermes model builder; pass registration errors as feedback to repair', {feedback: {type: 'string'}}, []],
  ['capability_check', 'Run the blocking registration checks on your draft', {}, []],
  ['capability_publish', 'Directly publish the checked candidate without restarting Hermes', {candidate_id: {type: 'string'}}, ['candidate_id']],
  ['capability_rollback', 'Undo your most recent package publication', {}, []],
  ['capability_status', 'Read enabled packages and the most recent publication', {}, []],
];
async function tools() {
  const list: any[] = definitions.map(([name, description, properties, required]) => ({name, description,
    inputSchema: {type: 'object', properties, required, additionalProperties: false}}));
  for (const version of enabled.values()) {
    const result = await invoke(version, 'tools/list');
    list.push(...result.messages.find((row: any) => row.id === 2).result.tools);
  }
  return list;
}
let checkedId = '';
async function call(name: string, args: any) {
  await record({action: name, args});
  let result: any;
  if (name === 'test_automatic_rollback') return {content: [{type: 'text', text: JSON.stringify(await automaticRollback())}]};
  if (name === 'capability_find') result = await registry.find(context, args.query);
  else if (name === 'capability_build') {
    const destination = join(out, 'model-package.json');
    await writeFile(join(out, 'build-request.json'), JSON.stringify({name: 'pdf-batch',
      input: '帮我做一个能批量处理 PDF 的能力' + (args.feedback ? '\n登记或测试失败，请修复同一个包：' + args.feedback : ''),
      ...(drafts.has('pdf-batch') ? {files: drafts.get('pdf-batch')} : {})}));
    try {
      await exec(python, [join(root, 'tests/hermes/workshop_capability_build_probe.py'), root,
        join(root, '.scratch/model-builder-home'), destination, deps], {timeout: 1200000, maxBuffer: 4 << 20});
    } catch (error) {
      try {drafts.set('pdf-batch', JSON.parse(await readFile(join(out, 'unverified-draft.json'), 'utf8')).files);}
      catch (missing: any) {if (missing.code !== 'ENOENT') throw missing;}
      throw error;
    }
    const draft = JSON.parse(await readFile(destination, 'utf8')); drafts.set('pdf-batch', draft.files);
    result = {name: draft.name, output: draft.output, manifest: JSON.parse(draft.files['plugin.json']), next: 'capability_check'};
  } else if (name === 'capability_check') {
    const checked = await registry.check(context, drafts.get('pdf-batch')!); checkedId = checked.candidate_id;
    await writeFile(join(out, 'registration-evidence.json'), JSON.stringify(checked, null, 2));
    result = {success: true, candidate_id: checkedId, cases: checked.evidence.cases.length};
  } else if (name === 'capability_publish') result = await registry.publish(context, args.candidate_id);
  else if (name === 'capability_rollback') result = await registry.rollback(context);
  else if (name === 'capability_status') result = await registry.status(context);
  else {
    const version = [...enabled.values()].find(v => v.manifest.extensions['ai.yimi.capability'].tools[name]);
    if (!version) throw new Error('not_enabled');
    // P3 test seam admits only synthetic workspace work; no real external effect is possible.
    if (!version.manifest.extensions['ai.yimi.capability'].scopes.includes(context.scope)) throw new Error('package_scope_denied');
    const effect = declaredEffect(version.manifest.extensions['ai.yimi.capability'].tools[name], args);
    if (effect !== 'workspace' && effect !== 'observe') throw new Error('consent_stub_external_effect_denied');
    delete args.owner_requested;
    const response = await invoke(version, 'tools/call', {name, arguments: args});
    result = response.messages.find((row: any) => row.id === 2)?.result;
    if (response.exit || response.audit.network.length) throw new Error('runtime_sandbox_failed');
    result.structuredContent = admitReceipt(result.structuredContent);
    const counts = outcomes.get(version.digest) ?? {total: 0, failed: 0, unknown: 0};
    counts.total++; if (result.structuredContent.status.state === 'failed') counts.failed++;
    if (result.structuredContent.status.state === 'unknown') counts.unknown++;
    outcomes.set(version.digest, counts);
    await record({action: 'call', name, receipt: result.structuredContent, audit: response.audit});
  }
  return result?.structuredContent ? result : {content: [{type: 'text', text: JSON.stringify(result)}]};
}
async function automaticRollback() {
  const original = drafts.get('pdf-batch')!;
  const current = await registry.publish(context, checkedId);
  outcomes.set(current.version.digest, {total: 100, failed: 0, unknown: 0});
  const next = {...original}, manifest = JSON.parse(next['plugin.json']!); manifest.version = '9.0.0'; next['plugin.json'] = JSON.stringify(manifest);
  const checked = await registry.check(context, next); await registry.publish(context, checked.candidate_id);
  outcomes.set(checked.digest, {total: 100, failed: 40, unknown: 40});
  const regression = await registry.monitor(context, 'pdf-batch');
  manifest.version = '9.0.1'; next['plugin.json'] = JSON.stringify(manifest);
  await registry.publish(context, (await registry.check(context, next)).candidate_id); unhealthy = true;
  const health = await registry.monitor(context, 'pdf-batch'); unhealthy = false;
  const result = {regression, health}; await record({action: 'automatic_rollback', result});
  await registry.rollback(context);
  return result;
}
await mkdir(out, {recursive: true});
for await (const line of createInterface({input: process.stdin})) {
  const request = JSON.parse(line); if (!Object.hasOwn(request, 'id')) continue;
  try {
    let result;
    switch (request.method) {
      case 'initialize': result = {protocolVersion: '2024-11-05', capabilities: {tools: {listChanged: true}},
        serverInfo: {name: 'test-capability-platform', version: '1'}}; break;
      case 'tools/list': result = {tools: await tools()}; break;
      case 'tools/call': result = await call(request.params.name, request.params.arguments ?? {}); break;
      case 'test/automatic-rollback': result = await automaticRollback(); break;
      case 'ping': result = {}; break;
      default: throw new Error('method_not_found');
    }
    process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: request.id, result}) + '\n');
  } catch (error: any) {
    await record({action: 'error', method: request.method, error: error.message});
    process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: request.id, error: {code: -32603, message: error.message}}) + '\n');
  }
}
