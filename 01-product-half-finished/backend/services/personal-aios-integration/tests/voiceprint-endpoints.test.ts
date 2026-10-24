// Internal (internal-key) enrollment and naming endpoints and the CLI's listing path, against the actual server framing.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { PersonalAIOSRuntime, RunAdmission, type NativeClient } from './native-source-fixture.ts';
import { OutputAuthority } from '../src/output.ts';
import { RawArchive } from '../src/archive.ts';
import { PosixStorage } from '../src/storage.ts';
import { createPersonalAIOSServer } from '../src/server.ts';
import { sha256 } from '../src/contracts.ts';
import { VoiceprintRegistry, encodeEmbedding, type SpeakerModel } from '../src/voiceprint/registry.ts';

const MODEL: SpeakerModel = {id: 'eres2netv2-test', sha256: 'a'.repeat(64), dim: 16};
const KEY = 'internal-key-for-voiceprint-tests';
const vector = (seed: number, jitter = 0) => Float32Array.from({length: 16}, (_, i) => Math.sin(seed * 31 + i * 7) + (i === seed % 16 ? 3 : 0) + jitter * Math.cos(i));

async function fixture(t: test.TestContext, withRegistry = true) {
  const root = await fs.mkdtemp(join(tmpdir(), 'paios-voiceprint-http-'));
  const storage = new PosixStorage(root);
  const native: NativeClient = {create: async () => {throw new Error('no runs');}, status: async () => {throw new Error('no runs');},
    cancel: async () => {throw new Error('no runs');}};
  const admission = new RunAdmission(storage, native, {max_pending_events: 2, max_pending_bytes: 100000, max_event_age_ms: 10000,
    poll_interval_ms: 5, native_idempotency_retention_ms: 86400000, policy_version: 'http'});
  const registry = new VoiceprintRegistry(storage, MODEL);
  const runtime = new PersonalAIOSRuntime({storage, archive: new RawArchive(storage, 100000), admission, native, output: new OutputAuthority(storage),
    skill: 'fixed', max_read_bytes: 100000, ...(withRegistry ? {voiceprint: registry} : {}),
    devices: [{principal_id: 'owner', device_id: 'phone', device_type: 'phone', consent_ref: 'c', channel: 'fixture', route_version: 'r',
      output_modes: ['text'], token_sha256: sha256('phone-token')}]});
  const server = createPersonalAIOSServer(runtime, {internal_token: KEY, max_request_bytes: 1 << 20, request_timeout_ms: 10000});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {await server.closeAndDrain(); await runtime.close(); await fs.rm(root, {recursive: true, force: true});});
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, token = KEY) => {
    const response = await fetch(url + path, {method, headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    return {status: response.status, body: await response.json() as Record<string, unknown>};
  };
  return {root, url, call};
}

test('internal voiceprint endpoints enroll, list, rename, merge and forget; only the internal key may use them', async t => {
  const f = await fixture(t);
  const samples = [0, 1, 2, 3, 4].map(i => ({embedding_base64: encodeEmbedding(vector(1, i * 0.05)), speech_ms: 2000}));
  assert.equal((await f.call('GET', '/internal/voiceprint', undefined, 'phone-token')).status, 401);
  assert.equal((await f.call('POST', '/internal/voiceprint/owner', {mode: 'replace', speaker_model: MODEL, samples}, 'phone-token')).status, 401);
  const mismatch = await f.call('POST', '/internal/voiceprint/owner', {mode: 'replace', speaker_model: {...MODEL, sha256: 'b'.repeat(64)}, samples});
  assert.deepEqual([mismatch.status, mismatch.body.error_code], [409, 'VOICEPRINT_SPEAKER_MODEL_MISMATCH']);
  const mixed = await f.call('POST', '/internal/voiceprint/owner', {mode: 'replace', speaker_model: MODEL,
    samples: [...samples.slice(0, 4), {embedding_base64: encodeEmbedding(vector(9)), speech_ms: 2000}]});
  assert.deepEqual([mixed.status, mixed.body.error_code, (mixed.body.sample_consistency as number[]).length], [422, 'VOICEPRINT_ENROLLMENT_INCONSISTENT', 5]);
  const enrolled = await f.call('POST', '/internal/voiceprint/owner', {mode: 'replace', speaker_model: MODEL, samples});
  assert.deepEqual([enrolled.status, enrolled.body.enrolled, enrolled.body.samples], [200, true, 5]);
  assert.equal((await f.call('POST', '/internal/voiceprint/owner', {mode: 'replace', speaker_model: MODEL,
    samples: [{embedding_base64: 'AAAA', speech_ms: 2000}]})).body.error_code, 'VOICEPRINT_EMBEDDING_INVALID');
  const listed = await f.call('GET', '/internal/voiceprint');
  assert.deepEqual([(listed.body.owner as {enrolled: boolean}).enrolled, listed.body.clusters, (listed.body.speaker_model as SpeakerModel).sha256],
    [true, [], MODEL.sha256]);
  assert.equal((await f.call('POST', '/internal/voiceprint/clusters/1/rename', {display_name: '老王'})).body.error_code, 'VOICEPRINT_CLUSTER_NOT_FOUND');
  assert.equal((await f.call('POST', '/internal/voiceprint/clusters/1/merge', {from: '2', extra: true})).body.error_code, 'VOICEPRINT_MERGE_INVALID');
  assert.equal((await f.call('DELETE', '/internal/voiceprint/owner')).body.enrolled, false);
  assert.equal((await f.call('PUT', '/internal/voiceprint/clusters/1')).status, 405);
  assert.equal((await f.call('GET','/internal/voiceprint/status',undefined,'phone-token')).status,401);
  const status=await f.call('GET','/internal/voiceprint/status');
  assert.equal(status.status,200);assert.equal(status.body.last_harness_result,null);
  assert.deepEqual(status.body.recent_verdicts,{scope:'current_process_last_200',count:0,distribution:{}});
  // Through the CLI: listing goes to the same endpoint; an unsafe key file is refused before any request.
  const cli = fileURLToPath(new URL('../tools/voiceprint-enroll.ts', import.meta.url));
  const keyFile = join(f.root, 'internal.key');
  await fs.writeFile(keyFile, KEY, {mode: 0o644});
  const run = (args: string[]) => new Promise<{code: number; out: string}>(resolve => execFile(process.execPath, [cli, ...args],
    (error, stdout, stderr) => resolve({code: error ? Number(error.code) : 0, out: stdout + stderr})));
  assert.match((await run(['--list', '--key-file', keyFile, '--url', f.url])).out, /must be owner-only/u);
  await fs.chmod(keyFile, 0o600);
  const listing = await run(['--list', '--key-file', keyFile, '--url', f.url]);
  assert.equal(listing.code, 0, listing.out); assert.match(listing.out, /"enrolled": false/u);
});

test('without a configured registry the endpoints answer 503, never a fallback', async t => {
  const f = await fixture(t, false);
  assert.deepEqual([(await f.call('GET', '/internal/voiceprint')).status, (await f.call('GET', '/internal/voiceprint')).body.error_code],
    [503, 'VOICEPRINT_NOT_CONFIGURED']);
});
