import {randomUUID} from 'node:crypto';
import {check, ContractError} from './contracts.ts';

/** Correlates one encrypted camera upload with its requesting tool call. Capture policy owns admission. */
export class PhotoRequests {
  private closed=false;
  private readonly pending=new Map<string,{device:string;resolve:(value:Record<string,unknown>)=>void;reject:(error:unknown)=>void;stopAcquisition:()=>void;deferred:boolean;acquired:boolean;expires_at_ms:number;publish:(frame:string,expires_at_ms:number)=>Promise<void>;completed:((result:Record<string,unknown>)=>Promise<void>)|undefined}>();
  async capture(device:string,publish:(frame:string,expires_at_ms:number)=>Promise<void>,completed?:(result:Record<string,unknown>)=>Promise<void>):Promise<Record<string,unknown>> {
    check(!this.closed,'RUNTIME_CLOSED',503);
    check(![...this.pending.values()].some(request=>request.device===device),'CAMERA_REQUEST_BUSY',409);
    const frame=randomUUID(),expires_at_ms=Date.now()+20000;let timer:ReturnType<typeof setTimeout>|undefined;
    const received=new Promise<Record<string,unknown>>((resolve,reject)=>{
      this.pending.set(frame,{device,resolve,reject,stopAcquisition:()=>clearTimeout(timer),deferred:false,acquired:false,expires_at_ms,publish,completed});
      timer=setTimeout(()=>{this.pending.delete(frame);reject(new ContractError('CAMERA_REQUEST_TIMEOUT',504));},20000);
    });
    // Attach both failures before publication can race an upload or a disconnect.
    try {const [result]=await Promise.all([received,publish(frame,expires_at_ms)]);return result;}
    catch(error){this.failed(device,frame,error);throw error;}
    finally {if(!this.pending.get(frame)?.deferred){clearTimeout(timer);this.pending.delete(frame);}}
  }
  expects(device:string,frame:string):boolean {return this.pending.get(frame)?.device===device;}
  archived(device:string,frame:string):void {if(this.expects(device,frame)){const request=this.pending.get(frame)!;request.acquired=true;request.stopAcquisition();}}
  async resume(device:string):Promise<void> {
    for(const [frame,request] of this.pending)if(request.device===device&&request.deferred&&!request.acquired){
      if(Date.now()>=request.expires_at_ms){this.failed(device,frame,new ContractError('CAMERA_REQUEST_TIMEOUT',504));continue;}
      try {await request.publish(frame,request.expires_at_ms);}catch(error){this.failed(device,frame,error);throw error;}
    }
  }
  inactive(device:string,frame:string,error_code='CAMERA_APP_INACTIVE'):void {
    if(!this.expects(device,frame))return;const request=this.pending.get(frame)!;request.deferred=true;
    request.resolve({status:'unavailable',error_code,frame_id:frame,pending:true});
  }
  failed(device:string,frame:string,error:unknown):void {if(this.expects(device,frame)){const request=this.pending.get(frame)!;request.stopAcquisition();this.pending.delete(frame);request.reject(error);}}
  async observed(device:string,frame:string,result:Record<string,unknown>):Promise<void> {
    if(this.expects(device,frame)){const request=this.pending.get(frame)!;request.stopAcquisition();this.pending.delete(frame);
      if(request.deferred)await request.completed?.(result);else request.resolve(result);}
  }
  close():void {this.closed=true;for(const request of this.pending.values()){request.stopAcquisition();request.reject(new ContractError('RUNTIME_CLOSED',503));}this.pending.clear();}
}
