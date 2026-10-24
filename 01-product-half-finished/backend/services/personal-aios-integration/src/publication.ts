/** The latest state of one terminal feature: one running attempt and one dirty bit. Room liveness belongs to the LiveKit SDK's
 *  room events alone (they detach the connection, which stops this pump); a slow or failed attempt is never evidence that a
 *  room is gone. An RTC send cannot be cancelled, so attempts never overlap: a slow attempt is awaited, and the newest state
 *  follows once it settles. Every attempt is bounded by the connection that owns it, and stop cancels the wait at once.
 *  A failed attempt is reported and the newest state is retried after a bounded backoff (`retryMs` at most). `ready` (the
 *  recipient is present) is awaited before each attempt, bounded by the connection that owns it. */
export function coalescedPublication(send:(signal:AbortSignal)=>Promise<void>,onError:(error:unknown)=>void,retryMs=5000,
  ready?:(signal:AbortSignal)=>Promise<void>) {
  const abort=new AbortController(),signal=abort.signal;let dirty=false,work:Promise<void>|undefined;
  const until=(attempt:Promise<void>)=>new Promise<void>((resolve,reject)=>{
    const stop=()=>reject(signal.reason);if(signal.aborted){stop();return;}signal.addEventListener('abort',stop,{once:true});
    attempt.then(resolve,reject).finally(()=>signal.removeEventListener('abort',stop));
  });
  const push=()=>{
    if(signal.aborted)return;dirty=true;if(work)return;
    work=(async()=>{for(let failures=0;dirty&&!signal.aborted;){
      try {if(ready)await ready(signal);dirty=false;await until(send(signal));failures=0;}
      catch(error){if(signal.aborted)return;onError(error);dirty=true;
        await until(new Promise<void>(resolve=>{setTimeout(resolve,Math.min(retryMs,250*2**failures++)).unref?.();})).catch(()=>{});}
    }})().finally(()=>{work=undefined;if(dirty&&!signal.aborted)push();});
  };
  return {signal,push,stop:()=>{dirty=false;abort.abort(Error('TERMINAL_PUBLICATION_STOPPED'));}};
}
