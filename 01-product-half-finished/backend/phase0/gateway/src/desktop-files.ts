import {constants, promises as fs} from 'node:fs';
import {join, resolve} from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {check, ContractError} from '../../../services/personal-aios-integration/src/contracts.ts';
import {openOwnerDatabase, inTransaction} from '../../../services/personal-aios-integration/src/owner-db.ts';
import {consumeBoundedByteStream, type BoundedByteStreamOptions} from './sdk-room.ts';
export const DESKTOP_FILE_TOPIC='paios.desktop.file.v1';
type Reader=BoundedByteStreamOptions<unknown>['reader'];
export interface DesktopFilePeer {
  principal:string; deviceType:string; capabilities:readonly string[]; identity:string; current:()=>boolean; authorize:()=>Promise<unknown>;
  room:{registerByteStreamHandler(topic:string,handler:(reader:Reader,sender:{identity:string})=>void):void;unregisterByteStreamHandler(topic:string):void};
}
export interface DesktopFileConfig {
  inbox:string; workshop:string; enabled:boolean; upload_enabled:boolean; max_file_bytes:number; daily_upload_bytes:number;
  inbox_total_bytes:number; inbox_ttl_s:number; save_max_file_bytes:number; keep_workshop_copies:boolean; onError:(error:unknown)=>void; now?:()=>number;
}
export interface DesktopTransfer {transfer_id:string;size:number;sha256:string}
export interface DesktopUpload extends DesktopTransfer {workshop_path:string}
const transferPattern=/^dt-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const pathError=(error:unknown)=>{
  if(error instanceof ContractError)return error;
  const code=(error as NodeJS.ErrnoException)?.code;
  return typeof code==='string'&&/^E[A-Z0-9]+$/.test(code)?new ContractError(['ENOENT','ENOTDIR','ELOOP'].includes(code)?'WORKSHOP_PATH_INVALID':'WORKSHOP_UNAVAILABLE',400):error;
};
export async function createDesktopFiles(config:DesktopFileConfig) {
  const now=config.now??Date.now,inbox=resolve(config.inbox),workshop=resolve(config.workshop),active=new Set<string>(),closers=new Set<()=>void>(),jobs=new Set<Promise<void>>();
  await fs.mkdir(inbox,{recursive:true,mode:0o755});
  check((await fs.lstat(inbox)).isDirectory(),'WORKSHOP_PATH_INVALID');await fs.chmod(inbox,0o755);
  // Daily reservations outlive inbox TTL; a process crash leaves its reservation charged until UTC day rollover.
  const db=openOwnerDatabase(join(inbox,'.state'),'quota.sqlite','CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS days(day TEXT,principal TEXT,bytes INTEGER NOT NULL,PRIMARY KEY(day,principal));','paios.desktop-quota.v1','DESKTOP_QUOTA');
  let inboxBytes=0;
  const directoryBytes=async(path:string)=>{let bytes=0;
    for(const item of await fs.readdir(path,{withFileTypes:true})){check(item.isFile(),'TRANSFER_INTEGRITY');bytes+=(await fs.lstat(join(path,item.name))).size;}
    return bytes;};
  const sweep=async()=>{for(const item of await fs.readdir(inbox,{withFileTypes:true})){
    if(!transferPattern.test(item.name)||active.has(item.name))continue;
    const path=join(inbox,item.name),stat=await fs.lstat(path);
    check(stat.isDirectory()&&!stat.isSymbolicLink(),'TRANSFER_INTEGRITY');
    if(now()-stat.mtimeMs>=(config.keep_workshop_copies?2592000000:config.inbox_ttl_s*1000)){const bytes=await directoryBytes(path);await fs.rm(path,{recursive:true});inboxBytes-=bytes;
    }
  }};
  for(const item of await fs.readdir(inbox,{withFileTypes:true}))if(transferPattern.test(item.name)){check(item.isDirectory(),'TRANSFER_INTEGRITY');inboxBytes+=await directoryBytes(join(inbox,item.name));}
  await sweep();
  const timer=setInterval(()=>{void sweep().catch(config.onError);},300000).unref();
  const attach=(peer:DesktopFilePeer)=>{
    check(peer.deviceType==='mac'&&peer.capabilities.includes('desktop_tools'),'TERMINAL_CAPABILITY_DENIED',403);
    let attached=true;
    type Pending={done:ReturnType<typeof Promise.withResolvers<DesktopUpload>>;cancel?:(reason:unknown)=>void;claimed:boolean;abort:()=>void;signal:AbortSignal};
    const pending=new Map<string,Pending>(),current=()=>attached&&peer.current();
    const expectUpload=(request:string,signal:AbortSignal)=>{
      check(!pending.has(request)&&current(),'DESKTOP_CANCELLED',409);signal.throwIfAborted();
      // The upload may fail before the relay receives its tool result; retain that rejection for the holdback.
      const done=Promise.withResolvers<DesktopUpload>();void done.promise.catch(()=>{});
      const abort=()=>{const entry=pending.get(request);pending.delete(request);signal.removeEventListener('abort',abort);
        if(entry?.cancel)entry.cancel(signal.reason);else done.reject(signal.reason);};
      const entry:Pending={done,claimed:false,abort,signal};
      pending.set(request,entry);signal.addEventListener('abort',abort,{once:true});
      return async(result:DesktopTransfer)=>{try{const receipt=await done.promise;
        check(current()&&!signal.aborted,'DESKTOP_CANCELLED',409);
        check(receipt.transfer_id===result.transfer_id&&receipt.size===result.size&&receipt.sha256===result.sha256,'TRANSFER_INTEGRITY');
        return receipt;}
        finally{signal.removeEventListener('abort',abort);pending.delete(request);}};
    };
    peer.room.registerByteStreamHandler(DESKTOP_FILE_TOPIC,(reader,sender)=>{
      const a=reader.info.attributes??{},entry=pending.get(a.request??'');
      let handle:Awaited<ReturnType<typeof fs.open>>|undefined,created=false,reserved=false,stopped=false,day='',path='',size=0,declared=-1,preparing:Promise<void>|undefined,writing:Promise<void>|undefined;
      const hash=createHash('sha256'),valid=current()&&sender.identity===peer.identity;let cancelStream:((reason?:unknown)=>void)|undefined;
      const bounded=consumeBoundedByteStream({room:peer.room,reader,maxBytes:config.max_file_bytes,current:()=>valid&&current(),
        error:kind=>new ContractError(kind==='size'?'TRANSFER_TOO_LARGE':kind==='incomplete'?'TRANSFER_INTEGRITY':kind==='cancelled'?'DESKTOP_CANCELLED':'DESKTOP_TIMEOUT',409),
        authorize:()=>preparing=(async()=>{
          declared=reader.info.totalSize??-1;
          check(config.enabled&&config.upload_enabled,'TRANSFER_DISABLED',403);
          check(entry&&!entry.claimed&&!entry.signal.aborted,'TRANSFER_INTEGRITY');
          entry.claimed=true;entry.cancel=boundedCancel;
          check(reader.info.mimeType==='application/octet-stream'&&a.v==='1'&&a.dir==='up'&&transferPattern.test(a.transfer??'')&&a.name&&!a.name.startsWith('.')&&!/[\/\0]/.test(a.name)&&Buffer.byteLength(a.name)<=255&&a.size===String(declared)&&/^[0-9a-f]{64}$/.test(a.sha256??''),'TRANSFER_INTEGRITY');
          await peer.authorize();
          check(!stopped&&current()&&!entry.signal.aborted,'DESKTOP_CANCELLED',409);
          check(!active.has(a.transfer!),'TRANSFER_INTEGRITY');
          check(inboxBytes+declared<=config.inbox_total_bytes,'TRANSFER_QUOTA',429);
          day=new Date(now()).toISOString().slice(0,10);
          inTransaction(db,()=>{
            db.prepare('INSERT OR IGNORE INTO days VALUES(?,?,0)').run(day,peer.principal);
            const changed=db.prepare('UPDATE days SET bytes=bytes+? WHERE day=? AND principal=? AND bytes+?<=?').run(declared,day,peer.principal,declared,config.daily_upload_bytes);
            check(changed.changes===1,'TRANSFER_QUOTA',429);});
          inboxBytes+=declared;reserved=true;active.add(a.transfer!);path=join(inbox,a.transfer!);
          await fs.mkdir(path,{mode:0o755}).catch(error=>{if(error.code==='EEXIST')throw new ContractError('TRANSFER_INTEGRITY',409);throw error;});created=true;
          await fs.chmod(path,0o755);
          handle=await fs.open(join(path,a.name!),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o644);await handle.chmod(0o644);
        })(),write:chunk=>writing=(async()=>{hash.update(chunk);await handle!.writeFile(chunk);size+=chunk.byteLength;})()});
      cancelStream=bounded.cancel;if(stopped)cancelStream(entry?.signal.reason);
      function boundedCancel(reason:unknown){stopped=true;cancelStream?.(reason);}
      const receive=async()=>{let completed=false,receipt:DesktopUpload|undefined;try{
        await bounded.done;
        entry?.signal.throwIfAborted();
        check(current()&&entry&&!entry.signal.aborted,'DESKTOP_CANCELLED',409);
        check(size===declared&&hash.digest('hex')===a.sha256,'TRANSFER_INTEGRITY');
        await handle!.sync();entry.signal.throwIfAborted();check(!stopped&&current(),'DESKTOP_CANCELLED',409);completed=true;
        receipt={transfer_id:a.transfer!,size,sha256:a.sha256!,workshop_path:`/owner/in/${a.transfer}/${a.name}`};
      }catch(error){if(valid||!(error instanceof ContractError&&error.code==='DESKTOP_CANCELLED'))throw error;}
      finally{stopped=true;
        if(reserved)await preparing?.catch(config.onError);
        await writing?.catch(config.onError);await handle?.close();
        if(!completed&&created)await fs.rm(path,{recursive:true});
        if(reserved&&!completed){inboxBytes-=declared;db.prepare('UPDATE days SET bytes=bytes-? WHERE day=? AND principal=?').run(declared,day,peer.principal);}
        if(reserved)active.delete(a.transfer??'');}
        if(completed)entry!.done.resolve(receipt!);};
      const job=receive().catch(error=>{if(valid)entry?.done.reject(error);config.onError(error);});jobs.add(job);void job.finally(()=>jobs.delete(job));
    });
    const close=()=>{if(!attached)return;attached=false;
      peer.room.unregisterByteStreamHandler(DESKTOP_FILE_TOPIC);
      for(const item of pending.values()){const error=new ContractError('DESKTOP_CANCELLED',409);if(item.cancel)item.cancel(error);else item.done.reject(error);item.signal.removeEventListener('abort',item.abort);}
      pending.clear();closers.delete(close);};
    closers.add(close);return {expectUpload,close};
  };
  const prepareDownload=async(workshopPath:string)=>{
    check(config.enabled,'TRANSFER_DISABLED',403);
    const prefix='/owner/out/';
    check(workshopPath.startsWith(prefix)&&Buffer.byteLength(workshopPath)<=512&&!workshopPath.includes('\0'),'WORKSHOP_PATH_INVALID');
    const parts=workshopPath.slice(prefix.length).split('/');
    check(parts.length>1&&/^[0-9a-f]{32}$/.test(parts[0]!)&&parts.every(part=>part!==''&&part!=='.'&&part!=='..'),'WORKSHOP_PATH_INVALID');
    check(process.platform==='linux','WORKSHOP_PATH_INVALID');
    // Linux O_PATH opens the traverse-only output root (0711); Node omits this flag.
    const directory=0x200000|constants.O_DIRECTORY|constants.O_NOFOLLOW;let handle:Awaited<ReturnType<typeof fs.open>>|undefined;
    try{handle=await fs.open(workshop,directory);
      for(const [index,part] of parts.entries()){const parent=handle!;handle=undefined;
        try{handle=await fs.open(`/proc/self/fd/${parent.fd}/${part}`,constants.O_NOFOLLOW|(index===parts.length-1?constants.O_RDONLY|constants.O_NONBLOCK:directory));}
        finally{await parent.close();}}
    }catch(error){await handle?.close();throw ['EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code??'')?new ContractError('WORKSHOP_FILE_UNREADABLE',422):pathError(error);}
    const file=handle!;try{const stat=await file.stat();
      check(stat.isFile()&&stat.nlink===1,'WORKSHOP_PATH_INVALID');
      check(stat.size<=config.save_max_file_bytes,'TRANSFER_TOO_LARGE',413);
      const chunks=async function*(){const buffer=Buffer.alloc(65536);let position=0;
        while(position<stat.size){const read=await file.read(buffer,0,Math.min(buffer.length,stat.size-position),position);check(read.bytesRead>0,'TRANSFER_INTEGRITY');position+=read.bytesRead;yield buffer.subarray(0,read.bytesRead);}};
      const hash=createHash('sha256');for await(const chunk of chunks())hash.update(chunk);
      const b=randomBytes(16);b.writeUIntBE(now(),0,6);b[6]=(b[6]!&15)|112;b[8]=(b[8]!&63)|128;
      const h=b.toString('hex'),transfer_id=`dt-${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
      const transfer:DesktopTransfer={transfer_id,size:stat.size,sha256:hash.digest('hex')};
      return {transfer,name:parts.at(-1)!,
        attributes:(request:string)=>({v:'1',dir:'down',transfer:transfer.transfer_id,name:parts.at(-1)!,size:String(transfer.size),sha256:transfer.sha256,request}),
        send:async(write:(chunk:Uint8Array)=>Promise<void>,signal:AbortSignal)=>{try{for await(const chunk of chunks()){signal.throwIfAborted();await write(chunk);signal.throwIfAborted();}}finally{await file.close();}},close:()=>file.close()};
    }catch(error){await file.close();throw error;}
  };
  return {attach,prepareDownload,sweep,close:async()=>{clearInterval(timer);for(const close of [...closers])close();await Promise.all([...jobs]);db.close();}};
}
