import assert from 'node:assert/strict';
import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ContractError, digest } from '../src/contracts.ts';
import { PosixStorage } from '../src/storage.ts';
import { loadRegistryCipher } from '../src/voiceprint/cipher.ts';
import { encodeEmbedding, VoiceprintRegistry, type OwnerChannel } from '../src/voiceprint/registry.ts';

// A13 coverage: I11 local sealing only; no backup/staging exclusion or host-egress proof.
const MODEL = {id: 'test-speaker', sha256: 'a'.repeat(64), dim: 32};
const KEY = digest('paios.voiceprint.registry.v1'), AT = '2026-10-09T08:00:00.000Z';
const vector = (axis: number, dim = 32) => Float32Array.from({length: dim}, (_, i) => i === axis ? 1 : 0);
function document() {
  const owner_sets = (['phone_app', 'glasses'] as OwnerChannel[]).map((channel, axis) => ({
    channel, model: MODEL, centroid: encodeEmbedding(vector(axis)), enrolled_at: AT, updated_at: AT,
    samples: Array.from({length: 5}, () => ({embedding: encodeEmbedding(vector(axis)), speech_ms: 2000, added_at: AT})),
    consistency: {min: 1, mean: 1},
  }));
  return {schema: 'paios.voiceprint.registry.v2', revision: 1, next_number: 2, owner_sets,
    clusters: [{cluster_id: '1', model_sha256: MODEL.sha256, centroid: encodeEmbedding(vector(2)), count: 1,
      speech_ms: 2000, created_at: AT, last_seen: AT, display_name: 'private-person',
      face_samples: [{frame_id: 'private-frame', embedding: encodeEmbedding(vector(0, 128)), at: AT}]}],
    assistant: [{voice: 'system_tts', model_sha256: MODEL.sha256, centroid: encodeEmbedding(vector(3)), count: 1,
      speech_ms: 2000, created_at: AT, last_seen: AT}]};
}
async function setup(t: test.TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), 'paios-registry-cipher-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const key = randomBytes(32), keyFile = join(root, 'voiceprint.key');
  await fs.writeFile(keyFile, key.toString('base64') + '\n', {mode: 0o600});
  return {root, key, keyFile, storage: new PosixStorage(join(root, 'storage')), cipher: await loadRegistryCipher(keyFile)};
}
const code = (expected: string) => (error: unknown) => error instanceof ContractError && error.code === expected && error.status === 503;

test('I11 at-rest clause: exact AES-GCM envelope authenticates registry bytes', async t => {
  const {cipher, key} = await setup(t), plaintext = Buffer.from(JSON.stringify(document()));
  const sealed = Buffer.from(cipher.seal(plaintext)), another = Buffer.from(cipher.seal(plaintext));
  assert.equal(sealed.length, plaintext.length + 44);
  assert.equal(sealed.subarray(0, 8).toString(), 'PAIOSVP1');
  assert.deepEqual(sealed.subarray(8, 16), createHash('sha256').update(key).digest().subarray(0, 8));
  assert.notDeepEqual(sealed.subarray(16, 28), another.subarray(16, 28), 'two IVs differ: a sanity check, not a uniqueness proof');
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(16, 28));
  decipher.setAAD(Buffer.from('paios.voiceprint.registry.v2')); decipher.setAuthTag(sealed.subarray(-16));
  assert.deepEqual(Buffer.concat([decipher.update(sealed.subarray(28, -16)), decipher.final()]), plaintext);
  assert.deepEqual(Buffer.from(cipher.open(sealed)), plaintext);
  for (const offset of [16, 28, sealed.length - 1]) {
    const corrupt = Buffer.from(sealed); corrupt[offset] = corrupt[offset]! ^ 1;
    assert.throws(() => cipher.open(corrupt), code('VOICEPRINT_REGISTRY_CORRUPT'));
  }
  assert.throws(() => cipher.open(sealed.subarray(0, 40)), code('VOICEPRINT_REGISTRY_CORRUPT'));
});

test('I11 at-rest prerequisite: key files contain canonical base64 for exactly 32 bytes', async t => {
  const {keyFile, key} = await setup(t);
  for (const invalid of [randomBytes(31).toString('base64'), randomBytes(33).toString('base64'),
    key.toString('base64').replace('=', ''), ' ' + key.toString('base64'), key.toString('base64') + '\n\n']) {
    await fs.writeFile(keyFile, invalid);
    await assert.rejects(loadRegistryCipher(keyFile), code('VOICEPRINT_REGISTRY_KEY_INVALID'));
  }
});

test('I11 at-rest clause: validated legacy v1/v2 plaintext seals once with every field', async t => {
  const {storage, root, cipher} = await setup(t), log = t.mock.method(console, 'info', () => {});
  for (const legacy of [false, true]) {
    const doc = document(), {owner_sets, ...rest} = doc, {channel: _, ...owner} = owner_sets[0]!;
    const input = legacy ? {...rest, schema: 'paios.voiceprint.registry.v1', owner} : doc;
    await storage.replace('voiceprints', KEY, Buffer.from(JSON.stringify(input)));
    const registry = new VoiceprintRegistry(storage, MODEL, {cipher});
    assert.equal((await registry.owner()).enrolled, true);
    const sealed = Buffer.from(await storage.read('voiceprints', KEY));
    assert.equal(sealed.subarray(0, 8).toString(), 'PAIOSVP1');
    const migrated = JSON.parse(Buffer.from(cipher.open(sealed)).toString());
    assert.deepEqual(migrated.clusters, doc.clusters); assert.deepEqual(migrated.assistant, doc.assistant);
    assert.equal(migrated.owner_sets[0].channel, legacy ? 'file' : 'phone_app');
    assert.equal(migrated.schema, 'paios.voiceprint.registry.v2');
    assert.equal((await fs.stat(join(root, 'storage', 'voiceprints', KEY))).mode & 0o777, 0o600);
    const reopened = new VoiceprintRegistry(storage, MODEL, {cipher});
    assert.deepEqual(await reopened.owner(), await registry.owner());
    await reopened.close(); await registry.close();
    assert.deepEqual(Buffer.from(await storage.read('voiceprints', KEY)), sealed);
  }
  assert.equal(log.mock.calls.length, 2);
  assert.ok(log.mock.calls.every(call => call.arguments.length === 1 && call.arguments[0] === 'VOICEPRINT_REGISTRY_ENCRYPTED'));
});

test('I11 at-rest clause: missing/wrong keys, bad tags and invalid plaintext preserve stored bytes', async t => {
  const {storage, cipher, keyFile} = await setup(t), sealed = cipher.seal(Buffer.from(JSON.stringify(document())));
  await storage.replace('voiceprints', KEY, sealed);
  await fs.writeFile(keyFile, randomBytes(32).toString('base64'));
  const wrong = await loadRegistryCipher(keyFile);
  for (const [options, error] of [[{}, 'VOICEPRINT_REGISTRY_KEY_REQUIRED'], [{cipher: wrong}, 'VOICEPRINT_REGISTRY_KEY_MISMATCH']] as const) {
    const registry = new VoiceprintRegistry(storage, MODEL, options);
    await assert.rejects(registry.owner(), code(error));
    await assert.rejects(registry.forgetOwner(), code(error));
    assert.deepEqual(await storage.read('voiceprints', KEY), sealed);
  }
  const corrupt = Buffer.from(sealed); corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
  await storage.replace('voiceprints', KEY, corrupt);
  await assert.rejects(new VoiceprintRegistry(storage, MODEL, {cipher}).owner(), code('VOICEPRINT_REGISTRY_CORRUPT'));
  assert.deepEqual(Buffer.from(await storage.read('voiceprints', KEY)), corrupt);
  const invalid = Buffer.from(JSON.stringify({...document(), owner_sets: [{channel: 'unknown', model: MODEL}]}));
  await storage.replace('voiceprints', KEY, invalid);
  await assert.rejects(new VoiceprintRegistry(storage, MODEL, {cipher}).owner(), code('VOICEPRINT_REGISTRY_CORRUPT'));
  assert.deepEqual(Buffer.from(await storage.read('voiceprints', KEY)), invalid);
});

test('A6.6 channel forget preserves unrelated sets and people in sealed state', async t => {
  const {storage, cipher} = await setup(t), doc = document();
  await storage.replace('voiceprints', KEY, cipher.seal(Buffer.from(JSON.stringify(doc))));
  const registry = new VoiceprintRegistry(storage, MODEL, {cipher});
  await registry.forgetOwner('glasses');
  assert.equal((await registry.owner('glasses')).enrolled, false);
  assert.equal((await registry.owner('phone_app')).enrolled, true);
  const reopened = new VoiceprintRegistry(storage, MODEL, {cipher});
  assert.deepEqual(await reopened.owner(), await registry.owner());
  const remaining = JSON.parse(Buffer.from(cipher.open(await storage.read('voiceprints', KEY))).toString());
  assert.deepEqual(remaining.owner_sets, [doc.owner_sets[0]]);
  assert.deepEqual(remaining.clusters, doc.clusters); assert.deepEqual(remaining.assistant, doc.assistant);
  await reopened.close();
  assert.equal((await registry.forgetOwner()).enrolled, false);
  const empty = JSON.parse(Buffer.from(cipher.open(await storage.read('voiceprints', KEY))).toString());
  assert.deepEqual(empty.owner_sets, []); assert.deepEqual(empty.clusters, doc.clusters);
  assert.deepEqual(empty.assistant, doc.assistant);
  await registry.close();
});

test('I11 at-rest clause: the first registry mutation writes sealed bytes', async t => {
  const {storage, cipher} = await setup(t), registry = new VoiceprintRegistry(storage, MODEL, {cipher});
  await registry.enrollOwner({speaker_model: MODEL, channel: 'phone_app', mode: 'replace',
    samples: Array.from({length: 5}, () => ({embedding: vector(0), speech_ms: 2000}))});
  assert.equal(Buffer.from(await storage.read('voiceprints', KEY)).subarray(0, 8).toString(), 'PAIOSVP1');
  assert.equal((await new VoiceprintRegistry(storage, MODEL, {cipher}).owner()).enrolled, true);
  await registry.close();
});
