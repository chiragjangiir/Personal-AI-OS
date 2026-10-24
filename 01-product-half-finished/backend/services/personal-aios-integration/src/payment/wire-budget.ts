import {readFileSync} from 'node:fs';
import {check} from '../contracts.ts';

const read=(name:string)=>JSON.parse(readFileSync(new URL(`../../../../../../integrations/contracts/${name}.v1.json`,import.meta.url),'utf8'));
const base=read('formal-message'),payment=read('payment-message');
export const PAYMENT_OUTPUT_LIMIT:number=base.output_limit;
export const PAYMENT_LIVE_LIMIT:number=payment.outputs.payment_cards.properties.cards.maxItems;
export const PAYMENT_MAX_RELOCK_CHOICES:number=payment.outputs.payment_settings.properties.locks.properties.phone.properties.relock_choices_s.maxItems;
export const PAYMENT_MAX_ENROLMENT_CHARS:number=payment.outputs.payment_lock_state.properties.enrolment.properties.sentences.items.maxLength;
// Non-transport callers reserve the longest legal identifier; the formal caller supplies its actual session.
export const PAYMENT_ENVELOPE_ID='s'.repeat(1+Number(payment.$defs.cid.pattern.match(/\{0,(\d+)\}/)[1]));
export interface PaymentFrame {session_id?:string|undefined;request_id?:string|undefined}
export const recordMetadataCaps:Record<string,number>=Object.fromEntries(Object.entries(payment.$defs.record_data.properties)
  .filter(([key,value])=>key!=='payee'&&typeof (value as {maxLength?:number}).maxLength==='number')
  .map(([key,value])=>[key,(value as {maxLength:number}).maxLength]));

/** Same UTF-8 JSON and envelope as formal text publication. No business values are shortened here. */
export function paymentMessageBytes(body:Record<string,unknown>,session_id=PAYMENT_ENVELOPE_ID):number {
  return Buffer.byteLength(JSON.stringify({...body,session_id,schema_version:base.schema}));
}
/** Complete entries in source order, bounded by the existing terminal transport limit. */
export function packPaymentItems<T>(items:T[],project:(items:T[])=>Record<string,unknown>,session_id?:string):T[]{
  const result:T[]=[];
  for(const item of items){
    const next=[...result,item];
    if(paymentMessageBytes(project(next),session_id)>PAYMENT_OUTPUT_LIMIT){
      check(result.length>0,'PAYMENT_OUTPUT_PACKET_TOO_LARGE',413);break;
    }
    result.push(item);
  }
  return result;
}
