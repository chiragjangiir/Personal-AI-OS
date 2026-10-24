import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStagingEffectSink} from '../src/staging-effect-sink.ts';
import {createPersonalAIOSAssembly} from '../../../services/personal-aios-integration/src/assembly.ts';
import {PosixStorage} from '../../../services/personal-aios-integration/src/storage.ts';
import {sha256} from '../../../services/personal-aios-integration/src/contracts.ts';
import {sourceClient} from '../../../services/personal-aios-integration/tests/native-source-fixture.ts';

test('staging persists notifications, SMS and scheduled outreach before any paired-device delivery', async t => {
  const root = await mkdtemp(join(tmpdir(), 'paios-staging-effects-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const file = join(root, 'state', 'effects.jsonl'), sink = createStagingEffectSink(file);
  t.mock.method(globalThis, 'fetch', async () => {assert.fail('staging must not contact an external endpoint');});
  await sink.notify({title: '依米', body: '后台任务完成'});
  await sink.sms({id: 'fall-escalation', to: '13800000000', text: '请查看跌倒情况'});
  const token = 'staging-device-fixture-token';
  const never = async (): Promise<never> => {throw new Error('native execution is unnecessary for delivery');};
  const assembly = createPersonalAIOSAssembly({storage: new PosixStorage(join(root, 'central')),
    native: sourceClient({create: never, status: never, cancel: never}),
    skill: 'staging fixture', max_event_bytes: 16384, max_read_bytes: 16384,
    devices: [{principal_id: 'owner', device_id: 'phone', device_type: 'phone', channel: 'http', consent_ref: 'fixture',
      token_sha256: sha256(token), route_version: 'fixture', output_modes: ['text']}],
    admission: {max_pending_events: 4, max_pending_bytes: 65536, max_event_age_ms: 10000, poll_interval_ms: 10,
      native_idempotency_retention_ms: 86400000, policy_version: 'staging-test'},
    notify: sink.notify, care_sms: sink.sms, staging_outreach: sink.outreach,
    http: {internal_token: 'fixture-internal-service-token', max_request_bytes: 32768, request_timeout_ms: 5000}});
  t.after(() => assembly.close());
  const source = await assembly.runtime.authenticate(token);
  await assembly.runtime.watchCare(source, async () => {assert.fail('staging cannot send care to the paired phone');},
    async () => {assert.fail('staging cannot speak in the owner live call');});
  await assembly.runtime.scheduledDelivery({captured_at:new Date().toISOString(),principal_id: 'owner', device_id: 'phone', id: 'reminder-delivery',
    text: '吃药提醒', reminder_id: 'reminder-fixture'});
  const records = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(record => record.kind), ['notification', 'sms', 'outreach']);
  assert.equal(records[1].to, '13800000000');
  assert.equal(records[2].reminder_id, 'reminder-fixture');
  await createStagingEffectSink(file).notify({title: '重启后', body: '仍保留原记录'});
  assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 4);
});
