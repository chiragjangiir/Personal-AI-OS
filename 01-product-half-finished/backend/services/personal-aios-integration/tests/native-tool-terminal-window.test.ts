import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {createPersonalAIOSAssembly} from '../src/assembly.ts';
import {StaticFixtureDeviceAuthority} from '../src/source-authority.ts';
import {sha256} from '../src/contracts.ts';
import {sourceClient,type NativeRun} from './native-source-fixture.ts';
async function until(read:()=>Promise<boolean>){for(let n=0;n<300;n++){if(await read())return;await new Promise(r=>setTimeout(r,5));}throw Error('OWNED_WINDOW_TIMEOUT');}
for(const terminal of ['completed','cancelled','expired','failed'] as const){
 test(`actual admission ${terminal} durable before pending cleanup refuses late tool; running permits original OPEN`,async()=>{
  const home=await mkdtemp(join(tmpdir(),'native-tool-window-'));
  const storage=new PosixStorage(home);let release!:()=>void,held=false;
  const gate=new Promise<void>(resolve=>release=resolve),remove=storage.removePending.bind(storage);
  storage.removePending=async key=>{held=true;await gate;return remove(key);};
  const run:NativeRun={run_id:'run',session_id:'session',conversation_session_id:'session',status:'running'};
  const native=sourceClient({create:async()=>({...run}),status:async()=>({...run}),cancel:async()=>({...run})});
  const sourceAuthority=new StaticFixtureDeviceAuthority([{principal_id:'owner',device_id:'device',device_type:'phone',channel:'fixture',consent_ref:'owned',route_version:'route',output_modes:['text'],token_sha256:sha256('owned-device-token')}]);
  const assembly=createPersonalAIOSAssembly({storage,archive:new RawArchive(storage,4096),native,sourceAuthority,skill:'owned fixture',max_event_bytes:4096,max_read_bytes:4096,
    admission:{max_pending_events:2,max_pending_bytes:8192,max_event_age_ms:10000,poll_interval_ms:5,native_idempotency_retention_ms:10000,policy_version:'owned'},
    http:{internal_token:'controlled-internal-token-abcdefghijklmnop',max_request_bytes:4096,request_timeout_ms:1000}});
  try {
    const runtime=assembly.runtime,source=await runtime.authenticate('owned-device-token');
    const accepted=await runtime.submit({schema_version:'paios.event.v1',event_id:'event',device_id:'device',device_type:'phone',captured_at:new Date().toISOString(),source:{channel:'fixture'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',payload:Buffer.from('owned input')},source,'session',true);
    const d=accepted.processed_event;await until(async()=>Boolean((await runtime.event(source,'session',d.processed_event_id)).admission.run_id));
    const call={context:{run_id:'run',session_id:'session',tool_call_id:'open'},args:{reply_mode:'none'}};
    assert.equal((await runtime.tool('paios_open_reply',call) as {status:string}).status,'silent');
    run.status=terminal;
    await until(async()=>held && (await runtime.event(source,'session',d.processed_event_id)).admission.state===terminal);
    assert.deepEqual(await runtime.tool('paios_open_reply',call),{status:'pending',error_code:'RUN_BINDING_PENDING'});
  } finally {release();await assembly.close();await rm(home,{recursive:true});}
 });
}
