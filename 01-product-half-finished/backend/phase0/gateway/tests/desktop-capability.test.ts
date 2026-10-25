import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import Ajv2020Module from 'ajv/dist/2020.js';
import {desktopReceipt, desktopPolicies} from '../../../../../capability/packages/desktop/server/receipt.ts';
import {desktopPackage} from '../../../../../capability/packages/desktop/server/package.ts';
import {admitReceipt} from '../../../services/personal-aios-integration/src/capability/receipt.ts';

const root = new URL('../../../../../', import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const ajv = new Ajv2020Module.default({strict: true});
ajv.addFormat('date-time', value => Number.isFinite(Date.parse(value)));
const validReceipt = ajv.compile(read('capability/contracts/receipt.v1.schema.json'));
const validPlugin = ajv.compile(read('capability/contracts/upstream/plugin-1.0.0.schema.json'));
const validManifest = ajv.compile(read('capability/contracts/manifest.v1.schema.json'));
const cases = read('capability/packages/desktop/tests/contract.yaml').cases;
const wireTools = read('integrations/contracts/desktop-tools.v1.json').tools;

for (const item of cases) test(`desktop package contract: ${item.id}`, () => {
  const before = structuredClone(item.raw);
  const body = desktopReceipt(item.tool, item.args, item.raw, '2026-10-24T00:00:00Z');
  assert.equal(validReceipt(body), true, ajv.errorsText(validReceipt.errors));
  assert.equal(body.status.state, item.expect.state);
  assert.equal(body.next.retry, item.expect.retry);
  if (item.expect.effects !== undefined) assert.equal(body.effects.length, item.expect.effects);
  if (body.status.state === 'unknown') assert.ok(body.next.check_with);
  assert.deepEqual(admitReceipt(body), body);
  assert.deepEqual(item.raw, before);
});

for (const name of ['desktop', 'owner-mac']) test(`${name} manifest is a valid upstream plugin and capability extension`, () => {
  const manifest = read(`capability/packages/${name}/plugin.json`);
  for (const [validate, body] of [
    [validPlugin, manifest],
    [validManifest, manifest.extensions['ai.yimi.capability']],
  ] as const) {
    assert.equal(validate(body), true, ajv.errorsText(validate.errors));
  }
});

test('every desktop wire tool has one manifest policy and a real success fixture', () => {
  assert.deepEqual(Object.keys(desktopPolicies).sort(), wireTools.map((tool: {name: string}) => tool.name).sort());
  assert.deepEqual(new Set(cases.filter((item: any) => item.expect.state === 'succeeded').map((item: any) => item.tool)), new Set(Object.keys(desktopPolicies)));
});

test('the shared catalog switches the family; off returns the exact legacy objects', () => {
  const catalog = new Set<string>(), adapter = desktopPackage(catalog), item = cases[9];
  const args = {...item.args, owner_requested: true};
  assert.strictEqual(adapter.arguments(args), args);
  assert.strictEqual(adapter.result(item.tool, args, item.raw), item.raw);
  assert.strictEqual(adapter.tools(wireTools), wireTools);
  catalog.add('mcp__desktop__list_allowed_directories');
  const schemas = adapter.tools(wireTools);
  assert.equal(wireTools[0].inputSchema.properties.owner_requested, undefined);
  assert.equal((schemas[0]!.inputSchema.properties as any).owner_requested.type, 'boolean');
  assert.deepEqual(adapter.arguments(args), item.args);
  const result = adapter.result(item.tool, adapter.arguments(args), item.raw);
  assert.equal(result.content.length, 1);assert.equal(result.content[0]!.type, 'text');
  assert.equal((result.structuredContent as any).receipt, 1);
  catalog.clear();assert.strictEqual(adapter.result(item.tool, args, item.raw), item.raw);
});

test('file counts, exact bytes and capture dimensions retain units, time and provenance', () => {
  const files = desktopReceipt('find_files', {}, cases[6].raw, '2026-10-24T00:00:00Z');
  assert.equal(files.values.find(item => item.key === 'files[0].size')!.unit, 'B');
  assert.equal(files.values.find(item => item.key === 'files.count')!.value, 1);
  const capture = desktopReceipt('window_capture', {}, cases[15].raw, '2026-10-24T00:00:00Z');
  assert.equal(capture.values.find(item => item.key === 'width')!.unit, 'px');
  assert.equal(capture.content[0]!.provenance, 'inferred');
  assert.ok(files.values.every(item => item.as_of && item.source && item.unit));
});

test('the native FileText content field preserves text and qualifies the printed metadata', () => {
  const info = desktopReceipt('get_file_info', {}, {content: [], structuredContent: {content: 'size: 123\npermissions: 644\nisFile: true'}}, '2026-10-24T00:00:00Z');
  assert.equal(info.content[0]!.key, 'content');
  assert.equal(info.values.find(item => item.key === 'size')!.value, 123);
  assert.equal(info.values.find(item => item.key === 'size')!.unit, 'B');
  assert.equal(info.values.find(item => item.key === 'permissions')!.value, '644');
  const listing = desktopReceipt('list_directory_with_sizes', {}, {content: [], structuredContent: {content: '[FILE] report.txt 12 B\nTotal: 1 files, 0 directories\nCombined size: 12 B'}});
  assert.equal(listing.values.find(item => item.key === 'file_count')!.value, 1);
  assert.equal(listing.values.find(item => item.key === 'directory_count')!.unit, 'directories');
  assert.ok(listing.values.filter(item => item.key.endsWith('.size')).every(item => item.unit === 'B' && item.value === 12));
});

test('adapter modules stay within 200 lines and add no reporting instructions', () => {
  for (const path of ['desktop/server/receipt.ts', 'desktop/server/package.ts', 'owner-mac/server/receipts.py', 'owner-mac/server/package_server.py']) {
    const source = readFileSync(new URL(`capability/packages/${path}`, root), 'utf8');
    assert.ok(source.trimEnd().split('\n').length <= 200, path);
  }
});
