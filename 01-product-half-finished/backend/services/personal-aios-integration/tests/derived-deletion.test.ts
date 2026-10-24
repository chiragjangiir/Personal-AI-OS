import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RawArchive} from '../src/archive.ts';
import {PosixStorage} from '../src/storage.ts';
import {digest,sha256,type ArchivedEvent,type TrustedContext} from '../src/contracts.ts';
import type {DemuxPort,DecodedTrackSet} from '../src/media/tracks.ts';
import {webdav} from './stream-materialized-fixture.ts';
import {AudioConsumption} from '../src/media/audio-consumption.ts';

const trusted:TrustedContext={principal_id:'owner',device_id:'watch',device_type:'watch',consent_ref:'fixture',channel:'watch_connectivity',submission:'observation'};
const signal=new AbortController().signal;
async function fixture(t:test.TestContext,fold=false){
  const directory=await fs.mkdtemp(join(tmpdir(),'derived-delete-')),storage=new PosixStorage(directory),archive=new RawArchive(storage,100000);
  archive.setSessionFolding(fold);
  t.after(async()=>{await archive.close();await storage.close();await fs.rm(directory,{recursive:true,force:true});});
  const original=(id:string)=>archive.archive({schema_version:'paios.event.v1',event_id:id,device_id:'watch',device_type:'watch',
    captured_at:'2026-10-18T00:00:00.000Z',source:{channel:'watch_connectivity'},media_type:'audio',mime:'audio/mp4',representation:'uploaded_original',payload:Buffer.from(id)},trusted);
  return {directory,storage,archive,original};
}
function decoded(event:ArchivedEvent,data:Buffer[]):DecodedTrackSet{
  return {event_id:event.event_id,device_id:event.device_id,decoder_id:'fixture',stream_epoch:'epoch',chunks:data.map((data,seq)=>({
    track_id:'mic',stream_epoch:'epoch',seq,modality:'audio',format:'pcm_s16le:16000:1',mime:'audio/pcm',data,
    source_range:{kind:'interval',timebase_id:'pts',stream_epoch:'epoch',start_ms:seq*10,end_ms:seq*10+data.length/32},
    pts:{pts_time:seq/100,source_time_base:'1/16000',decoder_time_base:'1/16000',decoder_pts:String(seq*160)}
  }))};
}
function port(data:Buffer[],execute?:(event:ArchivedEvent)=>Promise<DecodedTrackSet>,prepare?:()=>Promise<void>):DemuxPort{
  return {decoder_id:'fixture',demux:async event=>decoded(event,data),prepare:async()=>{
    await prepare?.();return {assertReady:()=>{},release:async()=>{},execute:execute??(async event=>decoded(event,data))};
  }};
}
const namespaces=['derived-manifests','derivation-attempts','derivation-settlements'];

test('raw delete owns unique PCM and metadata, keeps shared PCM and survives restart',async t=>{
  const {storage,archive,original}=await fixture(t),a=await original('compressed-a'),b=await original('compressed-b');
  const shared=Buffer.alloc(320,1),unique=Buffer.alloc(320,2),decoder=port([shared,unique]);
  const removed=await archive.deriveMedia(a,decoder,signal),kept=await archive.deriveMedia(b,port([shared]),signal);
  await archive.delete(a.raw_ref,'owner');
  for(const namespace of namespaces)assert.deepEqual(await storage.list(namespace),[kept.ref.split(':')[1]]);
  await assert.rejects(storage.read('objects',sha256(unique)),{code:'ENOENT'});
  assert.deepEqual(Buffer.from(await storage.read('objects',sha256(shared))),shared);
  const restarted=new RawArchive(storage,100000);t.after(()=>restarted.close());await restarted.recover();
  assert.equal((await restarted.readDerivation(b,kept.ref)).ref,kept.ref);
  await assert.rejects(restarted.readDerivation(a,removed.ref),/RAW_DELETED/);
});

test('a decoder finishing after raw delete cannot republish bytes or settlement',async t=>{
  const {storage,archive,original}=await fixture(t),event=await original('late'),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const bytes=Buffer.alloc(320,3),work=archive.deriveMedia(event,port([bytes],async event=>{entered.resolve();await release.promise;return decoded(event,[bytes]);}),signal);
  await entered.promise;await archive.delete(event.raw_ref,'owner');
  const rejected=assert.rejects(work,/RAW_DELETED/);release.resolve();await rejected;
  for(const namespace of namespaces)assert.deepEqual(await storage.list(namespace),[]);
  assert.deepEqual(await storage.list('objects'),[]);
});

test('delete during decoder admission prevents the attempt from being created',async t=>{
  const {storage,archive,original}=await fixture(t),event=await original('pre-attempt'),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const work=archive.deriveMedia(event,port([Buffer.alloc(320)],undefined,async()=>{entered.resolve();await release.promise;}),signal);
  await entered.promise;await archive.delete(event.raw_ref,'owner');
  const rejected=assert.rejects(work,/RAW_DELETED/);release.resolve();await rejected;
  for(const namespace of namespaces)assert.deepEqual(await storage.list(namespace),[]);
  assert.deepEqual(await storage.list('objects'),[]);
});

test('failed decoder after delete cannot recreate a failure settlement',async t=>{
  const {storage,archive,original}=await fixture(t),event=await original('late-failed'),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const work=archive.deriveMedia(event,port([],async()=>{entered.resolve();await release.promise;throw new Error('decoder failed');}),signal);
  await entered.promise;await archive.delete(event.raw_ref,'owner');
  const rejected=assert.rejects(work,/RAW_DELETED/);release.resolve();await rejected;
  for(const namespace of namespaces)assert.deepEqual(await storage.list(namespace),[]);
});

test('restart resumes deletion after derived metadata vanished but object removal failed',async t=>{
  for(const failure of ['derivation-attempts','objects']){
  const {storage,archive,original}=await fixture(t),event=await original('crash-delete'),bytes=Buffer.alloc(320,4);
  await archive.deriveMedia(event,port([bytes]),signal);
  const remove=storage.removeOriginals.bind(storage);let armed=true;
  storage.removeOriginals=async records=>{for(const record of records){await remove([record]);if(armed&&record.namespace===failure){armed=false;throw new Error('delete crash');}}};
  await assert.rejects(archive.delete(event.raw_ref,'owner'),/delete crash/);storage.removeOriginals=remove;
  const restarted=new RawArchive(storage,100000);t.after(()=>restarted.close());await restarted.recover();
  for(const namespace of namespaces)assert.deepEqual(await storage.list(namespace),[]);
  assert.deepEqual(await storage.list('objects'),[]);
  }
});

test('partial derived publication remains source-owned for deletion',async t=>{
  const {storage,archive,original}=await fixture(t),event=await original('partial'),one=Buffer.alloc(320,5),two=Buffer.alloc(320,6);
  const publish=storage.publish.bind(storage);
  storage.publish=async(namespace,key,bytes)=>{if(namespace==='objects'&&key===sha256(two))throw new Error('publication crash');return publish(namespace,key,bytes);};
  await assert.rejects(archive.deriveMedia(event,port([one,two]),signal),/publication crash/);storage.publish=publish;
  await archive.delete(event.raw_ref,'owner');
  assert.deepEqual(await storage.list('objects'),[]);
  for(const namespace of namespaces)assert.deepEqual(await storage.list(namespace),[]);
});

test('folded record inventory survives a crash between session-index and file removal',async t=>{
  const {storage,archive}=await fixture(t,true),payload=Buffer.alloc(320,9);
  const {event}=await archive.streams.append({schema_version:'paios.event.v1',event_id:'unfinished-fold',device_id:'watch',device_type:'watch',
    captured_at:'2026-10-18T00:00:00.000Z',source:{channel:'watch_connectivity'},media_type:'audio',mime:'audio/pcm',representation:'uploaded_original',payload},trusted,'2026-10-18T00:00:00.000Z',
    {track_id:'mic',stream_epoch:'epoch',seq:0,modality:'audio',format:'pcm_s16le:16000:1',source_range:{kind:'interval',timebase_id:'clock',stream_epoch:'epoch',start_ms:0,end_ms:10}});
  const record={namespace:'processed-media-inputs',key:digest('private decoded input')};
  await storage.trackSessionRecords(event.raw_ref,[record]);await storage.publish(record.namespace,record.key,Buffer.from('private decoded input'));
  const remove=storage.removeOriginals.bind(storage);storage.removeOriginals=async()=>{throw new Error('fold cleanup crash');};
  await assert.rejects(archive.finalizeSession(event.raw_ref,'capture_stopped'),/fold cleanup crash/);
  assert.ok(await storage.readFinal(event.raw_ref));
  await assert.rejects(archive.delete(event.raw_ref,'owner'),/fold cleanup crash/);
  assert.equal(await storage.readFinal(event.raw_ref),null);storage.removeOriginals=remove;
  const restarted=new RawArchive(storage,100000);t.after(()=>restarted.close());await restarted.recover();
  await assert.rejects(storage.read(record.namespace,record.key),{code:'ENOENT'});
});

test('legacy voice transcript records join the source deletion inventory',async t=>{
  const {storage,archive,original}=await fixture(t),removed=await original('old-voice'),kept=await original('kept-voice');
  for(const event of [removed,kept]){const key=digest(event.raw_ref);
    await storage.publish('voice-transcripts',key,Buffer.from(JSON.stringify({schema:'paios.voice-transcript.v1',raw_ref:event.raw_ref,
      principal_id:'owner',candidate_ref:`voice-candidate:${key}`})));}
  await archive.delete(removed.raw_ref,'owner');
  await assert.rejects(storage.read('voice-transcripts',digest(removed.raw_ref)),{code:'ENOENT'});
  assert.ok(await storage.read('voice-transcripts',digest(kept.raw_ref)));
});

test('repeated folding retains ownership of metadata published after the fold',async t=>{
  const {storage,archive}=await fixture(t,true),payload=Buffer.alloc(320,10);
  const {event}=await archive.streams.append({schema_version:'paios.event.v1',event_id:'late-fold-metadata',device_id:'watch',device_type:'watch',
    captured_at:'2026-10-18T00:00:00.000Z',source:{channel:'watch_connectivity'},media_type:'audio',mime:'audio/pcm',representation:'uploaded_original',payload},trusted,'2026-10-18T00:00:00.000Z',
    {track_id:'mic',stream_epoch:'epoch',seq:0,modality:'audio',format:'pcm_s16le:16000:1',source_range:{kind:'interval',timebase_id:'clock',stream_epoch:'epoch',start_ms:0,end_ms:10}});
  await archive.finalizeSession(event.raw_ref,'capture_stopped');
  const key=digest('late processed input');await storage.trackSessionRecords(event.raw_ref,[{namespace:'processed-media-inputs',key}]);
  await storage.publish('processed-media-inputs',key,Buffer.from('late processed input'));
  await archive.finalizeSession(event.raw_ref,'capture_stopped');
  await archive.delete(event.raw_ref,'owner');
  await assert.rejects(storage.read('processed-media-inputs',key),{code:'ENOENT'});
});

for(const fold of [false,true])test(`source deletion preserves shared consumer metadata (fold=${fold})`,async t=>{
  const {storage,archive}=await fixture(t,fold),events:ArchivedEvent[]=[];
  for(const id of ['a','b'])events.push((await archive.streams.append({schema_version:'paios.event.v1',event_id:`shared-${id}`,device_id:'watch',device_type:'watch',
    captured_at:'2026-10-18T00:00:00.000Z',source:{channel:'watch_connectivity'},media_type:'audio',mime:'audio/pcm',representation:'uploaded_original',payload:Buffer.alloc(320,1)},trusted,'2026-10-18T00:00:00.000Z',
    {track_id:'mic',stream_epoch:'epoch',seq:0,modality:'audio',format:'pcm_s16le:16000:1',source_range:{kind:'interval',timebase_id:'clock',stream_epoch:'epoch',start_ms:0,end_ms:10}})).event);
  const consumer=new AudioConsumption(storage,100000),route={consumer:'media' as const,source_scope:'shared-source',capture_span:'shared-span',purpose_evidence_ref:'fixture'};
  for(const event of events)await consumer.select(event,'continuous',route);
  const span=(await storage.list('audio-consumer-spans'))[0]!,own=(await storage.sessionRecords(events[0]!.raw_ref)).find(r=>r.namespace==='audio-consumer-routes')!;
  if(fold)await archive.finalizeSession(events[0]!.raw_ref,'capture_stopped');
  await archive.delete(events[0]!.raw_ref,'owner');
  assert.ok(await storage.read('audio-consumer-spans',span));
  await assert.rejects(storage.read(own.namespace,own.key),{code:'ENOENT'});
  assert.deepEqual(await consumer.selected(events[1]!),{consumer:'media',lane:'continuous'});
  const restarted=new RawArchive(storage,100000);t.after(()=>restarted.close());await restarted.recover();
  assert.ok(await storage.read('audio-consumer-spans',span));
  await restarted.delete(events[1]!.raw_ref,'owner');
  await assert.rejects(storage.read('audio-consumer-spans',span),{code:'ENOENT'});
});

for(const cold of [false,true])test(`folded delete preserves decoded slices outside the folded route index (cold=${cold})`,async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'fold-derived-delete-')),dav=cold?await webdav(t,directory):null;
  const root=join(directory,'hot'),storage=new PosixStorage(root,dav?{cold:dav.config}:{}),archive=new RawArchive(storage,100000);
  archive.setSessionFolding(true);
  t.after(async()=>{await archive.close();await storage.close();await fs.rm(directory,{recursive:true,force:true});});
  const shared=Buffer.alloc(320,7),unique=Buffer.alloc(320,8);
  const original=await archive.archive({schema_version:'paios.event.v1',event_id:'kept-compressed',device_id:'watch',device_type:'watch',
    captured_at:'2026-10-18T00:00:00.000Z',source:{channel:'watch_connectivity'},media_type:'audio',mime:'audio/mp4',representation:'uploaded_original',payload:Buffer.from('compressed')},trusted);
  const derived=await archive.deriveMedia(original,port([shared]),signal);
  let event:ArchivedEvent|undefined;
  for(const [seq,payload] of [shared,unique].entries())event=(await archive.streams.append({schema_version:'paios.event.v1',event_id:'fold-me',device_id:'watch',device_type:'watch',
    captured_at:'2026-10-18T00:00:00.000Z',source:{channel:'watch_connectivity'},media_type:'audio',mime:'audio/pcm',representation:'uploaded_original',payload},trusted,'2026-10-18T00:00:00.000Z',
    {track_id:'mic',stream_epoch:'epoch',seq,modality:'audio',format:'pcm_s16le:16000:1',source_range:{kind:'interval',timebase_id:'clock',stream_epoch:'epoch',start_ms:seq*10,end_ms:seq*10+10}})).event;
  const final=await archive.finalizeSession(event!.raw_ref,'capture_stopped');assert.ok(final);
  assert.ok(!(await storage.listHot('objects')).includes(sha256(shared)));
  if(cold){const records=[];for(const key of await storage.listHot('objects'))records.push({namespace:'objects',key,bytes:await storage.read('objects',key)});
    await storage.moveCold(records);await storage.removeOriginals(records);}
  await archive.delete(event!.raw_ref,'owner');
  assert.equal(await storage.readFinal(event!.raw_ref),null);
  assert.equal((await archive.readDerivation(original,derived.ref)).ref,derived.ref);
  await assert.rejects(storage.read('objects',final.object_hash),{code:'ENOENT'});
  await assert.rejects(storage.read('objects',sha256(unique)),{code:'ENOENT'});
  for(const record of final.records)await assert.rejects(storage.read(record.namespace,record.key),{code:'ENOENT'});
  await archive.close();await storage.close();
  const reopened=new PosixStorage(root,dav?{cold:dav.config}:{}),restarted=new RawArchive(reopened,100000);
  try{await restarted.recover();assert.equal((await restarted.readDerivation(original,derived.ref)).ref,derived.ref);
    assert.deepEqual(Buffer.from(await reopened.read('objects',sha256(shared))),shared);
    if(cold){for(const pack of await reopened.cold!.packs())assert.ok(!(await reopened.cold!.records(pack.key)).some(r=>r.key===final.object_hash||r.key===sha256(unique)));}
  }finally{await restarted.close();await reopened.close();}
});
