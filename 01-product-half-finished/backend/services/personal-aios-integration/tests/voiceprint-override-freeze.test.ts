import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PosixStorage} from '../src/storage.ts';
import {VoiceprintRegistry} from '../src/voiceprint/registry.ts';

test('override freezes every biometric learning path while raw identity and payment remain factual',async t=>{
  const root=await mkdtemp(join(tmpdir(),'voiceprint-override-freeze-')),storage=new PosixStorage(root);
  let active=false;const model={id:'synthetic',sha256:'a'.repeat(64),dim:32};
  const registry=new VoiceprintRegistry(storage,model,{owner_override_active:async()=>active});
  t.after(async()=>{await registry.close();await rm(root,{recursive:true,force:true});});
  const vector=(axis:number,sign=1)=>{const v=new Float32Array(32);v[axis]=sign;return v;};
  const owner=vector(0),guest=vector(1),assistant=vector(2);
  const enrollment={speaker_model:model,channel:'file' as const,mode:'replace' as const,samples:Array.from({length:5},()=>({embedding:owner,speech_ms:2000}))};
  await registry.enrollOwner(enrollment);
  await registry.identify(guest,{mode:'observe',speech_ms:3000,observed_at:'2026-10-18T00:00:00.000Z'});
  await registry.observeAssistant({voice:'fixture',embedding:assistant,speech_ms:2000});await registry.flush();
  const key=(await storage.list('voiceprints'))[0]!,before=Buffer.from(await storage.read('voiceprints',key)).toString();active=true;
  for(const [embedding,mode] of [[owner,'call'],[guest,'observe'],[vector(1,-1),'observe'],[assistant,'observe']] as const)
    await registry.identify(embedding,{mode,speech_ms:3000,observed_at:'2026-10-18T00:00:10.000Z'});
  await assert.rejects(registry.enrollOwner(enrollment),/VOICEPRINT_LEARNING_FROZEN/);
  await assert.rejects(registry.enrollOwner({...enrollment,purpose:'conversation'}),/VOICEPRINT_LEARNING_FROZEN/);
  await assert.rejects(registry.observeAssistant({voice:'fixture',embedding:assistant,speech_ms:2000}),/VOICEPRINT_LEARNING_FROZEN/);
  const scope={principal_id:'owner',device_id:'phone'},at=new Date().toISOString();
  registry.openTrustWindow(scope,{at});
  assert.deepEqual(await registry.confirmDeviceOwner(owner,{speaker_model:model,channel:'call',speech_ms:2000,observed_at:at,trust_scope:scope}),{accepted:false});
  const trusted=await registry.identify(vector(3),{...scope,mode:'call',channel:'call',speech_ms:2000,observed_at:at,evidence_start_at:at});
  assert.equal(trusted.kind,'owner');assert.ok(trusted.kind==='owner'&&trusted.call_only&&trusted.trust_window);
  await registry.flush();assert.equal(Buffer.from(await storage.read('voiceprints',key)).toString(),before);
  assert.equal((await registry.identify(guest,{mode:'payment',speech_ms:2000,observed_at:'2026-10-18T00:00:20.000Z'})).kind,'speaker');
  assert.equal((await registry.identify(owner,{mode:'payment',speech_ms:2000,observed_at:'2026-10-18T00:00:20.000Z'})).kind,'owner');
  active=false;
  await registry.identify(vector(3,-1),{...scope,mode:'call',channel:'call',speech_ms:2000,observed_at:at,evidence_start_at:at});
  assert.equal((await registry.owner('call')).samples,1,'frozen trust attribution creates neither samples nor a sampling anchor');
  await registry.identify(owner,{mode:'call',speech_ms:3000,observed_at:'2026-10-18T00:00:30.000Z'});await registry.flush();
  assert.notEqual(Buffer.from(await storage.read('voiceprints',key)).toString(),before);
});
