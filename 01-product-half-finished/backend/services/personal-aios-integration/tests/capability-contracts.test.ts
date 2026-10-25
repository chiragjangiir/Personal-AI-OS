import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import Ajv2020Module from 'ajv/dist/2020.js';
import {admitReceipt} from '../src/capability/receipt.ts';
import * as sdk from '../../../../../capability/sdk/ts/receipt.ts';

const root = new URL('../../../../../', import.meta.url);
const contracts = new URL('capability/contracts/', root);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, contracts), 'utf8'));
const ajv = new Ajv2020Module.default({strict: true});
ajv.addFormat('date-time', value => Number.isFinite(Date.parse(value)));
const validReceipt = ajv.compile(read('receipt.v1.schema.json'));
const validManifest = ajv.compile(read('manifest.v1.schema.json'));
const validPlugin = ajv.compile(read('upstream/plugin-1.0.0.schema.json'));
const receiptExample = (name: string): sdk.Receipt => read(`examples/receipts/${name}.json`);
const pluginExample = (name = 'mijia') => read(`examples/${name}/plugin.json`);
const extension = (plugin: ReturnType<typeof pluginExample>) => plugin.extensions['ai.yimi.capability'];

for (const name of readdirSync(new URL('examples/receipts/', contracts))) {
  test(`receipt fixture ${name} validates and preserves its facts`, () => {
    const body = read(`examples/receipts/${name}`);
    assert.equal(validReceipt(body), true, ajv.errorsText(validReceipt.errors));
    assert.deepEqual(admitReceipt(body), body);
  });
}
for (const name of ['mijia', 'wechat-mac', 'pdf-batch']) {
  test(`manifest fixture ${name} validates in both contracts`, () => {
    const plugin = pluginExample(name);
    assert.equal(validPlugin(plugin), true, ajv.errorsText(validPlugin.errors));
    assert.equal(validManifest(extension(plugin)), true, ajv.errorsText(validManifest.errors));
  });
}

test('missing or empty units violate admission; unitless values explicitly use none', () => {
  const body = receiptExample('pdf-batch.partial');
  const first = body.values[0]!;
  for (const invalid of [undefined, '', ' ']) {
    const raw = {...body, values: [{...first, unit: invalid}]};
    assert.equal(validReceipt(raw), false);
    const admitted = admitReceipt(raw);
    assert.equal(admitted.status.state, 'unknown');
    assert.equal(admitted.status.reason_code, 'CAPABILITY_RECEIPT_INVALID');
    assert.equal(admitted.unknowns[0]!.about, 'contract_violation');
  }
  first.unit = 'none';
  assert.equal(validReceipt(body), true);
});

for (const verification of ['not_verified', 'unknown'] as const) {
  test(`success with only ${verification} effects becomes unknown`, () => {
    const raw = receiptExample('wechat-send.verified');
    raw.effects[0]!.verification = verification;
    const snapshot = structuredClone(raw);
    const admitted = admitReceipt(raw);
    assert.equal(admitted.status.state, 'unknown');
    assert.equal(admitted.unknowns.at(-1)!.about, 'contradiction');
    assert.deepEqual(raw, snapshot);
    assert.deepEqual(admitted.effects, raw.effects);
  });
}
test('mixed verification becomes partial; service_ack and read-only success are preserved', () => {
  const body = receiptExample('wechat-send.verified');
  body.effects.push({...body.effects[0]!, verification: 'not_verified'});
  assert.equal(admitReceipt(body).status.state, 'partial');
  assert.equal(admitReceipt(receiptExample('mijia.succeeded')).status.state, 'succeeded');
  assert.equal(admitReceipt(sdk.succeeded()).status.state, 'succeeded');
});

for (const code of ['TOOL_TIMEOUT', 'MIJIA_DISCONNECTED', 'TIMEOUT', 'TRANSPORT_DISCONNECTED_BEFORE_ACK']) {
  test(`${code} never proves failure or permits a blind retry`, () => {
    const body = sdk.failed({status: {reason_code: code}, next: {retry: 'allowed'}});
    const admitted = admitReceipt(body);
    assert.equal(admitted.status.state, 'unknown');
    assert.equal(admitted.status.reason_code, code);
    assert.equal(admitted.next.retry, 'after_check');
    assert.equal(body.status.state, 'failed');
  });
}
test('a package cannot author a gateway rejection', () => {
  const admitted = admitReceipt(sdk.rejected());
  assert.equal(admitted.status.state, 'unknown');
  assert.equal(admitted.status.reason_code, 'CAPABILITY_PACKAGE_REJECTED');
  assert.equal(admitted.next.retry, 'after_check');
});
for (const raw of [null, 'done', {success: true}, {isError: false}, {receipt: 2}, sdk.to_mcp_result(sdk.succeeded())]) {
  test(`non-receipt ${JSON.stringify(raw)} stays unknown`, () => {
    const admitted = admitReceipt(raw);
    assert.equal(admitted.status.state, 'unknown');
    assert.equal(admitted.status.reason_code, 'CAPABILITY_RECEIPT_INVALID');
    assert.deepEqual(admitted.effects, []);
  });
}
test('additive receipt fields survive; malformed job revisions fail without a second job store', () => {
  const raw = {...sdk.running(), future_optional_field: {count: 3}};
  assert.deepEqual(admitReceipt(raw), raw);
  assert.equal(validReceipt(sdk.running({job: {id: 'job', revision: -1}})), false);
  assert.equal(validReceipt(sdk.running({job: {id: 'job', revision: 1.5}})), false);
});

for (const effect of ['spend', 'self_change']) {
  for (const byArg of [false, true]) {
    test(`yimi cannot declare ${effect}, by_arg=${byArg}; lead can`, () => {
      const manifest = extension(pluginExample('pdf-batch'));
      manifest.tools = {tool: byArg ? {effect_by_arg: {'$.action': {read: 'observe', act: effect}}} : {effect}};
      assert.equal(validManifest(manifest), false);
      manifest.maintainer = 'lead';
      assert.equal(validManifest(manifest), true, ajv.errorsText(validManifest.errors));
    });
  }
}
test('each tool declares exactly one classification, including every argument branch', () => {
  const manifest = extension(pluginExample());
  for (const tool of [{}, {effect: 'observe', effect_by_arg: {'$.action': {read: 'observe'}}},
    {effect_by_arg: {'$.action': {read: 'not_a_class'}}}]) {
    manifest.tools = {tool};
    assert.equal(validManifest(manifest), false);
  }
});
test('secret descriptors accept names only; values cannot be hidden under other fields', () => {
  const manifest = extension(pluginExample());
  manifest.secrets = [{name: 'mijia-session'}];
  assert.equal(validManifest(manifest), true);
  for (const field of ['value', 'env', 'token', 'store']) {
    manifest.secrets = [{name: 'MIJIA_SESSION', [field]: 'fixture-not-a-secret'}];
    assert.equal(validManifest(manifest), false);
  }
});
test('manifest scopes match current Hermes scopes including the derived care scope', () => {
  const manifest = extension(pluginExample());
  manifest.scopes = ['owner', 'owner_uncertain', 'guest', 'build', 'care'];
  assert.equal(validManifest(manifest), true);
  manifest.scopes.push('admin');
  assert.equal(validManifest(manifest), false);
});

const api = read('gateway-api.v1.json');
const ids = {task_id: '', session_id: 'session', tool_call_id: 'call', turn_id: 'turn', api_request_id: ''};
const call = {tool_name: 'wechat_send', args: {contact_id: 'fixture', owner_requested: true}, ...ids};
const result = {...call, result: {success: true}, duration_ms: 2, status: 'ok', error_type: null, error_message: null};
const payloads = {
  decide: {schema: 'PreToolCall', body: {...call, middleware_trace: []}},
  receipt: {schema: 'TransformToolResult', body: result},
  observe: {schema: 'PostToolCall', body: {...result, middleware_trace: []}},
  lineage: {schema: 'SubagentStart', body: {parent_session_id: 'parent', parent_turn_id: 'turn', parent_subagent_id: null,
    child_session_id: 'child', child_subagent_id: 'child-id', child_role: 'worker', child_goal: 'fixture'}},
};
for (const [path, {schema, body}] of Object.entries(payloads)) {
  test(`gateway ${path} accepts the documented hook payload, including legacy telemetry`, () => {
    const validate = ajv.compile(api.components.schemas[schema]);
    assert.equal(validate(body), true, ajv.errorsText(validate.errors));
    assert.equal(validate({...body, telemetry_schema_version: 'hermes.observer.v1'}), true);
    assert.equal(validate({...body, invented_run_id: 'forbidden'}), false);
    assert.equal(api.paths[`/gateway/${path}`].post.requestBody.content['application/json'].schema.$ref,
      `#/components/schemas/${schema}`);
    const status = path === 'observe' || path === 'lineage' ? '204' : '200';
    assert.ok(api.paths[`/gateway/${path}`].post.responses[status]);
    if (status === '204') assert.equal(api.paths[`/gateway/${path}`].post.responses[status].content, undefined);
  });
}
test('gateway directives are unambiguous and receipt responses contain only model_view', () => {
  assert.equal(api.openapi, '3.1.0');
  assert.equal(api['x-yimi-gateway-api'], 1);
  const validate = ajv.compile(api.components.schemas.Decision);
  for (const body of [{action: 'allow'}, {action: 'modify', args: {principal_id: 'owner'}},
    {action: 'block', message: 'blocked'}, {action: 'approve', message: 'approve', rule_key: 'yimi:fixture'}]) {
    assert.equal(validate(body), true, ajv.errorsText(validate.errors));
  }
  for (const body of [{action: 'allow', args: {}}, {action: 'modify'}, {action: 'block', message: ''},
    {action: 'approve', message: 'missing rule'}, {allow: true, block: 'ambiguous'}]) assert.equal(validate(body), false);
  const view = ajv.compile(api.components.schemas.ReceiptView);
  assert.equal(view({model_view: 'unknown'}), true);
  assert.equal(view({model_view: 'unknown', receipt: 1}), false);
});

test('effect catalogue maps nine classes to actual gate definitions without changing requested semantics', () => {
  const catalogue = read('effect-classes.v1.json');
  assert.deepEqual(Object.keys(catalogue.classes), ['observe', 'workspace', 'owner_data', 'send', 'account', 'delete', 'physical', 'spend', 'self_change']);
  for (const entry of Object.values(catalogue.classes) as {gates: {function: string; file: string}[]}[]) {
    for (const gate of entry.gates) {
      const source = readFileSync(new URL(gate.file, root), 'utf8');
      assert.ok(new RegExp(`(?:def |function |async |\\s)${gate.function.split('.').at(-1)}\\(`, 'u').test(source), `${gate.function} in ${gate.file}`);
    }
  }
  assert.equal(catalogue.owner_requested.forwarded_to_tool, false);
  assert.equal(catalogue.owner_requested.current_rule, 'required = sending || !effect.requested; persistent = sending && effect.requested');
});
test('Python and TS helpers produce identical schema-valid MCP receipts for every state', () => {
  const states = ['succeeded', 'partial', 'failed', 'unknown', 'running', 'accepted', 'waiting', 'cancelled', 'rejected'] as const;
  const time = '2026-10-24T13:03:12Z';
  const fields = {effects: [sdk.effect('workspace', 'workspace/output', 'write', 'verified', 'fixture readback')],
    values: [sdk.value('temperature', 26.25, '°C', 'observed', 'fixture', time)],
    unknowns: [sdk.unknown_fact('reader', 'no read receipt')]};
  const python = spawnSync('python3', ['-c',
    'import json,sys; from capability.sdk.python import yimi_receipt as s; states,fields=json.load(sys.stdin); print(json.dumps([s.to_mcp_result(getattr(s,state)(**fields)) for state in states]))'],
    {cwd: root, input: JSON.stringify([states, fields]), encoding: 'utf8', env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}});
  assert.equal(python.status, 0, python.stderr);
  const actual = states.map(state => sdk.to_mcp_result(sdk[state](fields)));
  assert.deepEqual(actual, JSON.parse(python.stdout));
  for (const result of actual) assert.equal(validReceipt(result.structuredContent), true, ajv.errorsText(validReceipt.errors));
  const body = sdk.partial({status: {progress: {done: 47, total: 50, unit: '份'}}});
  assert.equal(sdk.to_mcp_result(body).content[0]!.text, 'partial 47/50 份');
  assert.equal(sdk.to_mcp_result(body, 'partial\n47/50\t份').content[0]!.text, 'partial 47/50 份');
});
