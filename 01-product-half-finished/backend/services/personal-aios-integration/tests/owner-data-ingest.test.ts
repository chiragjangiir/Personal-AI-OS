import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay,setImmediate as turn} from 'node:timers/promises';
import {OwnerDataIngest} from '../src/owner-data-ingest.ts';

test('busy owner data retains bounded pages, drains once per loop turn and surfaces commit failure',async()=>{
  let busy=true;const queue=new OwnerDataIngest(()=>busy,1024),commits:number[]=[];
  try{
    const first=queue.enqueue(100,async()=>()=>{commits.push(1);setImmediate(()=>{busy=true;});return 'committed';});
    const second=queue.enqueue(100,async()=>()=>{commits.push(2);throw new Error('SQLITE_COMMIT_FAILED');});
    const rejected=assert.rejects(second,/SQLITE_COMMIT_FAILED/);
    assert.throws(()=>queue.enqueue(100,async()=>()=>{}),/OWNER_DATA_INGEST_BACKLOG/);
    await delay(60);assert.deepEqual(commits,[]);
    busy=false;assert.equal(await first,'committed');await turn();assert.deepEqual(commits,[1]);
    busy=false;await rejected;assert.deepEqual(commits,[1,2]);
  }finally{queue.close();}
});

test('call opening during source authorization defers commit and revalidates authority on resume',async()=>{
  let busy=false,prepared=0,committed=false;
  const authorizing=Promise.withResolvers<()=>boolean>(),queue=new OwnerDataIngest(()=>busy,1024);
  try{
    const receipt=queue.enqueue(10,async()=>{if(++prepared===1)return authorizing.promise;throw new Error('DEVICE_REVOKED');});
    const rejected=assert.rejects(receipt,/DEVICE_REVOKED/);
    await turn();busy=true;authorizing.resolve(()=>{committed=true;return true;});
    await turn();assert.equal(committed,false);assert.equal(prepared,1);
    busy=false;await rejected;assert.equal(prepared,2);assert.equal(committed,false);
  }finally{queue.close();}
});

test('closing owner-data ingress rejects queued and authorizing receipts without a commit',async()=>{
  const queue=new OwnerDataIngest(()=>false,1024),authorizing=Promise.withResolvers<()=>void>();let committed=false;
  const first=queue.enqueue(10,()=>authorizing.promise),second=queue.enqueue(10,async()=>()=>{committed=true;});
  const rejected=Promise.all([assert.rejects(first,/RUNTIME_CLOSED/),assert.rejects(second,/RUNTIME_CLOSED/)]);
  await turn();queue.close();authorizing.resolve(()=>{committed=true;});await rejected;await turn();
  assert.equal(committed,false);assert.throws(()=>queue.enqueue(10,async()=>()=>{}),/RUNTIME_CLOSED/);
});
