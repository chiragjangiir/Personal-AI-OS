import assert from 'node:assert/strict';
import test from 'node:test';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {gzipSync} from 'node:zlib';
import {exportL5,verifyL5} from '../../deploy/cloud/staging_snapshot_l5.ts';
import {PosixStorage} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/storage.ts';
import {RawArchive} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/archive.ts';
import {EVENT_SCHEMA,canonical,digest} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/contracts.ts';

const now='2026-10-17T00:00:00.000Z';
async function foldedHistory(t:test.TestContext,count:number,attachments=0){
  const root=await fs.mkdtemp(join(tmpdir(),'snapshot-budget-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=join(root,'source'),dest=join(root,'dest'),storage=new PosixStorage(source),archive=new RawArchive(storage,65536);
  const raw={schema_version:EVENT_SCHEMA,event_id:'seed',device_id:'glasses',device_type:'glasses' as const,captured_at:now,
    source:{channel:'livekit'},media_type:'audio' as const,mime:'audio/pcm',representation:'received_decoded_sample' as const,payload:Buffer.alloc(200)};
  const trusted={principal_id:'owner',device_id:'glasses',device_type:'glasses' as const,consent_ref:'fixture',channel:'livekit' as const,submission:'observation' as const};
  const receipt=await archive.streams.append(raw,trusted,now,{track_id:'mic',stream_epoch:'epoch',seq:0,modality:'audio',format:'pcm_s16le:1000:1',
    source_range:{kind:'interval',timebase_id:'samples',stream_epoch:'epoch',start_ms:0,end_ms:100}});
  const seed=(await archive.finalizeSession(receipt.event.raw_ref,'fixture-ended'))!;
  await archive.close();await storage.close();
  // Duplicate the native single-chunk final with distinct valid identities in one SQLite transaction.
  // Audio and clock metadata stay shared, so physical-object quotas cannot hide logical receipt growth.
  const db=new DatabaseSync(join(source,'session-records.sqlite'));
  db.exec('BEGIN; DELETE FROM refs; DELETE FROM sessions;');
  const session=db.prepare('INSERT INTO sessions(id,record,object_hash,created,cleaned) VALUES(?,?,?,?,1)');
  const route=db.prepare('INSERT INTO refs(namespace,key,session,record_index) VALUES(?,?,?,?)');
  const template=JSON.parse(Buffer.from(seed.records.find(r=>r.namespace==='stream-revisions')!.bytes,'base64').toString());
  for(let i=0;i<count;i++){
    const journal=structuredClone(template);journal.event.event_id=`folded-${i}`;
    const ref=`l5:${digest({event_id:journal.event.event_id,principal_id:'owner',device_id:'glasses'})}`;
    journal.raw_ref=ref;
    if(attachments)journal.event.attachments=Array.from({length:attachments},()=>({path:'/external/shared-attachment'}));
    const revision=digest(journal),bytes=Buffer.from(canonical(journal)).toString('base64');
    const end={schema:'paios.session.end.v1',raw_ref:ref,revision,ended_by:'fixture-ended'};
    const final={...seed,raw_ref:ref,records:[{namespace:'stream-revisions',key:digest([ref,1]),bytes},
      {namespace:'stream-revisions',key:revision,bytes},
      {namespace:'session-ends',key:ref.slice(3),bytes:Buffer.from(canonical(end)).toString('base64')}]};
    session.run(ref.slice(3),gzipSync(Buffer.from(canonical(final))),final.object_hash,i);
    final.records.forEach((r,n)=>route.run(r.namespace,r.key,ref.slice(3),n));
  }
  db.exec('COMMIT');db.close();
  return {source,dest,object_hash:seed.object_hash};
}

test('shared-audio folded finals and sources respect the real 20000-item receipt budget and retry cleanly',async t=>{
  const f=await foldedHistory(t,10000);
  await assert.rejects(exportL5(f.source,f.dest,now),/L5_RECEIPT_BUDGET_EXCEEDED/);
  assert.deepEqual(await fs.readdir(f.dest),[]);
  // A retry uses the same frozen input and gets the same capacity error, never a dirty-target error.
  await assert.rejects(exportL5(f.source,f.dest,now),/L5_RECEIPT_BUDGET_EXCEEDED/);
  assert.equal((await fs.readFile(join(f.source,'objects',f.object_hash))).length,200);
});

test('repeated external attachment entries consume the shared receipt budget before target writes',async t=>{
  const f=await foldedHistory(t,1,10000); // Both original revision names retain their attachment declarations.
  const publish=t.mock.method(PosixStorage.prototype,'publishFinal');
  await assert.rejects(exportL5(f.source,f.dest,now),/L5_RECEIPT_BUDGET_EXCEEDED/);
  assert.deepEqual(await fs.readdir(f.dest),[]);
  assert.equal(publish.mock.callCount(),0);
});

test('shared-audio folded histories retain complete finals, sources and pinned revisions below capacity',async t=>{
  const f=await foldedHistory(t,4);
  const receipt=await exportL5(f.source,f.dest,now);
  assert.equal(receipt.sources.length,4);
  assert.equal(receipt.files.filter(f=>f.namespace==='session-finals').length,4);
  assert.equal(receipt.files.filter(f=>f.namespace==='objects').length,1);
  assert.ok(receipt.sources.every(s=>s.revisions?.length===2));
  await verifyL5(f.dest);
});


test('a populated destination is rejected without removing shared data',async t=>{
  const f=await foldedHistory(t,1);
  await fs.mkdir(f.dest);await fs.writeFile(join(f.dest,'shared'),'keep');
  await assert.rejects(exportL5(f.source,f.dest,now),/L5_DESTINATION_NOT_EMPTY/);
  assert.equal(await fs.readFile(join(f.dest,'shared'),'utf8'),'keep');
});
