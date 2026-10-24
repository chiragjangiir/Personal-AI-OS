import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {closeSync,fsyncSync,mkdirSync,openSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {check,ContractError} from '../../../services/personal-aios-integration/src/contracts.ts';
import type {ViduSocket} from './vidu-call-session.ts';

/** Promise deadline also covers injected transports that ignore AbortSignal. */
export async function boundedViduOperation<T>(operation:Promise<T>,ms:number,code:string):Promise<T>{
  let timer:NodeJS.Timeout|undefined;
  try{return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new ContractError(code,502)),ms);})]);}
  finally{clearTimeout(timer);}
}
const WebSocket=createRequire(new URL('../../../services/qwen-embedded/server/src/voice/node-websocket.mjs',import.meta.url))('ws');
type Live={baseUrl:string;id:string};
type Cleanup={apiKey:string;fetch?:typeof fetch;connect?:(url:string,headers:{Authorization:string})=>ViduSocket};
type Retirement=Live&Cleanup&{socket?:ViduSocket;connId?:string;sendControl?:(type:number,payload:object)=>void};
export type ViduLiveJournal={remember(baseUrl:string,id:string):void;forget(id:string):void;
  readonly size:number;retire(options:Retirement):ReturnType<typeof retireViduLive>;stop():Promise<void>;
  reconcile(options:Cleanup):Promise<void>};
/** Contains provider IDs only, never RTC tokens or API credentials. One process owns this file. */
export function createViduLiveJournal(path:string):ViduLiveJournal{
  let entries:Live[]=[];
  try{entries=JSON.parse(readFileSync(path,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  check(Array.isArray(entries)&&entries.every(row=>typeof row.id==='string'&&typeof row.baseUrl==='string'),'VIDU_JOURNAL_INVALID',500);
  const save=()=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(`${path}.tmp`,JSON.stringify(entries),{mode:0o600,flush:true});renameSync(`${path}.tmp`,path);
    const directory=openSync(dirname(path),'r');try{fsyncSync(directory);}finally{closeSync(directory);}};
  let credentials:Cleanup|undefined,timer:NodeJS.Timeout|undefined,stopped=false;
  const flights=new Map<string,ReturnType<typeof retireViduLive>>(),retry=new Set<string>();
  const schedule=()=>{if(stopped||timer||!credentials||!retry.size)return;
    timer=setTimeout(()=>{timer=undefined;void Promise.allSettled(entries.filter(row=>retry.has(row.id)).map(row=>journal.retire({...credentials!,...row})))
      .then(results=>{if(results.some(result=>result.status==='rejected'))process.stderr.write('VIDU_RETAINED_CLEANUP_FAILED\n');schedule();});},30000);timer.unref();};
  const journal:ViduLiveJournal={remember:(baseUrl,id)=>{entries=entries.filter(row=>row.id!==id);entries.push({baseUrl,id});save();},
    forget:id=>{entries=entries.filter(row=>row.id!==id);retry.delete(id);save();},get size(){return entries.length;},
    retire:options=>{credentials??={apiKey:options.apiKey,...(options.fetch?{fetch:options.fetch}:{}),...(options.connect?{connect:options.connect}:{})};const active=flights.get(options.id);if(active)return active;
      const flight=retireViduLive({...options,journal}).catch(error=>{if(entries.some(row=>row.id===options.id))retry.add(options.id);throw error;})
        .finally(()=>{flights.delete(options.id);schedule();});flights.set(options.id,flight);return flight;},
    stop:async()=>{stopped=true;clearTimeout(timer);await Promise.allSettled(flights.values());},reconcile:async options=>{
      credentials=options;
      const results=await Promise.allSettled(entries.slice().map(row=>journal.retire({...options,...row})));
      const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
      if(errors.length)throw new AggregateError(errors,'VIDU_RESTART_CLEANUP_FAILED');}};
  return journal;
}
/** Socket controls are independent; only verified terminal billing removes durable ownership. */
export async function retireViduLive(options:Live&{apiKey:string;fetch?:typeof fetch;socket?:ViduSocket;connId?:string;sendControl?:(type:number,payload:object)=>void;journal?:ViduLiveJournal;
  connect?:(url:string,headers:{Authorization:string})=>ViduSocket}):Promise<{status:string;billed_seconds:number;credits_cost:number}>{
  const http=options.fetch??fetch,headers={Authorization:`Token ${options.apiKey}`},errors:unknown[]=[],conn_id=options.connId??randomUUID();
  let socket=options.socket,seq=0;
  const send=(type:number,payload:object)=>{try{if(options.sendControl)options.sendControl(type,payload);else socket!.send(JSON.stringify({type,live_id:options.id,conn_id,seq_id:++seq,payload}));}catch(error){errors.push(error);}};
  try{
    if(!socket){const url=new URL(options.baseUrl);url.protocol='wss:';url.pathname=`/live/v1/external-lives/${encodeURIComponent(options.id)}/stream`;url.searchParams.set('conn_id',conn_id);socket=options.connect?options.connect(url.href,headers):new WebSocket(url.href,{headers});}
    if(socket!.readyState!==3)await new Promise<void>(resolve=>{
      const done=()=>{clearTimeout(force);resolve();};
      const terminate=()=>{try{socket!.terminate();}catch(error){errors.push(error);}finally{done();}},force=setTimeout(terminate,500);
      const hangup=()=>{send(7,{});send(5,{hangup:{hangup_reason:'client_hangup'}});try{socket!.close();}catch(error){errors.push(error);terminate();}};
      try{socket!.on('close',done);socket!.on('error',()=>{});
        if(socket!.readyState===1)hangup();else socket!.on('open',()=>{send(1,{conn_init:{version:1}});hangup();});
      }catch(error){errors.push(error);terminate();}
    });
  }catch(error){errors.push(error);try{socket?.terminate();}catch(error){errors.push(error);}}
  let terminal:{status:string;billed_seconds:number;credits_cost:number}|undefined;
  for(let attempt=0;attempt<21;attempt++){
    try{const live=await boundedViduOperation((async()=>{
        const response=await http(`${options.baseUrl}/live/v1/lives/${encodeURIComponent(options.id)}`,{headers,signal:AbortSignal.timeout(2000)});
        check(response.ok,'VIDU_BILLING_FAILED',502);return (await response.json() as {live?:{status:string;billed_seconds:number;credits_cost:number}}).live;
      })(),2000,'VIDU_BILLING_TIMEOUT');
      if(live?.status==='ended'&&Number.isFinite(live.billed_seconds)&&Number.isFinite(live.credits_cost)){
        terminal={status:live.status,billed_seconds:live.billed_seconds,credits_cost:live.credits_cost};options.journal?.forget(options.id);break;}
    }catch(error){if(attempt===20)errors.push(error);}
    if(attempt<20)await new Promise(resolve=>setTimeout(resolve,1000));
  }
  if(!terminal)errors.push(new ContractError('VIDU_BILLING_TERMINAL_UNVERIFIED',502));
  if(errors.length)throw new AggregateError(errors,'VIDU_COMPONENT_CLEANUP_FAILED');return terminal!;
}
