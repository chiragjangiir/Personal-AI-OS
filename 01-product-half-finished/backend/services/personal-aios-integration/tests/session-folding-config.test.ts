import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {provisionCentralResources,type CentralProvisionConfiguration} from '../src/main.ts';
import {createPersonalAIOSAssembly} from '../src/assembly.ts';
import {RawArchive} from '../src/archive.ts';
import {PosixStorage} from '../src/storage.ts';
import type {RawEvent,TrustedContext} from '../src/contracts.ts';

test('session folding config rejects nonboolean values before opening any resources',async()=>{
  for(const session_folding of [null,0,1,'false',{},[]])await assert.rejects(
    provisionCentralResources({session_folding} as unknown as CentralProvisionConfiguration),/INVALID_SESSION_FOLDING/);
});
for(const configured of [undefined,true,false])test(`provisioning and assembly apply session_folding=${configured} before startup recovery`,async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'folding-config-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(join(root,'key'),'synthetic-offline-fixture-key',{mode:0o600});await fs.writeFile(join(root,'skill'),'fixture');
  const config:CentralProvisionConfiguration={port:18898,storage_root:join(root,'storage'),lock_file:join(root,'lock'),
    hermes_base_url:'http://127.0.0.1:1',hermes_key_file:join(root,'key'),internal_key_file:join(root,'key'),skill_file:join(root,'skill'),
    native_request_timeout_ms:1000,http_request_timeout_ms:1000,max_request_bytes:8192,max_event_bytes:8192,max_read_bytes:8192,
    admission:{max_pending_events:4,max_pending_bytes:65536,max_event_age_ms:10000,poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'folding-config'},
    ...(configured===undefined?{}:{session_folding:configured})};
  const provision=await provisionCentralResources(config);t.after(()=>provision.release());
  const storage=provision.resources.storage as PosixStorage,archive=new RawArchive(storage,8192),assembly=createPersonalAIOSAssembly({...provision.resources,archive});
  t.after(async()=>{await assembly.close();await storage.close();});
  const at='2026-10-18T00:00:00.000Z',trusted:TrustedContext={principal_id:'owner',device_id:'phone',device_type:'phone',channel:'formal',consent_ref:'fixture',submission:'observation'};
  const raw:RawEvent={schema_version:'paios.event.v1',event_id:'config-source',device_id:'phone',device_type:'phone',captured_at:at,source:{channel:'formal'},
    media_type:'audio',mime:'audio/pcm',representation:'received_decoded_sample',payload:Buffer.alloc(3200,1)};
  const receipt=await archive.streams.append(raw,trusted,at,{track_id:'mic',stream_epoch:'audio',seq:0,modality:'audio',format:'pcm_s16le:16000:1',
    source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'audio',start_ms:0,end_ms:100}});
  await archive.finalizeSession(receipt.event.raw_ref,'config_end');await archive.recover();
  assert.equal(Boolean(await storage.readFinal(receipt.event.raw_ref)),configured!==false);
  assert.equal((await storage.listHot('stream-revisions')).length,configured===false?2:0);
  assert.equal((await storage.listHot('session-ends')).length,configured===false?1:0);
});
