import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createViduAvatarAssets,ViduAvatarRequestRejected} from '../src/vidu-avatar-assets.ts';

test('Vidu image_uri adapter sends one authenticated POST and reads documented ready status',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'avatar-assets-'));const key=join(dir,'key');writeFileSync(key,'test-key\n');
  const calls:{url:string;init:RequestInit}[]=[];
  const fetcher=(async(url,init)=>{
    calls.push({url:String(url),init:init!});
    return Response.json({id:'asset-1',status:calls.length===1?'processing':'success'});
  }) as typeof fetch;
  try{
    const api=createViduAvatarAssets({base_url:'https://api.vidu.cn',api_key_file:key,fetch:fetcher});
    assert.deepEqual(await api.create('https://assets.example/immutable/portrait.jpg','owner-command'),{id:'asset-1',state:'pending'});
    assert.deepEqual(await api.get('asset-1'),{id:'asset-1',state:'ready'});
    assert.equal(calls[0]!.url,'https://api.vidu.cn/live/v1/avatars');
    assert.equal(calls[0]!.init.method,'POST');
    assert.equal(new Headers(calls[0]!.init.headers).get('Authorization'),'Token test-key');
    assert.deepEqual(JSON.parse(calls[0]!.init.body as string),{image_uri:'https://assets.example/immutable/portrait.jpg',name:'owner-command'});
    assert.equal(calls[1]!.url,'https://api.vidu.cn/live/v1/avatars/asset-1');assert.equal(calls[1]!.init.method,'GET');
  }finally{rmSync(dir,{recursive:true});}
});

test('Vidu adapter distinguishes explicit rejection, malformed result, and mismatched identity',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'avatar-assets-'));const key=join(dir,'key');writeFileSync(key,'test-key');
  const api=(response:Response)=>createViduAvatarAssets({base_url:'https://api.vidu.cn',api_key_file:key,fetch:(async()=>response) as typeof fetch});
  try{
    await assert.rejects(api(new Response('',{status:400})).create('https://assets.example/x','x'),ViduAvatarRequestRejected);
    await assert.rejects(api(Response.json({id:'id',status:'unknown'})).get('id'),/STATUS_INVALID/);
    await assert.rejects(api(Response.json({id:'wrong-id',status:'success'})).get('id'),/ID_MISMATCH/);
  }finally{rmSync(dir,{recursive:true});}
});
