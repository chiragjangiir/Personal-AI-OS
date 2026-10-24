import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {check} from '../contracts.ts';
export interface FaceEmbedding {embedding:Float32Array;bbox:number[];confidence:number}
export interface FaceEngine {prepare(bytes:Buffer,signal?:AbortSignal):Promise<PreparedVisualImage>}
export interface PreparedVisualImage {thumbnail:Buffer;signature:Buffer;faces:FaceEmbedding[]}
export const VISUAL_IMAGE_BYTES=3*1024*1024;
const defaultPython=process.env.PAIOS_VISION_PYTHON??'python3';
/** One decoded frame produces its warm image, scene signature and optional CPU faces. */
export async function prepareVisualImage(bytes:Buffer,python=defaultPython,signal?:AbortSignal,models?:{detector_model:string;recognizer_model:string}):Promise<PreparedVisualImage> {
  check(bytes.byteLength>0&&bytes.byteLength<=VISUAL_IMAGE_BYTES,'VISUAL_IMAGE_TOO_LARGE',413);
  const child=spawn(python,[fileURLToPath(new URL('./image.py',import.meta.url)),'prepare',...(models?[models.detector_model,models.recognizer_model]:[])],
    {signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(30000)])});
  const output:Buffer[]=[],errors:Buffer[]=[];let size=0,errorSize=0;
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>1024*1024)child.kill();else output.push(chunk);});
  child.stderr.on('data',chunk=>{errorSize+=chunk.length;if(errorSize<=32*1024)errors.push(chunk);});child.stdin.on('error',()=>{});child.stdin.end(bytes);
  await new Promise<void>((resolve,reject)=>{let failure:Error|undefined;child.once('error',error=>{failure=error;});child.once('close',code=>{
    if(failure)reject(failure);else if(code===0)resolve();else reject(new Error(`VISUAL_IMAGE_DECODE_FAILED:${Buffer.concat(errors).toString().slice(0,300)}`));});});
  const result=Buffer.concat(output);check(result.length>=68,'VISUAL_IMAGE_DECODE_FAILED',422);
  const header=result.readUInt32BE(0);check(header<=result.length-68,'VISUAL_IMAGE_DECODE_FAILED',422);
  const metadata=JSON.parse(result.subarray(4,4+header).toString());
  const signature=result.subarray(4+header,68+header),thumbnail=result.subarray(68+header);
  check(thumbnail.length>0&&Array.isArray(metadata.faces),'VISUAL_IMAGE_DECODE_FAILED',422);
  const faces=metadata.faces.map((face:{embedding:number[];bbox:number[];confidence:number})=>{
    check(Array.isArray(face.embedding)&&face.embedding.length===128&&face.embedding.every(Number.isFinite)&&Array.isArray(face.bbox)&&face.bbox.length===4&&face.bbox.every(Number.isFinite)&&Number.isFinite(face.confidence),'FACE_ENGINE_RESPONSE_INVALID',502);
    return {...face,embedding:Float32Array.from(face.embedding)};
  });
  return {thumbnail,signature,faces};
}

export class CpuFaceEngine implements FaceEngine {
  private readonly models:{detector_model:string;recognizer_model:string};
  constructor(models:{detector_model:string;recognizer_model:string}) {this.models=models;}
  prepare(bytes:Buffer,signal?:AbortSignal){return prepareVisualImage(bytes,defaultPython,signal,this.models);}
}
