import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ProcessedEvent} from '../src/contracts.ts';
import type {UtteranceRef} from '../src/payment/contracts.ts';
import {AmbientJournal} from '../src/ambient/journal.ts';
import {AmbientLane} from '../src/ambient/lane.ts';

// Local routing only: no grant-authority, cross-producer dedupe, D13 or whole-Hermes secrecy claim.
const T0 = Date.parse('2026-10-15T08:00:00.000Z');
type Heard = UtteranceRef & {text: string; speaker: string|null};
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'paios-ambient-payment-'));
  const journal = AmbientJournal.open(root);
  t.after(async () => {journal.close(); await rm(root, {recursive: true, force: true});});
  let now = T0, serial = 0;
  const lane = new AmbientLane<null>(journal, {now: () => now});
  const line = (text: string, options: {principal?: string; device?: string; type?: string; at?: number; speaker?: string; wake?: true} = {}) => {
    const start_ms = options.at ?? now, end_ms = start_ms + 640;
    // Only the producer-owned fields the lane consumes; the real journal still validates and persists each utterance.
    return {principal_id: options.principal ?? 'owner', device_id: options.device ?? 'glasses', device_type: options.type ?? 'glasses',
      processed_event_id: `payment-observation-${serial++}`, raw_ref: `l5:${'a'.repeat(64)}`, archive_revision: 'b'.repeat(64),
      segment_id: 'segment-payment', captured_at: new Date(start_ms).toISOString(),
      time_range: {kind: 'interval', timebase_id: 'utc_epoch_ms', start_ms, end_ms}, speakers: [],
      content: {audio_observations: [{observation_kind: 'sample_transcription', segments: [{text, speaker: options.speaker ?? 'owner',
        identity_scope: 'local_voiceprint', speaker_score: 0.9, start_sample: 0, end_sample_exclusive: 10240,
        ...(options.wake ? {wake: {keyword: '依米', end_sample: 1600}} : {}),
        source_parts: [{clipped_scope_range: {kind: 'interval', timebase_id: 'utc_epoch_ms', start_ms, end_ms}}]}]}]}} as unknown as ProcessedEvent;
  };
  const open = (heard: (u: Heard) => void, options: {device?: string; principal?: string; until?: number; phrases?: string[]} = {}) =>
    lane.openPayWindow({principal_id: options.principal ?? 'owner', device_id: options.device ?? 'glasses',
      until_ms: options.until ?? now + 10000, phrases: options.phrases ?? ['付吧']}, heard);
  return {lane, journal, line, open, advance: (ms: number) => {now += ms;}};
}

test('A6.4 routing: ambient hits carry exact L5 references and open no immediate Hermes turn', async t => {
  const f = await fixture(t), heard: Heard[] = [];
  f.open(u => heard.push(u));
  const d = f.line('依米， 付 吧！', {wake: true});
  assert.deepEqual(f.lane.observe(d, null), []);
  assert.equal(heard.length, 1);
  assert.deepEqual(heard[0], {device_id: 'glasses', device_type: 'glasses', raw_ref: d.raw_ref, archive_revision: d.archive_revision,
    start_ms: T0, end_ms: T0 + 640, captured_at: new Date(T0).toISOString(), processed_event_id: d.processed_event_id,
    transcript: '依米， 付 吧！', text: '依米， 付 吧！', speaker: 'owner'});
  assert.deepEqual(f.lane.silence('owner', 'glasses', T0 + 1000, true), []);
  let offers = 0;
  f.advance(1000);
  await f.lane.observeVoice(f.line('付吧'), null, async () => {offers++; return true;});
  assert.equal(heard.length, 2); assert.equal(offers, 0, 'payment speech never activates ambient voice');
  assert.equal(f.journal.entriesOf('owner', d.processed_event_id).length, 1, 'the source stays journaled');
});

test('A6.4 routing: only configured full phrases on the scoped phone or glasses match', async t => {
  const f = await fixture(t), heard: Heard[] = [];
  f.open(u => heard.push(u), {phrases: ['可以付款']});
  for (const d of [f.line('付吧'), f.line('请可以付款'), f.line('可以付款', {device: 'another'}),
    f.line('可以付款', {principal: 'another'}), f.line('可以付款', {type: 'watch'}), f.line('可以付款', {type: 'mac'})]) f.lane.observe(d, null);
  assert.equal(heard.length, 0);
  f.lane.observe(f.line('可以付款。'), null);
  assert.equal(heard.length, 1);
  f.open(u => heard.push(u), {device: 'phone'});
  f.lane.observe(f.line('付吧', {device: 'phone', type: 'phone'}), null);
  assert.equal(heard[1]!.device_type, 'phone');
});

test('A6.4 lifecycle: closed, replaced or expired windows report no later hit or old speech', async t => {
  const f = await fixture(t), first: Heard[] = [], second: Heard[] = [];
  const oldClose = f.open(u => first.push(u));
  const close = f.open(u => second.push(u)); oldClose();
  f.lane.observe(f.line('付吧'), null);
  assert.deepEqual([first.length, second.length], [0, 1]);
  close(); close(); f.advance(1000);
  f.lane.observe(f.line('付吧'), null); assert.equal(second.length, 1);
  f.open(u => second.push(u), {until: T0 + 2000});
  f.lane.observe(f.line('付吧', {at: T0}), null); assert.equal(second.length, 1, 'words before opening do not match');
  f.advance(1000);
  f.lane.observe(f.line('付吧'), null); assert.equal(second.length, 1, 'expiry is exclusive');
});

test('A6.4 routing: same-D journal replay dedupes hits; matched follow-ups divert and misses keep normal turns', async t => {
  const f = await fixture(t), heard: Heard[] = [];
  const request = f.line('买一杯奶茶');
  request.content.wake_request = {heard_at: new Date(T0).toISOString()};
  request.speakers = [{identity_scope: 'local_voiceprint', voiceprint: 'owner'}];
  f.lane.replied(request, '请说付吧', T0);
  f.open(u => heard.push(u));
  const pay = f.line('付吧');
  f.lane.observe(pay, null); f.lane.observe(pay, null);
  assert.equal(heard.length, 1);
  assert.deepEqual(f.lane.silence('owner', 'glasses', T0 + 2000, true), []);
  const miss = f.line('依米，今天几号', {wake: true});
  f.lane.observe(miss, null);
  const turns = f.lane.silence('owner', 'glasses', T0 + 3000, true);
  assert.equal(turns.length, 1, 'an unrelated normal wake still opens its existing turn');
  assert.equal(heard.length, 1);
});

test('A6.4 references: fractional source spans survive integer journal bounds', async t => {
  const f = await fixture(t), heard: Heard[] = [];
  f.open(u => heard.push(u));
  const d = f.line('付吧', {at: T0 + 0.25});
  f.lane.observe(d, null);
  assert.deepEqual([heard[0]!.start_ms, heard[0]!.end_ms], [T0 + 0.25, T0 + 640.25]);
  const entry = f.journal.entriesOf('owner', d.processed_event_id)[0]!;
  assert.deepEqual([entry.start_ms, entry.end_ms], [T0, T0 + 641]);
});
