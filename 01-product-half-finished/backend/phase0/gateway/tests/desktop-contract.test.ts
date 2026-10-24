import {utc} from '../../../services/personal-aios-integration/src/contracts.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';

const directory = new URL('../../../../../integrations/contracts/', import.meta.url);
const wire = JSON.parse(readFileSync(new URL('terminal-message.v1.json', directory), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('desktop-tools.v1.json', directory), 'utf8'));
const ajv = new Ajv({ strict: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
addFormats.default(ajv, ['date-time']);
ajv.addFormat('paios-utc',value=>{try{utc(value);return true;}catch{return false;}});
const compile = (schema: object) => ajv.compile({ ...schema, $defs: wire.$defs });
const canonical = (value: any): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const fingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

// Canonical inputSchema fingerprints from actual tools/list, server-filesystem 2026.8.31.
const filesystemSchemas: Record<string, string> = {
  "read_text_file": "d035cd0c9ce05f046ecb5eefa5c6c6c355c96b198cd00824c3a9e0dd91aa89b8",
  "write_file": "ce17c85e8a5883552a11555f9b893de497fadab965a5c7935c0cb8f3c55b91d6",
  "edit_file": "88459ef670b139a12a3e0335ae0a4584dd892f60f45f565b545e1004d7565dd5",
  "create_directory": "fc64d952de15bbe83e841a79d32385e4708e9758079b84dd233e485ce3c34720",
  "list_directory": "fc64d952de15bbe83e841a79d32385e4708e9758079b84dd233e485ce3c34720",
  "list_directory_with_sizes": "8d6f5d6dcaa186f44c30e5d278419c2559f6032a3455fc3fdbe4865910b35941",
  "move_file": "621218ed9bc38b6cde9c6dc003583fb5778e5076bb28e25634b9070b33264682",
  "search_files": "5b5a1eaeb940a6cfdd01f018784754be5204da54959a26b19ee5d00231636cc1",
  "get_file_info": "fc64d952de15bbe83e841a79d32385e4708e9758079b84dd233e485ce3c34720"
};
const argumentsByTool: Record<string, object> = {
  list_allowed_directories: {},
  window_capture: {question: '当前窗口显示什么？'},
  list_directory: { path: '/Users/owner/Downloads' },
  list_directory_with_sizes: { path: '/Users/owner/Downloads', sortBy: 'size' },
  search_files: { path: '/Users/owner/Downloads', pattern: '*.pdf' },
  get_file_info: { path: '/Users/owner/Downloads/invoice.pdf' },
  read_text_file: { path: '/Users/owner/Documents/notes.txt', head: 20 },
  find_files: { folder: '/Users/owner/Downloads', kinds: ['pdf'], limit: 500 },
  extract_text: { path: '/Users/owner/Downloads/invoice.pdf', pages: [1], max_chars: 50000 },
  create_directory: { path: '/Users/owner/Documents/invoices' },
  write_file: { path: '/Users/owner/Documents/notes.txt', content: '已整理' },
  edit_file: { path: '/Users/owner/Documents/notes.txt', edits: [{ oldText: '旧', newText: '新' }] },
  move_file: { source: '/Users/owner/Downloads/invoice.pdf', destination: '/Users/owner/Documents/invoice.pdf' },
  trash: { paths: ['/Users/owner/Downloads/duplicate.pdf'] },
  upload_to_workshop: { path: '/Users/owner/Downloads/invoice.pdf' },
  save_from_workshop: { workshop_path: '/owner/out/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/invoices/summary.xlsx' },
};


test('terminal extension validates every operation example and rejects unknown fields', () => {
  assert.deepEqual(Object.keys(wire.inputs).sort(), ['avatar_loaded', 'avatar_sync', 'desktop_pause', 'terminal_revoke', 'timeline_sync', 'turns_sync']);
  assert.deepEqual(Object.keys(wire.outputs).sort(), ['avatar_state', 'confirmations', 'terminal_receipt', 'terminals', 'timeline_items', 'timeline_removed', 'timeline_reset', 'timeline_resync', 'turns_state']);
  for (const direction of ['inputs', 'outputs']) {
    for (const [op, schemas] of Object.entries(wire[direction]) as [string, any][]) {
      const validate = compile(direction === 'inputs' ? schemas.definition : schemas);
      assert.ok(wire.examples[direction][op]?.length, `${op} has examples`);
      for (const example of wire.examples[direction][op]) {
        assert.equal(validate(example), true, `${op}: ${ajv.errorsText(validate.errors)}`);
        assert.equal(validate({ ...example, unknown: true }), false, `${op} rejects unknown fields`);
        assert.equal(validate({ ...example, operation: 'unknown' }), false, `${op} rejects unknown operation`);
      }
    }
  }
});

test('terminal extension enforces cursor, terminal and read-only confirmation boundaries', () => {
  const sync = compile(wire.inputs.timeline_sync.definition);
  assert.equal(sync({ operation: 'timeline_sync', request_id: 'sync-1', after_seq: 0, before_seq: 2 }), false);
  assert.equal(sync({ operation: 'timeline_sync', request_id: 'sync-1', limit: 101 }), false);
  const timeline = compile(wire.outputs.timeline_items);
  const item = structuredClone(wire.examples.outputs.timeline_items[0]);
  item.items[0].item_id = `her-${'e'.repeat(200)}`;
  assert.equal(timeline(item), true, 'derived item ids may exceed base event-id length');
  const terminals = compile(wire.outputs.terminals);
  const example = structuredClone(wire.examples.outputs.terminals[0]);
  example.terminals[0].device_class = 'iphone';
  assert.equal(terminals(example), false, 'paused is Mac-only');
  assert.equal(wire.inputs.confirmation_deny,undefined,'I12: Mac has no answer operation');
  const confirmations = compile(wire.outputs.confirmations);
  const pending = structuredClone(wire.examples.outputs.confirmations[0]);
  pending.items[0].kind = 'payment';
  assert.equal(confirmations(pending), false, 'I12: payment is excluded');
  pending.items = Array(17).fill(wire.examples.outputs.confirmations[0].items[0]);
  assert.equal(confirmations(pending), false);
});

test('I9: fixed manifest has all 16 tools and unchanged official filesystem schemas', () => {
  assert.equal(manifest.schema, 'paios.desktop-tools.v1');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.tools.length, 16);
  assert.equal(new Set(manifest.tools.map((tool: any) => tool.name)).size, 16);
  const names = manifest.tools.map((tool: any) => tool.name);
  for (const excluded of ['delete_file', 'directory_tree', 'read_multiple_files', 'read_media_file', 'exec']) {
    assert.equal(names.includes(excluded), false);
  }
  const capture = process.env.PAIOS_FILESYSTEM_TOOLS_LIST
    ? JSON.parse(readFileSync(process.env.PAIOS_FILESYSTEM_TOOLS_LIST, 'utf8')).result.tools : undefined;
  for (const [name, expected] of Object.entries(filesystemSchemas)) {
    const tool = manifest.tools.find((tool: any) => tool.name === name);
    assert.ok(tool, name);
    assert.equal(fingerprint(tool.inputSchema), expected, `${name} matches captured tools/list`);
    if (capture) assert.deepEqual(tool.inputSchema, capture.find((item: any) => item.name === name).inputSchema);
  }
  for (const tool of manifest.tools) {
    const validate = ajv.compile(tool.inputSchema);
    assert.equal(validate(argumentsByTool[tool.name]), true, `${tool.name}: ${ajv.errorsText(validate.errors)}`);
    if (!(tool.name in filesystemSchemas)) {
      assert.equal(validate({ ...argumentsByTool[tool.name], unknown: true }), false, `${tool.name} rejects unknown fields`);
    }
    assert.equal(tool.annotations.openWorldHint, false);
    assert.ok([10000, 30000, 90000, 180000].includes(tool['x-paios'].timeout_ms));
  }
});
