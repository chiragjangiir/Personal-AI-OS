import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PersonalAIOSRuntime } from './native-source-fixture.ts';
import { RawArchive } from '../src/archive.ts';
import { RunAdmission } from './native-source-fixture.ts';
import { OutputAuthority } from '../src/output.ts';
import type { FixtureRegisteredDevice } from '../src/source-authority.ts';
export const policy={max_pending_events:8,max_pending_bytes:100000,max_event_age_ms:100000,poll_interval_ms:5,native_idempotency_retention_ms:100000,policy_version:'replay'};
export function readonlyRuntime(root:string,devices:FixtureRegisteredDevice[]) {
  const calls={native:0,writes:0,receipts:0,tts:0};
  const forbidden=async()=>{calls.native++;throw new Error('NATIVE_FORBIDDEN');};
  const native={create:forbidden,status:forbidden,cancel:forbidden};
  const storage={read:async(namespace:string,key:string)=>readFile(join(root,namespace,key)),
    publish:async()=>{calls.writes++;throw new Error('WRITE_FORBIDDEN');},list:async(namespace:string)=>{
      // Authentication reads durable deletion intents; it must not restore run/admission queues.
      if(namespace!=='owner-deletions')throw new Error('RESTORE_FORBIDDEN');
      try{return await readdir(join(root,namespace));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
    },removePending:async()=>{throw new Error('REMOVE_FORBIDDEN');}};
  const output=new OutputAuthority(storage,{listRunReceipts:async()=>{calls.receipts++;throw new Error('RECEIPT_REFRESH_FORBIDDEN');},
    tts:{synthesize:async()=>{calls.tts++;throw new Error('TTS_FORBIDDEN');}}});
  return {calls,runtime:new PersonalAIOSRuntime({storage,archive:new RawArchive(storage,8192),admission:new RunAdmission(storage,native,policy),native,output,devices,skill:'fixed',max_read_bytes:8192})};
}
if(process.argv[1]?.endsWith('sealed-replay-check.ts')) {
  const config=JSON.parse(await readFile(process.argv[3]!,'utf8'));
  const {runtime,calls}=readonlyRuntime(process.argv[2]!,config.devices);
  const result=await runtime.result(await runtime.authenticate('fixture-token'),config.session,config.d,{text_replay:'sealed'});
  await runtime.close();process.stdout.write(JSON.stringify({result,calls}));
}
