import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configureSqlite,inTransaction} from '../src/owner-db.ts';

test('WAL startup propagates non-BUSY errors without retry',t=>{
  const db=new DatabaseSync(':memory:'),failure=Object.assign(new Error('disk I/O error'),{errcode:10});
  const prepare=t.mock.method(db,'prepare',()=>{throw failure;});
  try{assert.throws(()=>configureSqlite(db),error=>error===failure);assert.equal(prepare.mock.callCount(),1);}
  finally{db.close();}
});

test('SQLite FULL preserves capacity error after automatic rollback and permits the same retry',async t=>{
  const root=await mkdtemp(join(tmpdir(),'paios-owner-full-'));
  const db=new DatabaseSync(join(root,'owner.sqlite'));
  t.after(async()=>{db.close();await rm(root,{recursive:true,force:true});});
  db.exec('PRAGMA page_size=4096;PRAGMA journal_mode=WAL;CREATE TABLE records(id TEXT PRIMARY KEY,body BLOB) STRICT;');
  db.prepare('INSERT INTO records VALUES(?,?)').run('original',Buffer.from('retained'));
  const pages=(db.prepare('PRAGMA page_count').get() as {page_count:number}).page_count;
  db.exec(`PRAGMA max_page_count=${pages}`);
  const insert=()=>db.prepare('INSERT INTO records VALUES(?,?)').run('retry',Buffer.alloc(65536));
  assert.throws(()=>inTransaction(db,insert),(error:unknown)=>{
    assert.equal((error as {errcode:number}).errcode,13);
    assert.match((error as Error).message,/full/i);return true;
  });
  assert.equal(db.isTransaction,false);
  assert.deepEqual({...db.prepare('SELECT id,CAST(body AS TEXT) AS body FROM records').get()},{id:'original',body:'retained'});
  db.exec('PRAGMA max_page_count=1000');
  inTransaction(db,insert);
  assert.equal(db.prepare("SELECT count(*) AS n FROM records WHERE id='retry'").get()!.n,1);
});

test('deferred constraint failure at COMMIT rolls back and keeps the connection usable',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec('PRAGMA foreign_keys=ON;CREATE TABLE parent(id INTEGER PRIMARY KEY);CREATE TABLE child(id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);');
    assert.throws(()=>inTransaction(db,()=>db.exec('INSERT INTO child VALUES(1)')),/FOREIGN KEY constraint failed/);
    assert.equal(db.isTransaction,false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM child').get()!.n,0);
    inTransaction(db,()=>db.exec('INSERT INTO parent VALUES(1);INSERT INTO child VALUES(1);'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM child').get()!.n,1);
  }finally{db.close();}
});

test('rollback failure preserves both failures and closes the unhealthy connection',()=>{
  const db=new DatabaseSync(':memory:'),primary=new Error('work failed'),cleanup=new Error('rollback failed');
  const exec=db.exec.bind(db);
  db.exec=(sql:string)=>{if(sql==='ROLLBACK')throw cleanup;exec(sql);};
  try{
    assert.throws(()=>inTransaction(db,()=>{throw primary;}),(error:unknown)=>{
      assert.ok(error instanceof AggregateError);assert.equal(error.cause,primary);
      assert.deepEqual(error.errors,[primary,cleanup]);return true;
    });
    assert.equal(db.isOpen,false);
  }finally{if(db.isOpen)db.close();}
});
