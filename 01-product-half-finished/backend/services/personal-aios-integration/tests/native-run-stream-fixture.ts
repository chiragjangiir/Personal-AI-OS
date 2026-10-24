import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {NATIVE_STREAM_RECONNECT_MIN_MS} from '../src/admission.ts';
import type {NativeRun} from '../src/hermes-client.ts';

// Model native SSE snapshots and updates without depending on the EOF reconciliation timer.
export function nativeRunStreamFixture(read:(runId:string)=>NativeRun) {
  const streams=new Map<string,(event:'run.snapshot'|'run.updated')=>void>();
  return {
    response(url:URL,signal?:AbortSignal|null) {
      const runId=decodeURIComponent(url.pathname.split('/')[3]!);
      let seq=Number(url.searchParams.get('after_seq')??0),close:()=>void;
      const body=new ReadableStream<Uint8Array>({start(controller){
        const send=(event:'run.snapshot'|'run.updated')=>controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({event,run_id:runId,timestamp:Date.now()/1000,seq:++seq,run:read(runId),activity_events:[]})}\n\n`));
        const cleanup=()=>{streams.delete(runId);signal?.removeEventListener('abort',close);};
        close=()=>{cleanup();controller.close();};
        streams.set(runId,send);
        signal?.addEventListener('abort',close,{once:true});
        send('run.snapshot');
      },cancel(){streams.delete(runId);signal?.removeEventListener('abort',close);}});
      return new Response(body,{headers:{'content-type':'text/event-stream'}});
    },
    update(runId:string) {streams.get(runId)?.('run.updated');},
  };
}

// Bound one reconnect wait and one existing native HTTP request while observing the business condition.
export async function waitForNativeCondition(predicate:()=>boolean|Promise<boolean>,requestTimeoutMs:number):Promise<void> {
  const deadline=performance.now()+NATIVE_STREAM_RECONNECT_MIN_MS+requestTimeoutMs;
  while(true){
    if(await predicate())return;
    if(performance.now()>=deadline)throw new Error('NATIVE_CONDITION_TIMEOUT');
    await delay(5);
  }
}
