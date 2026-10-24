import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import sharp from 'sharp';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {check,ContractError} from '../../../services/personal-aios-integration/src/contracts.ts';
import type {AvatarLook} from './avatar-profile.ts';

type Owner={principal_id:string;device_id:string};
type ImageRecord={owner:string;look:AvatarLook;jpeg:string};
const prefix='/v1/appearance/images';
const maximumBytes=5_242_880;
export function isAppearanceImageRoute(method:string|undefined,url:string|undefined){
  const path=url??'';
  return method==='POST'&&path===prefix||method==='GET'&&/^\/v1\/appearance\/images\/image-[a-f0-9-]{36}\.jpg$/u.test(path);
}
const idPattern=/^image-([a-f0-9-]{36})$/u;
/** Immutable image assets only; AvatarProfileService remains the sole profile and preparation owner. */
export function createAppearanceImages(input:{directory:string;publicOrigin:string;authenticate:(request:IncomingMessage)=>Promise<Owner>}){
  const origin=new URL(input.publicOrigin);
  check(origin.protocol==='https:'&&origin.origin===input.publicOrigin,'AVATAR_IMAGE_ORIGIN_INVALID');
  const load=async(id:string):Promise<ImageRecord|undefined>=>{
    if(!idPattern.test(id))return;
    try{return JSON.parse(await readFile(join(input.directory,id+'.json'),'utf8')) as ImageRecord;}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  };
  const store=async(record:ImageRecord)=>{
    await mkdir(input.directory,{recursive:true,mode:0o700});
    await writeFile(join(input.directory,record.look.look_id+'.json'),JSON.stringify(record),{flag:'wx',mode:0o600});
  };
  return {
    resolveLook:async(principal:string,id:string)=>{const record=await load(id);return record?.owner===principal?record.look:undefined;},
    handle:async(request:IncomingMessage,response:ServerResponse):Promise<boolean>=>{
      const target=new URL(request.url??'/',origin);
      if(target.pathname!==prefix&&!target.pathname.startsWith(prefix+'/'))return false;
      try{
        check(!target.search,'AVATAR_IMAGE_ROUTE_INVALID',404);
        if(request.method==='GET'){
          const id=target.pathname.slice(prefix.length+1).replace(/\.jpg$/u,'');
          check(target.pathname===prefix+'/'+id+'.jpg','AVATAR_IMAGE_NOT_FOUND',404);
          const record=await load(id);check(record,'AVATAR_IMAGE_NOT_FOUND',404);
          const bytes=Buffer.from(record.jpeg,'base64');
          response.writeHead(200,{'content-type':'image/jpeg','content-length':bytes.length,'cache-control':'private, max-age=86400','x-content-type-options':'nosniff'});
          response.end(bytes);return true;
        }
        check(request.method==='POST'&&target.pathname===prefix,'AVATAR_IMAGE_ROUTE_INVALID',404);
        const owner=await input.authenticate(request);
        check(request.headers['content-type']==='image/jpeg','AVATAR_IMAGE_JPEG_REQUIRED',415);
        const chunks:Buffer[]=[];let size=0;
        for await(const chunk of request){const bytes=Buffer.from(chunk);size+=bytes.length;check(size<=maximumBytes,'AVATAR_IMAGE_TOO_LARGE',413);chunks.push(bytes);}
        let bytes=Buffer.concat(chunks);
        try{
          const image=sharp(bytes,{limitInputPixels:24_000_000});
          check((await image.metadata()).format==='jpeg','AVATAR_IMAGE_JPEG_REQUIRED',422);
          bytes=await image.rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true}).jpeg({quality:90}).toBuffer();
        }catch(error){if(error instanceof ContractError)throw error;throw new ContractError('AVATAR_IMAGE_JPEG_INVALID',422);}
        const id='image-'+randomUUID();
        const look:AvatarLook={look_id:id,style:'自选照片',image_url:origin.origin+prefix+'/'+id+'.jpg',focus:{x:0.5,y:0.4}};
        await store({owner:owner.principal_id,look,jpeg:bytes.toString('base64')});
        const body=JSON.stringify(look);response.writeHead(201,{'content-type':'application/json','content-length':Buffer.byteLength(body),'cache-control':'no-store'});response.end(body);
      }catch(error){
        if(!(error instanceof ContractError))throw error;
        const body=JSON.stringify({error:error.code});response.writeHead(error.status,{'content-type':'application/json','cache-control':'no-store'});response.end(body);
      }
      return true;
    }
  };
}
