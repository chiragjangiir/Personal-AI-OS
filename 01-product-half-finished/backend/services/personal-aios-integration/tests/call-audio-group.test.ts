import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RawArchive} from '../src/archive.ts';
import {PosixStorage} from '../src/storage.ts';
import {digest,EVENT_SCHEMA,type RawEvent,type TrustedContext} from '../src/contracts.ts';
import type {CallAudioTrack,FinalSession} from '../src/session-records.ts';
import type {TrackChunk} from '../src/stream-archive.ts';
const at='2026-10-01T00:00:00.000Z';
const trusted:TrustedContext={principal_id:'owner',device_id:'glasses',device_type:'glasses',consent_ref:'consent',channel:'livekit',submission:'observation'};
const chunk:TrackChunk={track_id:'audio',stream_epoch:'epoch',seq:0,modality:'audio',format:'pcm_s16le:16000:1',source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'epoch',start_ms:0,end_ms:100}};
const raw=(id:string,n:number):RawEvent=>({schema_version:EVENT_SCHEMA,event_id:id,device_id:'glasses',device_type:'glasses',captured_at:at,source:{channel:'livekit'},media_type:'audio',mime:'audio/pcm',representation:'received_decoded_sample',payload:Buffer.alloc(3200,n)});
const ref=(id:string)=>`l5:${digest({event_id:id,principal_id:'owner',device_id:'glasses'})}`;
const group=(track:CallAudioTrack['track']):CallAudioTrack=>({call_id:'call-one',principal_id:'owner',track});
const archive=(s:PosixStorage)=>new RawArchive(s,100000,()=>at,{max_chunk_bytes:3200,max_total_bytes:100000,max_chunks:64,max_revisions:64,max_seq:100});
async function fixture(t:test.TestContext){const root=await fs.mkdtemp(join(tmpdir(),'call-group-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
test('durable group retains separate tracks and pinned bytes through fold and restart',async t=>{
  const root=await fixture(t),s=new PosixStorage(root),a=archive(s),saved=[];
  for(const [i,track] of (['pre_call_ambient','microphone','assistant_reply'] as const).entries()){
    const id=`track-${i}`;await a.bindCallTrack(ref(id),group(track));saved.push(await a.streams.append(raw(id,i+1),trusted,at,chunk));
    assert.deepEqual((await a.finalizeSession(ref(id),'ended'))?.call,group(track));
  }
  await a.close();await s.close();const reopened=new PosixStorage(root),reader=archive(reopened);t.after(()=>reopened.close());
  const tracks=await reader.readCallTracks('call-one','owner');assert.equal(tracks.length,3);assert.ok(tracks.every(r=>r.finalized));
  assert.deepEqual(new Set(tracks.map(r=>r.track)),new Set(['pre_call_ambient','microphone','assistant_reply']));assert.deepEqual(await reader.readCallTracks('call-one','other'),[]);
  for(const [i,item] of saved.entries()){const record=await reader.readRecord(item.event.raw_ref,'owner',item.event.archive_revision);
    assert.equal(record.kind,'stream');if(record.kind==='stream')assert.deepEqual(Buffer.from(record.chunks[0]!.bytes),Buffer.alloc(3200,i+1));}
});
test('pre-admission binding survives restart and rejects conflicting identities',async t=>{
  const root=await fixture(t),s=new PosixStorage(root),a=archive(s);await a.bindCallTrack(ref('pending'),group('microphone'));await a.close();await s.close();
  const reopened=new PosixStorage(root),reader=archive(reopened);t.after(()=>reopened.close());assert.deepEqual(await reader.readCallTracks('call-one','owner'),[]);
  assert.deepEqual(await reader.readCallBindings('call-one','owner'),[{raw_ref:ref('pending'),track:'microphone',finalized:false}]);
  await reader.bindCallTrack(ref('pending'),group('microphone'));
  for(const conflict of [{...group('microphone'),principal_id:'other'},group('assistant_reply'),{...group('microphone'),call_id:'different'}])await assert.rejects(reader.bindCallTrack(ref('pending'),conflict),/CALL_TRACK_CONFLICT/);
  await reader.streams.append(raw('pending',4),trusted,at,chunk);assert.equal((await reader.readCallTracks('call-one','owner'))[0]!.finalized,false);
});
class CrashStorage extends PosixStorage {crash=true;override async publishFinal(record:FinalSession){const result=await super.publishFinal(record);if(this.crash){this.crash=false;throw new Error('CRASH_AFTER_FOLD');}return result;}}
test('fold crash keeps final association and permits cleanup resume',async t=>{
  const root=await fixture(t),s=new CrashStorage(root),a=archive(s);await a.bindCallTrack(ref('crash'),group('assistant_reply'));await a.streams.append(raw('crash',5),trusted,at,chunk);
  await assert.rejects(a.finalizeSession(ref('crash'),'ended'),/CRASH_AFTER_FOLD/);assert.deepEqual((await s.readFinal(ref('crash')))?.call,group('assistant_reply'));
  await a.close();await s.close();const reopened=new PosixStorage(root),reader=archive(reopened);t.after(()=>reopened.close());await reader.finalizeSession(ref('crash'),'ended');
  assert.equal((await reader.readCallTracks('call-one','owner'))[0]!.finalized,true);await reader.bindCallTrack(ref('crash'),group('assistant_reply'));
});
test('ungrouped immutable final rejects late association',async t=>{
  const root=await fixture(t),s=new PosixStorage(root),a=archive(s);t.after(()=>s.close());await a.streams.append(raw('old-final',7),trusted,at,chunk);
  const before=await a.finalizeSession(ref('old-final'),'ended');await assert.rejects(a.bindCallTrack(ref('old-final'),group('pre_call_ambient')),/CALL_TRACK_ALREADY_FINAL/);
  assert.deepEqual(await s.readFinal(ref('old-final')),before);assert.deepEqual(await a.readCallTracks('call-one','owner'),[]);
});

test('microphone rollover preserves separate sources in durable binding order',async t=>{
  const root=await fixture(t),s=new PosixStorage(root),a=archive(s);
  const ids=['roll-0','roll-1'].sort((x,y)=>ref(y).localeCompare(ref(x)));
  for(const [i,id] of ids.entries()){
    await a.bindCallTrack(ref(id),group('microphone'));await a.streams.append(raw(id,i+8),trusted,at,chunk);
    await a.finalizeSession(ref(id),'rollover');
  }
  await a.close();await s.close();const reopened=new PosixStorage(root),reader=archive(reopened);t.after(()=>reopened.close());
  const tracks=await reader.readCallTracks('call-one','owner');assert.deepEqual(tracks.map(r=>r.raw_ref),ids.map(ref));
  assert.ok(tracks.every(r=>r.track==='microphone'&&r.finalized));
});

test('a mismatched first principal binding cannot fold or unlink the real source',async t=>{
  const root=await fixture(t),s=new PosixStorage(root),a=archive(s);t.after(()=>s.close());
  await a.bindCallTrack(ref('wrong-principal'),{...group('microphone'),principal_id:'other'});
  const saved=await a.streams.append(raw('wrong-principal',9),trusted,at,chunk);
  await assert.rejects(a.finalizeSession(ref('wrong-principal'),'ended'),/CALL_TRACK_PRINCIPAL_CONFLICT/);
  assert.equal(await s.readFinal(ref('wrong-principal')),null);
  assert.deepEqual(Buffer.from(await s.read('objects',saved.chunk.object_hash)),Buffer.alloc(3200,9));
  await assert.rejects(a.readCallTracks('call-one','other'),/RAW_ACCESS_DENIED/);
});
