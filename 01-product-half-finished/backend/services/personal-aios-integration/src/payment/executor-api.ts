import {createHash,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {ContractError,check} from '../contracts.ts';
import {readBody} from '../http-body.ts';
import type {PaymentAuthority} from './authority.ts';
import type {Checkpoint} from './contracts.ts';

/** A9.1: distinct executor credential; fixed-size digests avoid a length-dependent token comparison. */
export function executorAuthenticated(header:unknown,key:string|undefined):boolean {
  if(!key||typeof header!=='string'||!header.startsWith('Bearer '))return false;
  const hash=(s:string)=>createHash('sha256').update(s).digest();
  return timingSafeEqual(hash(header.slice(7)),hash(key));
}
function send(response:ServerResponse,status:number,body:unknown):void {
  response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});response.end(JSON.stringify(body));
}
async function body(request:IncomingMessage,max_bytes:number):Promise<Record<string,unknown>> {
  const bytes=await readBody(request,max_bytes);
  let value:unknown;
  try{value=JSON.parse(bytes.toString('utf8'));}catch{throw new ContractError('PAYMENT_AMOUNT_INVALID',400);}
  check(value&&typeof value==='object'&&!Array.isArray(value),'PAYMENT_AMOUNT_INVALID',400);return value as Record<string,unknown>;
}
/** HTTP framing only. All transitions, validation, replay and timers belong to PaymentAuthority. */
export async function handlePaymentExecutor(request:IncomingMessage,response:ServerResponse,authority:PaymentAuthority,key:string|undefined,max_request_bytes:number):Promise<boolean> {
  const url=new URL(request.url??'/','http://localhost'),prefix='/internal/payment/executor';
  if(!url.pathname.startsWith(prefix+'/'))return false;
  try{
    check(executorAuthenticated(request.headers.authorization,key),'PAYMENT_EXECUTOR_AUTH_REQUIRED',401);
    const path=url.pathname.slice(prefix.length);
    if(path==='/checkpoints'&&request.method==='POST'){send(response,200,await authority.checkpoint(await body(request,max_request_bytes) as unknown as Checkpoint));return true;}
    const match=/^\/payments\/(pay-[0-9a-f-]{36})(?:\/(amount-changed|tap|result|abort|order-cancel))?$/.exec(path);
    check(match,'PAYMENT_NOT_FOUND',404);const payment=match[1]!;
    if(!match[2]&&request.method==='GET'){
      const wait=Number(url.searchParams.get('wait_ms')??0),version=Number(url.searchParams.get('after_version')??0);
      check(Number.isSafeInteger(wait)&&wait>=0&&wait<=25000&&Number.isSafeInteger(version)&&version>=0,'PAYMENT_AMOUNT_INVALID',400);
      send(response,200,await authority.poll(payment,wait,version));return true;
    }
    check(request.method==='POST'&&match[2],'PAYMENT_NOT_FOUND',404);const input=await body(request,max_request_bytes);
    const operation=match[2];
    const result=operation==='amount-changed'?await authority.amountChanged(payment,input):operation==='tap'?await authority.tap(payment,input):
      operation==='result'?await authority.result(payment,input):operation==='abort'?await authority.abort(payment,input):await authority.orderCancel(payment,input);
    send(response,200,result);
  }catch(error){send(response,error instanceof ContractError?error.status:500,{error_code:error instanceof ContractError?error.code:'PAYMENT_EXECUTOR_INTERNAL_ERROR'});}
  return true;
}
