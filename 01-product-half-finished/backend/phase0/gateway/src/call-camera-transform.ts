import {fork,type ChildProcess} from 'node:child_process';
import {setPriority} from 'node:os';
import {fileURLToPath} from 'node:url';
import {VideoBufferType,VideoFrame} from '@livekit/rtc-node';
import sharp from 'sharp';

const GRID_W=32,GRID_H=18,MAX_EDGE=640,MAX_BASE64=256*1024,QUALITIES=[72,55,40];
export function lumaGrid(y:Uint8Array,width:number,height:number):Uint8Array {
  const grid=new Uint8Array(GRID_W*GRID_H);
  for(let cy=0;cy<GRID_H;cy++)for(let cx=0;cx<GRID_W;cx++){
    let sum=0;
    for(let sy=0;sy<4;sy++)for(let sx=0;sx<4;sx++){
      const px=Math.floor((cx+(sx+0.5)/4)*width/GRID_W),py=Math.floor((cy+(sy+0.5)/4)*height/GRID_H);
      sum+=y[py*width+px]??0;
    }
    grid[cy*GRID_W+cx]=sum>>4;
  }
  return grid;
}
export type CameraProjection={frame:VideoFrame;grid:Uint8Array};
type Request={id:number;operation:'project'|'encode';frame:Pick<VideoFrame,'data'|'width'|'height'|'type'>;rotation:number};
type Response={id:number;data?:Uint8Array;grid?:Uint8Array;jpeg?:string;error?:string};
async function jpeg(frame:VideoFrame,rotation:number){
  const rgba=frame.type===VideoBufferType.RGBA?frame:frame.convert(VideoBufferType.RGBA);
  const image=sharp(rgba.data,{raw:{width:rgba.width,height:rgba.height,channels:4}})
    .rotate(rotation*90).resize(MAX_EDGE,MAX_EDGE,{fit:'inside',withoutEnlargement:true}).removeAlpha();
  for(const quality of QUALITIES){const base64=(await image.clone().jpeg({quality}).toBuffer()).toString('base64');if(base64.length<=MAX_BASE64)return base64;}
  return undefined;
}
// RTC's FFI initializer owns a process-wide callback. A process keeps conversion isolated from live room events.
if(process.argv.includes('--paios-camera-transform')){
  sharp.cache(false);sharp.concurrency(1);
  process.on('message',(message:Request)=>{void(async()=>{
    const {id,operation,rotation}=message,value=message.frame,frame=new VideoFrame(value.data,value.width,value.height,value.type);
    try{
      let response:Response;
      if(operation==='encode'){const value=await jpeg(frame,rotation);response={id,...(value?{jpeg:value}:{})};}
      else{const planar=frame.type===VideoBufferType.I420?frame:frame.convert(VideoBufferType.I420);
        response={id,grid:lumaGrid(planar.data,planar.width,planar.height),...(planar===frame?{}:{data:planar.data})};}
      process.send!(response);
    }catch(error){process.send!({id,error:error instanceof Error?error.message:String(error)});}
  })();});
  process.on('disconnect',()=>process.exit(0));
}
export function createCameraTransforms(){
  const projections=new WeakMap<VideoFrame,Promise<CameraProjection>>();
  const jobs=new Map<number,{resolve(value:Response):void;reject(error:unknown):void}>();
  let child:ChildProcess|undefined,sequence=0,failure:unknown,closed=false;
  const fail=(error:unknown)=>{failure=error;for(const job of jobs.values())job.reject(error);jobs.clear();};
  const request=(operation:Request['operation'],frame:VideoFrame,rotation=0):Promise<Response>=>{
    if(closed)return Promise.reject(new Error('CALL_CAMERA_TRANSFORM_CLOSED'));
    if(failure)return Promise.reject(failure);
    if(!child){
      const env={...process.env};delete env.NODE_TEST_CONTEXT;
      child=fork(fileURLToPath(import.meta.url),['--paios-camera-transform'],{env,execArgv:process.execArgv.filter(arg=>!arg.startsWith('--test')),serialization:'advanced',stdio:['ignore','ignore','inherit','ipc']});
      if(child.pid!==undefined)setPriority(child.pid,19);
      child.on('message',(message:Response)=>{const job=jobs.get(message.id);if(!job)return;jobs.delete(message.id);
        message.error?job.reject(new Error(message.error)):job.resolve(message);});
      child.on('error',fail);child.on('exit',(code,signal)=>{if(!closed)fail(new Error(`CALL_CAMERA_TRANSFORM_EXIT:${code}:${signal}`));});
    }
    // Only the serial recorder and one live preview pump submit work. No acquisition-sized IPC queue exists.
    const id=++sequence;
    return new Promise((resolve,reject)=>{jobs.set(id,{resolve,reject});child!.send({id,operation,frame:{data:frame.data,width:frame.width,height:frame.height,type:frame.type},rotation},error=>{if(error)fail(error);});});
  };
  return {
    project(frame:VideoFrame){let projected=projections.get(frame);if(!projected){
      projected=request('project',frame).then(result=>({frame:result.data?new VideoFrame(result.data,frame.width,frame.height,VideoBufferType.I420):frame,grid:result.grid!}));
      projections.set(frame,projected);
    }return projected;},
    encode:async(frame:VideoFrame,rotation:number)=>(await request('encode',frame,rotation)).jpeg,
    snapshot:()=>({pending:jobs.size,pid:child?.pid}),
    async close(){closed=true;fail(new Error('CALL_CAMERA_TRANSFORM_CLOSED'));const current=child;
      if(!current||!current.pid||current.exitCode!==null||current.signalCode!==null)return;
      // Native RTC children exit after IPC disconnect without emitting close; all payloads are already drained.
      const exited=new Promise<void>(resolve=>current.once('exit',()=>resolve()));
      if(current.connected)current.disconnect();await exited;},
  };
}
export async function encodeCameraFrame(frame:VideoFrame,rotation:number){
  const transform=createCameraTransforms();try{return await transform.encode(frame,rotation);}finally{await transform.close();}
}
