import {createHash} from 'node:crypto';
import {check,ContractError} from '../contracts.ts';
import type {SpeechVadStream} from '../voiceprint/engine.ts';
export interface VadProgress {processed_samples:number; input_sha256:string; start?:number; end?:number}
export interface VadStream {
  readonly model:{id:string;version:string;device:string;native_metadata:{onnx_sha256:string}&Record<string,string|number>};
  write(bytes:Uint8Array):Promise<VadProgress[]>;
  finish():Promise<{processed_samples:number;uninferred_samples:number;input_sha256:string}>;
  close():Promise<void>;
}
export interface VadStreamFactory {open(signal:AbortSignal):Promise<VadStream>}
/** The speech engine's Silero detector (LocalSpeechEngine, or a controlled one in tests). */
export interface SpeechVad {readonly vad_model:VadStream['model'];openVad(signal:AbortSignal):Promise<SpeechVadStream>}

const FRAME_BYTES=1024;
// Binary PCM framing and input hashes only; never owns candidate or time policies. Every whole 512-sample frame
// yields one progress item carrying the hash of all input through it; finish never flushes open speech.
export class SherpaSileroStreamFactory implements VadStreamFactory {
  private readonly source:()=>Promise<SpeechVad>;
  constructor(source:()=>Promise<SpeechVad>){this.source=source;}
  async open(signal:AbortSignal):Promise<VadStream> {
    check(!signal.aborted,'MEDIA_CANCELLED',409);
    const engine=await this.source(),native=await engine.openVad(signal),model=structuredClone(engine.vad_model);
    const hash=createHash('sha256'),closed=Promise.withResolvers<never>();void closed.promise.catch(()=>{});
    let tail=Buffer.alloc(0),written=0,processed=0,busy=false,ended=false,failed:unknown,closing:Promise<void>|undefined;
    const close=()=>closing??=(ended=true,closed.reject(new ContractError('SILERO_STREAM_CLOSED',409)),native.close());
    return {model,
      write:async bytes=>{
        check(!ended&&!busy&&!failed,'SILERO_STREAM_UNAVAILABLE');check(bytes.length>0&&bytes.length%2===0,'SILERO_PCM');busy=true;
        try {
          const joined=Buffer.concat([tail,bytes]),frames=Math.floor(joined.length/FRAME_BYTES),progress:VadProgress[]=[];
          for(let n=0;n<frames;n++){hash.update(joined.subarray(n*FRAME_BYTES,(n+1)*FRAME_BYTES));
            progress.push({processed_samples:processed+(n+1)*512,input_sha256:hash.copy().digest('hex')});}
          tail=Buffer.from(joined.subarray(frames*FRAME_BYTES));written+=bytes.length/2;
          if(!frames)return [];
          const samples=new Float32Array(frames*512);
          for(let n=0;n<samples.length;n++)samples[n]=joined.readInt16LE(n*2)/32768;
          // A close while the native write is pending ends this write; the detector itself closes after it.
          const events=await Promise.race([native.write(samples),closed.promise]);
          for(const event of events) {
            const item=progress[(event.at-processed)/512-1];
            check(item&&(event.start===undefined)!==(event.end===undefined),'SILERO_EVENT_INVALID');
            for(const key of ['start','end'] as const) if(event[key]!==undefined) {
              check(Number.isSafeInteger(event[key])&&event[key]>=0&&event[key]<=event.at,'SILERO_EVENT_RANGE');item[key]=event[key];
            }
          }
          processed+=frames*512;return progress;
        } catch(error) {failed=error;throw error;} finally {busy=false;}
      },
      finish:async()=>{
        check(!busy&&!ended&&!failed,'SILERO_STREAM_UNAVAILABLE');
        const input_sha256=hash.update(tail).digest('hex');await close();
        return {processed_samples:processed,uninferred_samples:written-processed,input_sha256};
      },close};
  }
}
