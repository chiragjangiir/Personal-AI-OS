import assert from 'node:assert/strict';
import test from 'node:test';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {assertVisualReady,exportVisual,verifyVisual} from '../../deploy/cloud/staging_snapshot_visual.ts';
const {getLoadablePath}=createRequire(new URL('../../01-product-half-finished/backend/services/personal-aios-integration/package.json',import.meta.url))('sqlite-vec');

const now='2026-10-17T00:00:00.000Z',recent=Date.parse(now)-1000,old=Date.parse(now)-3*86400000;
async function fixture(t:test.TestContext){
  const root=await fs.mkdtemp(join(tmpdir(),'staging-visual-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=join(root,'source'),dest=join(root,'output','visual-memory');await fs.mkdir(join(source,'frames'),{recursive:true});await fs.mkdir(join(root,'output'));
  const db=new DatabaseSync(join(source,'visual.sqlite'),{allowExtension:true});db.loadExtension(getLoadablePath());
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);INSERT INTO meta VALUES('schema','paios.visual-memory.v2');
    CREATE TABLE frames(id INTEGER PRIMARY KEY,frame_key TEXT,captured_ms INTEGER,raw_ref TEXT,archive_revision TEXT,original TEXT,thumbnail TEXT,cold_ref TEXT,cold_confirmed INTEGER,owner_delete INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE frame_people(frame_key TEXT,person_id TEXT);
    CREATE TABLE capture_refs(raw_ref TEXT,owner_delete INTEGER);
    INSERT INTO capture_refs VALUES('deleted-old',2);
    CREATE TABLE cold_deletes(reference TEXT);INSERT INTO cold_deletes VALUES('production-delete');
    CREATE VIRTUAL TABLE vectors USING vec0(embedding float[4]);`);
  for(const [id,at,label] of [[1,old,'old'],[2,recent,'recent']] as const){
    db.prepare('INSERT INTO frames VALUES(?,?,?,?,?,?,?,?,?,0)').run(id,label,at,`l5:${label}`,`revision-${label}`,'',`frames/${label}-thumb.jpg`,null,0);
    db.prepare('INSERT INTO vectors(rowid,embedding) VALUES(?,?)').run(BigInt(id),new Float32Array(4));
    db.prepare('INSERT INTO frame_people VALUES(?,?)').run(label,'person');await fs.writeFile(join(source,'frames',`${label}-thumb.jpg`),label);
  }
  db.close();
  await fs.writeFile(join(root,'output','l5-inventory.json'),JSON.stringify({sources:[{ref:'l5:recent',revision:'revision-recent'}]}));
  return {root,source,dest};
}
test('visual export prunes old bytes and exact catalogue rows, preserving revocations',async t=>{
  const f=await fixture(t),mtime=(await fs.stat(f.source)).mtimeMs;
  const receipt=await exportVisual(f.source,f.dest,now);assert.equal(receipt.source_rows,2);assert.equal(receipt.selected_rows,1);
  assert.equal((await fs.stat(f.source)).mtimeMs,mtime);assert.deepEqual(await fs.readdir(join(f.dest,'frames')),['recent-thumb.jpg']);
  const db=new DatabaseSync(join(f.dest,'visual.sqlite'),{allowExtension:true});db.loadExtension(getLoadablePath());
  try{for(const table of ['frames','vectors','frame_people','capture_refs'])assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM cold_deletes').get()!.n,0);
  }finally{db.close();}
  await verifyVisual(f.dest);
});
test('recent native visual row missing from exported L5 fails explicitly',async t=>{
  const f=await fixture(t);await fs.writeFile(join(f.root,'output','l5-inventory.json'),JSON.stringify({sources:[]}));
  await assert.rejects(exportVisual(f.source,f.dest,now),/VISUAL_RECENT_NATIVE_L5_REFERENCE_MISSING/);
});
test('legacy visual row without its original fails instead of inventing bytes or identity',async t=>{
  const f=await fixture(t),db=new DatabaseSync(join(f.source,'visual.sqlite'));
  db.exec("UPDATE frames SET raw_ref=NULL,archive_revision=NULL WHERE frame_key='recent'");db.close();
  await assert.rejects(exportVisual(f.source,f.dest,now),/VISUAL_LEGACY_ORIGINAL_REQUIRED/);
});
test('legacy original is transported unchanged but cannot pass readiness before native import',async t=>{
  const f=await fixture(t),db=new DatabaseSync(join(f.source,'visual.sqlite'));
  db.exec("UPDATE frames SET raw_ref=NULL,archive_revision=NULL,original='frames/recent.jpg' WHERE frame_key='recent'");db.close();
  await fs.writeFile(join(f.source,'frames/recent.jpg'),'original fixture');
  const receipt=await exportVisual(f.source,f.dest,now);
  assert.equal(receipt.legacy_rows,1);assert.deepEqual(receipt.native_refs,[]);
  assert.equal(await fs.readFile(join(f.dest,'frames/recent.jpg'),'utf8'),'original fixture');
  await verifyVisual(f.dest);await assert.rejects(assertVisualReady(f.dest),/VISUAL_LEGACY_IMPORT_REQUIRED/);
});
test('a pending owner deletion does not export its recent thumbnail or native reference',async t=>{
  const f=await fixture(t),db=new DatabaseSync(join(f.source,'visual.sqlite'));
  db.exec("UPDATE frames SET owner_delete=1 WHERE frame_key='recent'");db.close();
  const receipt=await exportVisual(f.source,f.dest,now);
  assert.equal(receipt.selected_rows,0);assert.deepEqual(receipt.files,[]);assert.deepEqual(receipt.native_refs,[]);
  await verifyVisual(f.dest);
});
test('absent visual store is explicit; existing incomplete store fails',async t=>{
  const f=await fixture(t),missing=join(f.root,'missing');
  assert.equal((await exportVisual(missing,f.dest,now)).absent,true);
  assert.equal((await verifyVisual(missing)).absent,true);
  await fs.mkdir(f.dest,{recursive:true});await assert.rejects(verifyVisual(f.dest),{code:'ENOENT'});
});
test('visual pinned stream revision accepts its source lane and rejects another raw_ref',async t=>{
  const f=await fixture(t),output=join(f.root,'output');await fs.mkdir(join(output,'stream-revisions'));
  const revision=join(output,'stream-revisions','revision-recent');
  await fs.writeFile(revision,JSON.stringify({raw_ref:'l5:recent',revision:1}));
  await fs.writeFile(join(output,'l5-inventory.json'),JSON.stringify({
    sources:[{ref:'l5:recent',revision:'revision-head',kind:'stream'}],
    files:[{namespace:'stream-revisions',key:'revision-recent'}]}));
  const receipt=await exportVisual(f.source,f.dest,now);
  assert.equal(receipt.native_refs[0].archive_revision,'revision-recent');await verifyVisual(f.dest);
  await fs.writeFile(revision,JSON.stringify({raw_ref:'l5:another-lane',revision:1}));
  await assert.rejects(verifyVisual(f.dest),/VISUAL_RECENT_NATIVE_L5_REFERENCE_MISSING/);
});
