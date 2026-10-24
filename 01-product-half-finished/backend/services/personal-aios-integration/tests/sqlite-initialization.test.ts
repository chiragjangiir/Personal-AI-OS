import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const stores={session:'session-records.sqlite',cold:'cold.sqlite',owner:'owner.sqlite',ambient:'journal.sqlite'};
for(const [store,file] of Object.entries(stores))
test(`${store} initialization survives a competing process holding the WAL transition`,{timeout:15000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'sqlite-init-')),holder=new DatabaseSync(join(root,file));
  // Another initializer has written its schema and still owns the RESERVED lock.
  holder.exec('CREATE TABLE initializer(id);BEGIN IMMEDIATE;');
  t.after(async()=>{if(holder.isOpen)holder.close();await rm(root,{recursive:true,force:true});});
  const module=(path:string)=>JSON.stringify(new URL(`../src/${path}.ts`,import.meta.url).href);
  const actions:{[key:string]:string}={
    session:`const {SessionRecords}=await import(${module('session-records')});
      const s=new SessionRecords(root,async()=>{});try{await s.trackSessionRecords('l5:'+'a'.repeat(64),[{namespace:'objects',key:'b'.repeat(64)}]);}finally{await s.close();}`,
    cold:`const {ColdStorage}=await import(${module('cold-storage')});
      const s=new ColdStorage(root,{url:'http://127.0.0.1:1',username:'unused',password_file:'unused'});try{await s.keys('objects');}finally{await s.close();}`,
    owner:`const {openOwnerDatabase}=await import(${module('owner-db')});
      openOwnerDatabase(root,'owner.sqlite','CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);','test.v1','TEST').close();`,
    ambient:`const {AmbientJournal}=await import(${module('ambient/journal')});AmbientJournal.open(root).close();`,
  };
  const code=`import {DatabaseSync} from 'node:sqlite';
    const root=process.argv[1],exec=DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec=function(sql){
      let rest=sql.trim();
      while(rest){const pragma=/^PRAGMA[^;]+;?/i.exec(rest),statement=pragma?pragma[0].replace(/;$/,'').trim():rest;
        const started=performance.now();try{exec.call(this,statement);}
        catch(error){process.send({statement,errcode:error.errcode,timeout:this.prepare('PRAGMA busy_timeout').get().timeout,elapsed_ms:performance.now()-started});throw error;}
        if(!pragma)break;rest=rest.slice(pragma[0].length).trim();
      }
    };
    try{${actions[store]}process.disconnect();}
    catch(error){console.error(error);process.exitCode=1;process.disconnect();}`;
  const child=spawn(process.execPath,['--input-type=module','-e',code,root],{stdio:['ignore','ignore','pipe','ipc']});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  let errors='',released=false;const busy:{statement:string;errcode:number;timeout:number}[]=[];
  child.stderr.on('data',b=>{errors+=String(b);});
  child.on('message',message=>{
    busy.push(message as typeof busy[number]);
    if(!released){holder.exec('COMMIT');released=true;}
  });
  const status=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  assert.ok(busy.length>0,'the barrier must provoke a real SQLite lock conflict');
  assert.equal(busy[0]!.statement,'PRAGMA journal_mode=WAL');assert.equal(busy[0]!.errcode,5);
  t.diagnostic(JSON.stringify({store,first_busy:busy[0]}));
  assert.equal(status,0,errors);
  holder.close();const reopened=new DatabaseSync(join(root,file));
  try{
    assert.equal(reopened.prepare('PRAGMA journal_mode').get()!.journal_mode,'wal');
    const expected=({session:'inflight',cold:'locations',owner:'meta',ambient:'entries'} as Record<string,string>)[store];
    assert.ok(reopened.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(expected!));
  }finally{reopened.close();}
});

test('cold initialization stops at its busy budget, closes the failed handle and can reopen',{timeout:15000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'sqlite-init-budget-')),path=join(root,'cold.sqlite'),holder=new DatabaseSync(path);
  holder.exec('CREATE TABLE initializer(id);BEGIN IMMEDIATE;');
  t.after(async()=>{if(holder.isOpen)holder.close();await rm(root,{recursive:true,force:true});});
  const module=JSON.stringify(new URL('../src/cold-storage.ts',import.meta.url).href);
  const code=`import {DatabaseSync} from 'node:sqlite';import {once} from 'node:events';
    import {ColdStorage} from ${module};
    let closed=0;const close=DatabaseSync.prototype.close;
    DatabaseSync.prototype.close=function(){closed++;return close.call(this);};
    const s=new ColdStorage(process.argv[1],{url:'http://127.0.0.1:1',username:'unused',password_file:'unused'});
    try{
      let failure;const started=performance.now();try{await s.keys('objects');}catch(error){failure=error;}
      const released=once(process,'message');process.send({errcode:failure?.errcode,closed,elapsed_ms:performance.now()-started});await released;
      await s.keys('objects');await s.close();process.disconnect();
    }catch(error){console.error(error);process.exitCode=1;process.disconnect();}`;
  const child=spawn(process.execPath,['--input-type=module','-e',code,root],{stdio:['ignore','ignore','pipe','ipc']});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  let errors='',failure:{errcode:number;closed:number;elapsed_ms:number}|undefined;
  child.stderr.on('data',b=>{errors+=String(b);});
  child.once('message',message=>{failure=message as typeof failure;holder.exec('COMMIT');child.send('released');});
  const status=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  assert.ok(failure);assert.equal(failure.errcode,5);assert.equal(failure.closed,1);
  assert.ok(failure.elapsed_ms>=4900,'BUSY must consume its bounded startup budget before surfacing');
  t.diagnostic(JSON.stringify(failure));assert.equal(status,0,errors);
});
