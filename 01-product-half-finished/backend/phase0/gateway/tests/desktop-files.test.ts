import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Room} from '@livekit/rtc-node';
import {createDesktopFiles,DESKTOP_FILE_TOPIC,type DesktopFileConfig} from '../src/desktop-files.ts';
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
let nextId=0;
const transferId=()=>`dt-0199aabb-ccdd-7000-8000-${String(++nextId).padStart(12,'0')}`;
const settle=async()=>{for(let n=0;n<30;n++)await new Promise<void>(done=>setImmediate(done));};
async function fixture(t:test.TestContext,overrides:Partial<DesktopFileConfig>={}) {
  const temp=await fs.mkdtemp(join(tmpdir(),'desktop-files-')),root=await fs.realpath(temp),errors:unknown[]=[];
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(join(root,'desktop-out','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),{recursive:true});
  const config:DesktopFileConfig={inbox:join(root,'inbox'),workshop:join(root,'desktop-out'),enabled:true,upload_enabled:true,
    max_file_bytes:100,daily_upload_bytes:100,inbox_total_bytes:200,inbox_ttl_s:2,save_max_file_bytes:100,keep_workshop_copies:false,onError:error=>errors.push(error),...overrides};
  const files=await createDesktopFiles(config);let closed=false;t.after(async()=>{if(!closed)await files.close();});
  const room=new Room() as any;let current=true;
  const peer={room,principal:'owner',deviceType:'mac',capabilities:['desktop_tools'],identity:'mac-credential',current:()=>current,authorize:async()=>({})};
  const attached=files.attach(peer);
  const start=(request:string,bytes:Uint8Array,attrs:Record<string,string>={},identity='mac-credential',declared=bytes.length)=>{
    const id=attrs.transfer??transferId(),metadata={v:'1',dir:'up',transfer:id,name:'sample.bin',size:String(declared),sha256:sha(bytes),request,...attrs};
    room.handleStreamHeader({streamId:id,topic:DESKTOP_FILE_TOPIC,mimeType:'application/octet-stream',totalLength:BigInt(declared),timestamp:0n,attributes:metadata,contentHeader:{case:'byteHeader',value:{name:metadata.name}}},identity);
    return {metadata,chunk:(chunk=bytes)=>room.handleStreamChunk({streamId:id,content:chunk,chunkIndex:0n}),finish:()=>room.handleStreamTrailer({streamId:id})};
  };
  const upload=async(bytes:Uint8Array,attrs:Record<string,string>={},declared=bytes.length)=>{
    const request=`request-${nextId+1}`,signal=new AbortController(),hold=attached.expectUpload(request,signal.signal),stream=start(request,bytes,attrs,'mac-credential',declared);
    stream.chunk();stream.finish();return hold({transfer_id:stream.metadata.transfer,size:declared,sha256:stream.metadata.sha256});
  };
  return {root,config,files,room,peer,attached,start,upload,errors,setCurrent:(value:boolean)=>{current=value;},close:async()=>{await files.close();closed=true;}};
}
test('I11 uploads stream to exclusive workshop-readable files and verify size and hash before holdback releases',async t=>{
  const f=await fixture(t),bytes=Buffer.from('bounded upload'),receipt=await f.upload(bytes);
  assert.equal(receipt.size,bytes.length);assert.equal(receipt.sha256,sha(bytes));
  const path=join(f.config.inbox,receipt.transfer_id,'sample.bin');assert.deepEqual(await fs.readFile(path),bytes);
  assert.equal((await fs.stat(path)).mode&0o777,0o644);assert.equal((await fs.stat(join(f.config.inbox,receipt.transfer_id))).mode&0o777,0o755);
  assert.equal(receipt.workshop_path,`/owner/in/${receipt.transfer_id}/sample.bin`);
  await assert.rejects(f.upload(bytes,{sha256:'0'.repeat(64)}),/TRANSFER_INTEGRITY/);
  await assert.rejects(f.upload(bytes,{},bytes.length+1),/TRANSFER_INTEGRITY/);
  await assert.rejects(f.upload(Buffer.alloc(101)),/TRANSFER_TOO_LARGE/);
  for(const name of ['../escape','.hidden','bad/name','bad\0name','x'.repeat(256)])await assert.rejects(f.upload(bytes,{name}),/TRANSFER_INTEGRITY/);
  await assert.rejects(f.upload(bytes,{dir:'down'}),/TRANSFER_INTEGRITY/);
});
test('I11 concurrent reservations bound inbox bytes; cancelled partial uploads release only their own quota',async t=>{
  const f=await fixture(t,{inbox_total_bytes:10,daily_upload_bytes:100}),controller=new AbortController(),bytes=Buffer.alloc(8);
  const hold=f.attached.expectUpload('pending',controller.signal),stream=f.start('pending',bytes);stream.chunk(Buffer.from('ab'));await settle();
  await assert.rejects(f.upload(Buffer.alloc(3)),/TRANSFER_QUOTA/);
  const result=hold({transfer_id:stream.metadata.transfer,size:8,sha256:sha(bytes)});controller.abort(new Error('cancel partial'));await assert.rejects(result,/cancel partial/);
  await settle();assert.equal((await f.upload(Buffer.alloc(10))).size,10);
});
test('I11 daily quota survives TTL purge and process reopen; startup and explicit sweeps remove expired inbox copies',async t=>{
  let clock=Date.now();const f=await fixture(t,{daily_upload_bytes:5,now:()=>clock});
  const receipt=await f.upload(Buffer.alloc(5));clock+=3000;await f.files.sweep();
  await assert.rejects(fs.stat(join(f.config.inbox,receipt.transfer_id)),{code:'ENOENT'});
  await f.close();const orphan=join(f.config.inbox,transferId());await fs.mkdir(orphan);await fs.writeFile(join(orphan,'partial'),Buffer.from('partial'));await fs.utimes(orphan,new Date(clock-3000),new Date(clock-3000));const reopened=await createDesktopFiles(f.config);t.after(()=>reopened.close());
  await assert.rejects(fs.stat(orphan),{code:'ENOENT'});
  const room=new Room() as any,peer=reopened.attach({room,principal:'owner',deviceType:'mac',capabilities:['desktop_tools'],identity:'mac-credential',current:()=>true,authorize:async()=>({})});
  const attempt=async()=>{const id=transferId(),bytes=Buffer.from('x'),hold=peer.expectUpload(id,new AbortController().signal);
    room.handleStreamHeader({streamId:id,topic:DESKTOP_FILE_TOPIC,mimeType:'application/octet-stream',totalLength:1n,timestamp:0n,attributes:{v:'1',dir:'up',transfer:id,name:'x',size:'1',sha256:sha(bytes),request:id},contentHeader:{case:'byteHeader',value:{name:'x'}}},'mac-credential');
    room.handleStreamChunk({streamId:id,content:bytes,chunkIndex:0n});room.handleStreamTrailer({streamId:id});return hold({transfer_id:id,size:1,sha256:sha(bytes)});};
  await assert.rejects(attempt(),/TRANSFER_QUOTA/);clock+=86400000;assert.equal((await attempt()).size,1);
});
test('I1 file handlers reject phone capability, foreign identity, unknown requests and stale attachments',async t=>{
  const f=await fixture(t),peer={room:f.room,principal:'owner',deviceType:'iphone',capabilities:['desktop_tools'],identity:'mac-credential',current:()=>true,authorize:async()=>({})};
  assert.throws(()=>f.files.attach(peer),/TERMINAL_CAPABILITY_DENIED/);
  const foreign=f.start('unknown',Buffer.from('secret'),{},'other-device');foreign.chunk();foreign.finish();await settle();
  assert.equal(f.errors.length,0);assert.deepEqual((await fs.readdir(f.config.inbox)).filter(name=>name.startsWith('dt-')),[]);
  f.start('unsolicited',Buffer.from('x'));await settle();assert.ok(f.errors.some(error=>/TRANSFER_INTEGRITY/.test(String(error))));
  f.setCurrent(false);f.start('stale',Buffer.from('x'));await settle();assert.deepEqual((await fs.readdir(f.config.inbox)).filter(name=>name.startsWith('dt-')),[]);
});
test('I10 anchored download denies links/FIFO/traversal/outside and reads without changing workshop files',{skip:process.platform!=='linux'},async t=>{
  const f=await fixture(t),out=join(f.config.workshop,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),bytes=Buffer.from('generated sheet');await fs.writeFile(join(out,'report.xlsx'),bytes);
  const download=await f.files.prepareDownload('/owner/out/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/report.xlsx'),chunks:Buffer[]=[];
  assert.equal(download.transfer.sha256,sha(bytes));assert.equal(download.attributes('req').request,'req');
  await download.send(async chunk=>{chunks.push(Buffer.from(chunk));},new AbortController().signal);assert.deepEqual(Buffer.concat(chunks),bytes);
  assert.deepEqual(await fs.readFile(join(out,'report.xlsx')),bytes);
  await fs.writeFile(join(out,'empty'),Buffer.alloc(0));const empty=await f.files.prepareDownload('/owner/out/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/empty');assert.equal(empty.transfer.size,0);await empty.close();
  await fs.symlink(join(out,'report.xlsx'),join(out,'link'));await fs.symlink(out,join(out,'linked-dir'));
  await fs.link(join(out,'report.xlsx'),join(out,'hardlink'));execFileSync('mkfifo',[join(out,'fifo')]);
  for(const path of ['/owner/out/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/link','/owner/out/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/linked-dir/empty','/owner/out/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/hardlink','/owner/out/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/fifo',
    '/owner/out/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/../report.xlsx','/owner/out/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/./empty','/workshop/else/report.xlsx','/owner/out/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa//empty'])await assert.rejects(f.files.prepareDownload(path),/WORKSHOP_PATH_INVALID/);
  await fs.writeFile(join(out,'large'),Buffer.alloc(101));await assert.rejects(f.files.prepareDownload('/owner/out/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/large'),/TRANSFER_TOO_LARGE/);
});
test('I10 download fails closed where Linux directory-fd traversal is unavailable',{skip:process.platform==='linux'},async t=>{
  const f=await fixture(t);await fs.writeFile(join(f.config.workshop,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','normal.txt'),'output');
  await assert.rejects(f.files.prepareDownload('/owner/out/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/normal.txt'),/WORKSHOP_PATH_INVALID/);
});
test('I10 anchored traversal rejects a parent replaced by a symlink between directory opens',{skip:process.platform!=='linux'},async t=>{
  const f=await fixture(t),parent=join(f.config.workshop,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','job'),outside=join(f.config.workshop,'private');
  await fs.mkdir(parent);await fs.mkdir(outside);await fs.writeFile(join(parent,'result.txt'),'output');await fs.writeFile(join(outside,'result.txt'),'outside marker');
  const original=fs.open;let replaced=false;
  fs.open=async(...args:Parameters<typeof fs.open>)=>{if(String(args[0]).startsWith('/proc/self/fd/')&&String(args[0]).endsWith('/job')){
    replaced=true;await fs.rename(parent,parent+'.held');await fs.symlink(outside,parent);}return original(...args);};
  try{await assert.rejects(f.files.prepareDownload('/owner/out/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/job/result.txt'),/WORKSHOP_PATH_INVALID/);assert.equal(replaced,true);}
  finally{fs.open=original;}
  assert.equal(await fs.readFile(join(outside,'result.txt'),'utf8'),'outside marker');
});
test('I10 normal nested output traverses a search-only output root',{skip:process.platform!=='linux'},async t=>{
  const f=await fixture(t),folder=join(f.config.workshop,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','job');await fs.mkdir(folder);await fs.writeFile(join(folder,'result.txt'),'nested output');
  await fs.chmod(f.config.workshop,0o111);
  try{const download=await f.files.prepareDownload('/owner/out/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/job/result.txt'),chunks:Buffer[]=[];
    await download.send(async chunk=>{chunks.push(Buffer.from(chunk));},new AbortController().signal);assert.equal(Buffer.concat(chunks).toString(),'nested output');}
  finally{await fs.chmod(f.config.workshop,0o700);}
});

test('I11 keep_workshop_copies changes inbox retention to 30 days',async t=>{
  let clock=Date.now();const f=await fixture(t,{keep_workshop_copies:true,now:()=>clock});
  const receipt=await f.upload(Buffer.from('copy')),path=join(f.config.inbox,receipt.transfer_id);
  clock+=3000;await f.files.sweep();assert.equal((await fs.stat(path)).isDirectory(),true);
  clock+=30*86400000;await f.files.sweep();await assert.rejects(fs.stat(path),{code:'ENOENT'});
});
test('I11 pinned Room preserves explicit zero length while refusing a missing byte declaration',async t=>{
  const f=await fixture(t),empty=Buffer.alloc(0),receipt=await f.upload(empty);assert.equal(receipt.size,0);
  assert.equal((await fs.stat(join(f.config.inbox,receipt.transfer_id,'sample.bin'))).size,0);
  const id=transferId(),hold=f.attached.expectUpload('undeclared',new AbortController().signal);
  f.room.handleStreamHeader({streamId:id,topic:DESKTOP_FILE_TOPIC,mimeType:'application/octet-stream',timestamp:0n,attributes:{v:'1',dir:'up',transfer:id,name:'empty',size:'0',sha256:sha(empty),request:'undeclared'},contentHeader:{case:'byteHeader',value:{name:'empty'}}},'mac-credential');
  await assert.rejects(hold({transfer_id:id,size:0,sha256:sha(empty)}),/TRANSFER_TOO_LARGE/);
});

test('I11 cancellation during authorizer execution releases the stream without creating an inbox copy',async t=>{
  const f=await fixture(t),controller=new AbortController(),hold=f.attached.expectUpload('authorization',controller.signal);
  f.peer.authorize=async()=>{controller.abort(new Error('cancel authorization'));return {};};
  const bytes=Buffer.from('file'),stream=f.start('authorization',bytes);
  await assert.rejects(hold({transfer_id:stream.metadata.transfer,size:bytes.length,sha256:sha(bytes)}),/cancel authorization/);
  await settle();assert.equal(f.room.byteStreamControllers.size,0);
  assert.deepEqual((await fs.readdir(f.config.inbox)).filter(name=>name.startsWith('dt-')),[]);
});
test('I11 abrupt process exit retains a partial upload reservation until day rollover',async t=>{
  const f=await fixture(t,{daily_upload_bytes:5});await f.close();
  const code=`
    import {Room} from '@livekit/rtc-node';
    import {promises as fs} from 'node:fs';
    import {setTimeout} from 'node:timers/promises';
    const {createDesktopFiles,DESKTOP_FILE_TOPIC}=await import(${JSON.stringify(new URL('../src/desktop-files.ts',import.meta.url).href)});
    const files=await createDesktopFiles({...${JSON.stringify({...f.config,onError:undefined})},onError:error=>{throw error;}}),room=new Room();
    const peer=files.attach({room,principal:'owner',deviceType:'mac',capabilities:['desktop_tools'],identity:'mac',current:()=>true,authorize:async()=>({})});
    peer.expectUpload('crash',new AbortController().signal);
    room.handleStreamHeader({streamId:'dt-0199aabb-ccdd-7000-8000-000000000999',topic:DESKTOP_FILE_TOPIC,mimeType:'application/octet-stream',totalLength:5n,timestamp:0n,attributes:{v:'1',dir:'up',transfer:'dt-0199aabb-ccdd-7000-8000-000000000999',name:'partial',size:'5',sha256:'0'.repeat(64),request:'crash'},contentHeader:{case:'byteHeader',value:{name:'partial'}}},'mac');
    room.handleStreamChunk({streamId:'dt-0199aabb-ccdd-7000-8000-000000000999',content:Buffer.from('xx'),chunkIndex:0n});
    const path=${JSON.stringify(join(f.config.inbox,'dt-0199aabb-ccdd-7000-8000-000000000999','partial'))};
    for(let i=0;i<100;i++){try{if((await fs.stat(path)).size===2)process.exit(0);}catch(error){if(error.code!=='ENOENT')throw error;}await setTimeout(5);}
    throw new Error('partial upload did not reach disk');`;
  execFileSync(process.execPath,['--input-type=module','-e',code],{timeout:5000});
  const reopened=await createDesktopFiles(f.config);t.after(()=>reopened.close());const room=new Room() as any;
  const peer=reopened.attach({room,principal:'owner',deviceType:'mac',capabilities:['desktop_tools'],identity:'mac',current:()=>true,authorize:async()=>({})});
  const id=transferId(),hold=peer.expectUpload('retry',new AbortController().signal),bytes=Buffer.from('x');
  room.handleStreamHeader({streamId:id,topic:DESKTOP_FILE_TOPIC,mimeType:'application/octet-stream',totalLength:1n,timestamp:0n,attributes:{v:'1',dir:'up',transfer:id,name:'retry',size:'1',sha256:sha(bytes),request:'retry'},contentHeader:{case:'byteHeader',value:{name:'retry'}}},'mac');
  await assert.rejects(hold({transfer_id:id,size:1,sha256:sha(bytes)}),/TRANSFER_QUOTA/);
});

test('I10 unreadable workshop output returns WORKSHOP_FILE_UNREADABLE 422 with real file permissions',{skip:process.platform!=='linux'},async t=>{
  if(process.getuid?.()===0){t.skip('root bypasses file permission checks');return;}
  const f=await fixture(t),path=join(f.config.workshop,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','unreadable.txt');
  await fs.writeFile(path,'private output',{mode:0o644});await fs.chmod(path,0o000);
  try{await assert.rejects(f.files.prepareDownload('/owner/out/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/unreadable.txt'),{code:'WORKSHOP_FILE_UNREADABLE',status:422});}
  finally{await fs.chmod(path,0o644);}
  const readable=await f.files.prepareDownload('/owner/out/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/unreadable.txt');await readable.close();
});
