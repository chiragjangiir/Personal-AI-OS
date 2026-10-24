import type {AnySchema} from 'ajv';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {check} from '../../../services/personal-aios-integration/src/contracts.ts';
import type {RegisteredDevice} from '../../../services/personal-aios-integration/src/source-authority.ts';
import type {PaymentInputBinding} from '../../../services/personal-aios-integration/src/payment/authority.ts';

interface PaymentWireContract {
  version:number; schema:string; $defs:Record<string,AnySchema>;
  inputs:Record<string,{definition:AnySchema;error:string}>;
  outputs:Record<string,{properties:Record<string,AnySchema>} & AnySchema>;
  examples:Record<string,Record<string,unknown>[]>;
}
const registry=JSON.parse(readFileSync(new URL('../../../../../integrations/contracts/formal-message.v1.json',import.meta.url),'utf8')).extensions as {contract:string;version:number;sha256:string}[];
const registration=registry.find(entry=>entry.contract==='payment-message.v1.json');
check(registration?.version===1,'PAYMENT_WIRE_REGISTRATION_REQUIRED');
export const PAYMENT_WIRE_SHA256=registration.sha256;
const bytes=readFileSync(new URL('../../../../../integrations/contracts/payment-message.v1.json',import.meta.url));
check(createHash('sha256').update(bytes).digest('hex')===PAYMENT_WIRE_SHA256,'PAYMENT_WIRE_CONTRACT_CHANGED');
export const paymentWire=JSON.parse(bytes.toString('utf8')) as PaymentWireContract;
check(paymentWire.version===1&&paymentWire.schema==='paios.payment.wire.v1','PAYMENT_WIRE_CONTRACT_CHANGED');

/** Payment extends the existing topics and envelope; no second transport or validator authority. */
export function mergePaymentWire(wire:Pick<PaymentWireContract,'$defs'|'inputs'|'outputs'>):void {
  for(const key of Object.keys(paymentWire.$defs))check(!Object.hasOwn(wire.$defs,key),'PAYMENT_WIRE_DEFINITION_CONFLICT');
  Object.assign(wire.$defs,paymentWire.$defs);
  Object.assign(wire.inputs,paymentWire.inputs);
  Object.assign(wire.outputs,paymentWire.outputs);
}
export const isPaymentInput=(operation:unknown):boolean=>typeof operation==='string'&&Object.hasOwn(paymentWire.inputs,operation);
export interface PaymentWireRuntime {
  paymentInput(device:RegisteredDevice,body:Record<string,unknown>,session_id?:string,origin?:PaymentInputBinding):Promise<Record<string,unknown>|undefined>;
}
/** Only framing and device-origin conversion. Payment decisions stay in the runtime authority. */
export async function dispatchPayment(runtime:PaymentWireRuntime,device:RegisteredDevice,body:Record<string,unknown>,session_id?:string,origin?:PaymentInputBinding):Promise<Record<string,unknown>|undefined> {
  const glasses=['glasses_unlock_request','glasses_lock','voiceprint_enrol_request'].includes(String(body.operation));
  check(device.device_type===(glasses?'glasses':'phone'),'PAYMENT_TERMINAL_NOT_ALLOWED',403);
  const result=await runtime.paymentInput(device,body,session_id,origin);
  return result??(typeof body.control_id==='string'?{operation:'payment_receipt',control_id:body.control_id,ok:true}:undefined);
}
