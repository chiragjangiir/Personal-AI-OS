import type {AnySchema} from 'ajv';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {check} from '../../../services/personal-aios-integration/src/contracts.ts';
import type {RegisteredDevice} from '../../../services/personal-aios-integration/src/source-authority.ts';
interface ModelSettingsWire {
  version:number;schema:string;$defs:Record<string,AnySchema>;
  inputs:Record<string,{definition:AnySchema;error:string}>;
  outputs:Record<string,AnySchema>;
  examples:Record<string,Record<string,unknown>[]>;
}
const registry=JSON.parse(readFileSync(new URL('../../../../../integrations/contracts/formal-message.v1.json',import.meta.url),'utf8')).extensions as {contract:string;version:number;sha256:string}[];
const registration=registry.find(entry=>entry.contract==='model-settings.v1.json');
check(registration?.version===1,'MODEL_SETTINGS_WIRE_REGISTRATION_REQUIRED');
const bytes=readFileSync(new URL('../../../../../integrations/contracts/model-settings.v1.json',import.meta.url));
check(createHash('sha256').update(bytes).digest('hex')===registration.sha256,'MODEL_SETTINGS_WIRE_CONTRACT_CHANGED');
export const modelSettingsWire=JSON.parse(bytes.toString('utf8')) as ModelSettingsWire;
export function mergeModelSettingsWire(wire:Pick<ModelSettingsWire,'$defs'|'inputs'|'outputs'>):void {
  for(const key of Object.keys(modelSettingsWire.$defs))check(!Object.hasOwn(wire.$defs,key),'MODEL_SETTINGS_WIRE_DEFINITION_CONFLICT');
  Object.assign(wire.$defs,modelSettingsWire.$defs);Object.assign(wire.inputs,modelSettingsWire.inputs);Object.assign(wire.outputs,modelSettingsWire.outputs);
}
export const isModelSettingsInput=(operation:unknown):boolean=>typeof operation==='string'&&Object.hasOwn(modelSettingsWire.inputs,operation);
export interface ModelSettingsWireRuntime {
  modelSettingsControl(source:RegisteredDevice,body:Record<string,unknown>):Promise<unknown>;
  modelSettingsWatch(source:RegisteredDevice,notify:(state:Record<string,unknown>)=>Promise<void>):Promise<()=>void>;
}
/** Existing paired-owner channel carries requests; the integration owns authorization and state. */
export async function dispatchModelSettings(runtime:ModelSettingsWireRuntime,source:RegisteredDevice,body:Record<string,unknown>):Promise<Record<string,unknown>> {
  check(source.device_type==='phone'||source.device_type==='mac','MODEL_SETTINGS_TERMINAL_NOT_ALLOWED',403);
  const result=await runtime.modelSettingsControl(source,body);
  return {operation:'model_settings_receipt',control_id:body.control_id,ok:true,...(result===undefined?{}:{result})};
}
