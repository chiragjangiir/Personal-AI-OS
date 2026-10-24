import type {IncomingMessage} from 'node:http';
import {check} from './contracts.ts';

/** Reserve before reading. The route owns the lease until its decoded payload consumer finishes. */
export class HttpBodyBudget {
  private requests=0;private bytes=0;
  readonly maxBytes:number;readonly maxRequests:number;
  constructor(maxBytes:number,maxRequests=8){this.maxBytes=maxBytes;this.maxRequests=maxRequests;}
  snapshot(){return {active:this.requests,reserved_bytes:this.bytes,max_bytes:this.maxBytes,max_requests:this.maxRequests};}
  acquire(request:IncomingMessage,maximum:number){
    const header=request.headers['content-length'];
    const length=header===undefined?maximum:Number(header);
    check(Number.isSafeInteger(length)&&length>=0&&length<=maximum,'REQUEST_TOO_LARGE',413);
    check(this.requests<this.maxRequests&&this.bytes+length<=this.maxBytes,'REQUEST_BODY_BUSY',429);
    this.requests++;this.bytes+=length;let released=false;
    return ()=>{if(!released){released=true;this.requests--;this.bytes-=length;}};
  }
}

export async function readBody(request:IncomingMessage,maximum:number):Promise<Buffer>{
  const header=request.headers['content-length'],length=header===undefined?undefined:Number(header);
  check(length===undefined||Number.isSafeInteger(length)&&length>=0&&length<=maximum,'REQUEST_TOO_LARGE',413);
  const target=length===undefined?undefined:Buffer.allocUnsafe(length),chunks:Buffer[]=[];let bytes=0;
  for await(const chunk of request){
    bytes+=chunk.byteLength;check(bytes<=maximum&&(length===undefined||bytes<=length),'REQUEST_TOO_LARGE',413);
    if(target)target.set(chunk,bytes-chunk.byteLength);else chunks.push(chunk);
  }
  check(length===undefined||bytes===length,'REQUEST_BODY_TRUNCATED');
  const body=target??Buffer.concat(chunks,bytes);chunks.length=0;return body;
}
