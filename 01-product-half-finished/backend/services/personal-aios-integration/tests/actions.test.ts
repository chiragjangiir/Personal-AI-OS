import test from 'node:test';
import assert from 'node:assert/strict';
import { stableActionId, prepareAction } from '../src/actions/contracts.ts';
test('action identity follows business intent/version and rejects changed digest, model self-approval or random IDs', () => {
  const args = {action_id:stableActionId('owner','note-intent',1),business_intent_id:'note-intent',parameter_version:1,
    action_type:'write_local_note' as const,target_device_id:'mac',expected_control_version:'local-note-v1',parameters:{text:'draft'}};
  assert.equal(prepareAction('owner',args).action_id,stableActionId('owner','note-intent',1));
  const {action_id: omitted,...withoutId} = args;
  assert.equal(prepareAction('owner',withoutId).action_id,omitted);
  assert.notEqual(stableActionId('owner','note-intent',2),args.action_id);
  assert.throws(()=>prepareAction('owner',{...args,action_id:'random'}),/UNSTABLE_ID/);
  assert.throws(()=>prepareAction('owner',{...args,payload_sha256:'0'.repeat(64)}),/DIGEST_MISMATCH/);
  assert.throws(()=>prepareAction('owner',{...args,approved:true} as typeof args),/UNKNOWN_ARGUMENT/);
});
