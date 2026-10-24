import {readFileSync} from 'node:fs';

export interface ViduAvatarAsset {id:string;state:'pending'|'ready'|'failed'}
export class ViduAvatarRequestRejected extends Error {}
export interface ViduAvatarAssets {
  create(imageUri:string,name:string):Promise<ViduAvatarAsset>;
  get(id:string):Promise<ViduAvatarAsset>;
}
/** HTTP field conversion only. Submission recovery and retry belong to the profile owner. */
export function createViduAvatarAssets(input:{base_url:string;api_key_file:string;fetch?:typeof fetch}):ViduAvatarAssets {
  const origin=new URL(input.base_url);
  if(origin.protocol!=='https:'||origin.origin!==input.base_url)throw new Error('AVATAR_VIDU_ORIGIN_INVALID');
  const key=readFileSync(input.api_key_file,'utf8').trim();
  if(!key)throw new Error('AVATAR_VIDU_KEY_EMPTY');
  const request=async(path:string,body?:unknown):Promise<ViduAvatarAsset>=>{
    const response=await(input.fetch??fetch)(origin.origin+'/live/v1/avatars'+path,{
      method:body===undefined?'GET':'POST',headers:{Authorization:'Token '+key,'Content-Type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30_000),redirect:'error',
    });
    if(!response.ok){
      const message='AVATAR_VIDU_HTTP_'+response.status;
      if(response.status>=400&&response.status<500&&response.status!==408)throw new ViduAvatarRequestRejected(message);
      throw new Error(message);
    }
    const raw=await response.json() as {id?:unknown;status?:unknown};
    if(typeof raw.id!=='string'||!raw.id)throw new Error('AVATAR_VIDU_RESPONSE_INVALID');
    const state=raw.status==='success'||raw.status===11?'ready':raw.status==='failed'||raw.status===12?'failed':
      raw.status==='created'||raw.status===1||raw.status==='processing'||raw.status===6?'pending':null;
    if(!state)throw new Error('AVATAR_VIDU_STATUS_INVALID');
    return{id:raw.id,state};
  };
  return{create:(image_uri,name)=>request('',{image_uri,name}),get:async id=>{const asset=await request('/'+encodeURIComponent(id));if(asset.id!==id)throw new Error('AVATAR_VIDU_ID_MISMATCH');return asset;}};
}
