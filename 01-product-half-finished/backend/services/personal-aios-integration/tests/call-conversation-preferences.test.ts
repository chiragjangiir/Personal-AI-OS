import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPersonalAIOSAssembly} from '../src/assembly.ts';
import {PosixStorage} from '../src/storage.ts';
import {sha256} from '../src/contracts.ts';
import {sourceClient,type NativeClient} from './native-source-fixture.ts';

const native:NativeClient={async create(){throw new Error('unused');},async status(){throw new Error('unused');},async cancel(){throw new Error('unused');}};
test('conversation mode follows a principal across devices and survives a runtime restart',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'call-mode-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const devices=[['phone','owner'],['mac','owner'],['foreign','other']].map(([device_id,principal_id])=>({device_id:device_id!,principal_id:principal_id!,
    device_type:'phone' as const,channel:'fixture',consent_ref:'fixture',route_version:'fixture',output_modes:['text'],token_sha256:sha256(device_id!)}));
  const open=()=>createPersonalAIOSAssembly({storage:new PosixStorage(root),native:sourceClient(native),devices,skill:'fixture',max_event_bytes:8192,max_read_bytes:8192,
    admission:{max_pending_events:4,max_pending_bytes:65536,max_event_age_ms:10000,poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'mode-test'},
    http:{internal_token:'synthetic-mode-internal-secret',max_request_bytes:8192,request_timeout_ms:1000}});
  const first=open();
  try {
    const [phone,mac,foreign]=await Promise.all(['phone','mac','foreign'].map(token=>first.runtime.authenticate(token)));
    assert.equal(await first.runtime.callConversationMode(phone!),'chat');
    await first.runtime.rememberCallConversationMode(phone!,'thinking');
    assert.equal(await first.runtime.callConversationMode(mac!),'thinking');
    assert.equal(await first.runtime.callConversationMode(foreign!),'chat');
    await assert.rejects(first.runtime.rememberCallConversationMode({...phone!,principal_id:'other'},'chat'),/DEVICE_REGISTRY_BINDING_REQUIRED/);
  } finally {await first.close();}
  const second=open();
  try {
    const mac=await second.runtime.authenticate('mac');
    assert.equal(await second.runtime.callConversationMode(mac),'thinking');
    await second.runtime.rememberCallConversationMode(mac,'chat');
    const phone=await second.runtime.authenticate('phone');
    assert.equal(await second.runtime.callConversationMode(phone),'chat');
  } finally {await second.close();}
});
