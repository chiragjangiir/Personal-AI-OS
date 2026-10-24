import {ContractError} from '../../../services/personal-aios-integration/src/contracts.ts';

export const REALTIME_READINESS_DEADLINE_MS=4000;
/** Abandon an unresponsive external operation; its late completion cannot commit local state. */
export async function settleWithSignal<T>(work:()=>Promise<T>,signal:AbortSignal):Promise<T> {
  signal.throwIfAborted();
  let stop:()=>void=()=>{};
  const cancelled=new Promise<never>((_,reject)=>{stop=()=>reject(signal.reason);signal.addEventListener('abort',stop,{once:true});});
  try {const value=await Promise.race([work(),cancelled]);signal.throwIfAborted();return value;}
  finally {signal.removeEventListener('abort',stop);}
}
/** Refresh supplies this same budget to readiness; an independent handshake owns one fresh budget. */
export async function withinRealtimeReadiness<T>(work:(signal:AbortSignal)=>Promise<T>,parent?:AbortSignal):Promise<T> {
  if(parent)return settleWithSignal(()=>work(parent),parent);
  const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new ContractError('REALTIME_READINESS_DEADLINE',503)),REALTIME_READINESS_DEADLINE_MS);
  try {return await settleWithSignal(()=>work(deadline.signal),deadline.signal);}
  finally {clearTimeout(timer);}
}
