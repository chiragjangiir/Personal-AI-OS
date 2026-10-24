import test from 'node:test';
import assert from 'node:assert/strict';
import {paymentCallAudio} from '../src/personal-aios-payment-source.ts';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RawArchive} from '../../../services/personal-aios-integration/src/archive.ts';
import {PosixStorage} from '../../../services/personal-aios-integration/src/storage.ts';
import {EVENT_SCHEMA,type RawEvent,type TrustedContext} from '../../../services/personal-aios-integration/src/contracts.ts';

// Clock admission stays owned by the existing authority. Only its external ports are controlled here.
function fixture(){
  const event={raw_ref:'l5:'+'a'.repeat(64),archive_revision:'b'.repeat(64),principal_id:'owner',device_id:'phone'};
  const chunk={track_id:'microphone',stream_epoch:'epoch',modality:'audio',format:'pcm_s16le:16000:1',
    source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'epoch',start_ms:0,end_ms:1000}};
  const map={track_id:'microphone',stream_epoch:'epoch',modality:'audio',source_timebase_id:'samples',target_timebase_id:'utc_epoch_ms',offset_ms:1000000,drift_ppm:100,uncertainty_ms:1,basis_ref:'test-clock'};
  const reads:unknown[][]=[],admissions:unknown[][]=[];
  const terminal={pcm:()=>({capture:async()=>({binding:{id:'current'},trusted:{principal_id:'owner',device_id:'phone'}})}),
    clock:{archivedReceiptClockMaps:async()=>[map],authorizeClockMaps:async(...args:unknown[])=>{admissions.push(args);}}};
  const archive={readRecord:async(...args:unknown[])=>{reads.push(args);return {kind:'stream',manifest:{chunks:[chunk]}};}};
  return {event,chunk,map,reads,admissions,terminal,archive,
    run:(refs:unknown[])=>paymentCallAudio(refs.map(ref=>Promise.resolve(ref)) as never,terminal as never,archive as never)};
}
test('call audio binds clipped sample support to the final pinned revision and authorized UTC map',async()=>{
  const f=fixture(),latest={...f.event,archive_revision:'c'.repeat(64)};
  const audio=await f.run([{event:f.event,chunk:f.chunk,sample_from:1600,sample_to:8000},
    {silence_samples:1600},{event:latest,chunk:f.chunk,sample_from:9600,sample_to:14400}]);
  assert.deepEqual(audio,{raw_ref:latest.raw_ref,archive_revision:latest.archive_revision,start_ms:1000100.01,end_ms:1000900.09});
  assert.deepEqual(f.reads,[[latest.raw_ref,'owner',latest.archive_revision,{proof_only:true}]]);
  assert.equal(f.admissions.length,1);assert.equal((f.admissions[0]![1] as unknown[])[0],f.map);
});
test('call audio cannot invent an archive, bridge devices or epochs, or use out-of-chunk samples',async()=>{
  for(const alter of [(f:ReturnType<typeof fixture>)=>[],
    (f:ReturnType<typeof fixture>)=>[{event:{...f.event,device_id:'other'},chunk:f.chunk,sample_from:0,sample_to:100}],
    (f:ReturnType<typeof fixture>)=>[{event:f.event,chunk:f.chunk,sample_from:0,sample_to:16001}],
    (f:ReturnType<typeof fixture>)=>[{event:f.event,chunk:f.chunk,sample_from:0,sample_to:100},
      {event:f.event,chunk:{...f.chunk,stream_epoch:'other'},sample_from:0,sample_to:100}]]){
    const f=fixture();await assert.rejects(f.run(alter(f)),/PAYMENT_CALL_AUDIO/);assert.deepEqual(f.admissions,[]);
  }
});

test('payment call evidence keeps exact old raw ranges after session folding and restart',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'payment-fold-')),storage=new PosixStorage(root);
  const budget={max_chunk_bytes:3200,max_total_bytes:10000,max_chunks:10,max_revisions:10,max_seq:10};
  const writer=new RawArchive(storage,10000,undefined,budget),saved=[];
  const trusted:TrustedContext={principal_id:'owner',device_id:'phone',device_type:'phone',consent_ref:'consent',channel:'livekit',submission:'observation'};
  for(let seq=0;seq<3;seq++){
    const raw:RawEvent={schema_version:EVENT_SCHEMA,event_id:'payment-call',device_id:'phone',device_type:'phone',captured_at:'2026-10-01T00:00:00.000Z',
      source:{channel:'livekit'},media_type:'audio',mime:'audio/pcm',representation:'received_decoded_sample',payload:Buffer.alloc(3200,seq+1)};
    saved.push(await writer.streams.append(raw,trusted,raw.captured_at,{track_id:'microphone',stream_epoch:'epoch',seq,modality:'audio',format:'pcm_s16le:16000:1',
      source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'epoch',start_ms:seq*100,end_ms:(seq+1)*100}}));
  }
  const terminal=fixture().terminal,refs=saved.map(a=>Promise.resolve({event:a.event,chunk:a.chunk,sample_from:0,sample_to:1600}));
  const before=await paymentCallAudio(refs,terminal as never,writer);
  await writer.finalizeSession(saved[2]!.event.raw_ref,'call_hangup');await writer.close();await storage.close();
  const disk=new PosixStorage(root),reader=new RawArchive(disk,10000,undefined,budget);
  t.after(async()=>{await reader.close();await disk.close();await fs.rm(root,{recursive:true,force:true});});
  assert.deepEqual(await paymentCallAudio(refs,terminal as never,reader),before);
  for(const a of saved)assert.deepEqual(Buffer.from((await reader.readExactChunk(a.event,a.chunk,3200)).bytes),Buffer.alloc(3200,a.chunk.seq+1));
});
