import {mkdtempSync,writeFileSync,chmodSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {canonical} from '../../../services/personal-aios-integration/src/contracts.ts';
import type {ProductResourceConfiguration} from '../src/rayneo-persistent-production-entrypoint.ts';

export const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
export const operations=['bootstrap','realtime_e2ee_key_resolve','connected_credential_refresh','media_stop','end_continuity','handoff'];
export const user='01952f00-0000-7000-8000-000000000501',device='01952f00-0000-7000-8000-000000000502';
export const now=Date.now(),at=(n:number)=>new Date(n).toISOString();
export function makeMacProductResourceFixture(root?: string){
 root ??= mkdtempSync(join(tmpdir(),'paios-product-resource-'));mkdirSync(root,{recursive:true,mode:0o700});chmodSync(root,0o700);
 const file=(name:string,value:unknown)=>{const p=join(root,name);writeFileSync(p,typeof value==='string'?value:canonical(value)+'\n',{mode:0o600});return p;};
 const config:ProductResourceConfiguration={postgres:{host:'127.0.0.1',port:55439,database:'postgres',user:'l3test',password_file:file('postgres.password','synthetic-not-production')},livekit_url:'wss://ai.example.invalid',
  owner_policy_file:file('local-owner.v1.json',{schema:'paios.windows.local-owner.v1',purpose:'public_product_canary',revocable:true,userId:user}),
  livekit_key_file:file('key','A'.repeat(24)),livekit_secret_file:file('secret','B'.repeat(40)),proxy_file:file('proxy',Buffer.alloc(32,3).toString('base64url')),e2ee_file:file('e2ee',Buffer.alloc(32,4).toString('base64url')),pairing_file:join(root,'pairing','paired-device.v1.json')};
 return {root,config,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
