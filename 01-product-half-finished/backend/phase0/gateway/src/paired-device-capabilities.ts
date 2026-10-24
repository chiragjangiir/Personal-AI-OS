import {createHash} from 'node:crypto';
import {canonical,check} from '../../../services/personal-aios-integration/src/contracts.ts';
import {TERMINAL_CAPABILITIES,terminalCapabilities,type TerminalCapability} from '../../../services/personal-aios-integration/src/source-authority.ts';
import type {CapabilityUpgradeRequest} from '../../../services/personal-aios-integration/src/voiceprint/confirmation.ts';
import {issueDeviceGovernance} from './paired-device-registration.ts';
import {wireGovernanceOf,PairedDeviceAuthorityError,type DeviceAuthorityProjection} from './paired-device-authority.ts';
import type {JsonRecord} from './realtime-public-control-runtime.ts';

type Issuer=Parameters<typeof issueDeviceGovernance>[0]['identity'];
type Pool=Parameters<typeof import('./paired-device-authority.ts').createPairedDeviceAuthority>[0]['pool'];
const digest=(token:string)=>createHash('sha256').update(token).digest('hex');
const names:Record<TerminalCapability,string>={display:'显示',speaker:'扬声器',microphone:'麦克风',continuous_audio:'持续收音',camera:'摄像头',
  notifications:'通知',health:'健康数据',contacts:'联系人',location:'位置',owner_unlock:'主人确认',chat_ui:'聊天界面',wear_state:'佩戴状态',local_wake:'本地唤醒',desktop_tools:'电脑工具'};
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);

/** The paired row owns both the latest declaration and the approved grant. Confirmation owns the decision. */
export function createPairedDeviceCapabilities(options:{pool:Pool;identity:Issuer;
  request:(request:CapabilityUpgradeRequest,text:string)=>Promise<void>;
  refresh:(deviceId:string)=>Promise<Pick<DeviceAuthorityProjection,'governance'|'capabilities'|'allowedMediaCapabilities'>>;
}) {
  const reissue=async(client:Pick<Pool,'query'>,row:JsonRecord,capabilities:readonly TerminalCapability[],governance:JsonRecord)=>{
    const previous=governance.capability_grant_refs as JsonRecord[];
    const issued=issueDeviceGovernance({identity:options.identity,userId:String(row.user_id),deviceId:String(row.device_id),
      deviceType:row.device_class==='iphone'?'phone':row.device_class as 'mac'|'glasses',
      publicKeySha256:String(row.recipient_public_key_sha256),capabilities,pairedAt:new Date(row.paired_at as string).toISOString(),
      version:Number(previous[0]!.object_version)+1});
    Object.assign(governance,issued.governance);
    row.media=issued.media;
    await client.query('UPDATE paired_devices SET governance = $2::jsonb, media = $3 WHERE device_id = $1',
      [row.device_id,JSON.stringify(governance),issued.media]);
  };
  return {
    declare:async(token:string,declared:unknown)=>{
      const client=await options.pool.connect();let row:JsonRecord,request:CapabilityUpgradeRequest|undefined,text:string|undefined;
      let reduced=false;
      try {
        await client.query('BEGIN');
        const result=await client.query("SELECT device_id::text,user_id::text,device_class,recipient_public_key_sha256,paired_at,governance,media FROM paired_devices WHERE token_sha256 = $1 AND status = 'active' FOR UPDATE",[digest(token)]);
        if(result.rows.length!==1)throw new PairedDeviceAuthorityError('CONTROL_CAPABILITY_INVALID',401);
        row=result.rows[0]!;
        check(Array.isArray(declared),'INVALID_TERMINAL_CAPABILITIES');
        const capabilities=[...terminalCapabilities({device_type:row.device_class==='iphone'?'phone':String(row.device_class),capabilities:declared as TerminalCapability[]})].sort();
        const governance=row.governance as JsonRecord;
        const granted=terminalCapabilities({device_type:row.device_class==='iphone'?'phone':String(row.device_class),capabilities:governance.terminal_capabilities as TerminalCapability[]|undefined});
        const retained=granted.filter(capability=>capabilities.includes(capability));
        const added=TERMINAL_CAPABILITIES.filter(capability=>capabilities.includes(capability)&&!granted.includes(capability));
        const declarationChanged=governance.capability_declaration===undefined||!same(governance.capability_declaration,capabilities);
        governance.capability_declaration=capabilities;
        if(retained.length!==granted.length){await reissue(client,row,retained,governance);reduced=true;}
        else if(declarationChanged)await client.query('UPDATE paired_devices SET governance = $2::jsonb WHERE device_id = $1',[row.device_id,JSON.stringify(governance)]);
        if(added.length){
          request={principal_id:String(row.user_id),device_id:String(row.device_id),capabilities,grant_ref:(governance.capability_grant_refs as JsonRecord[])[0]!};
          const label=row.device_class==='mac'?'电脑':row.device_class==='glasses'?'眼镜':'手机';
          text=`${label}上的依米新增了${added.map(capability=>names[capability]).join('、')}，允许吗？`;
        }
        await client.query('COMMIT');
      } catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
      if(reduced&&request)await options.refresh(String(row.device_id));
      if(request)await options.request(request,text!);
      const current=await options.refresh(String(row.device_id));
      return {governance:wireGovernanceOf(current.governance as JsonRecord),media:current.allowedMediaCapabilities,capabilities:current.capabilities};
    },
    approve:async(request:CapabilityUpgradeRequest)=>{
      const client=await options.pool.connect();
      try {
        await client.query('BEGIN');
        const result=await client.query("SELECT device_id::text,user_id::text,device_class,recipient_public_key_sha256,paired_at,governance,media FROM paired_devices WHERE device_id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE",[request.device_id,request.principal_id]);
        check(result.rows.length===1,'PAIRED_DEVICE_REVOKED',403);
        const row=result.rows[0]!,governance=row.governance as JsonRecord;
        check(same(governance.capability_declaration,request.capabilities),'CAPABILITY_DECLARATION_CHANGED',409);
        // Replaying a persisted approval after a process failure must not issue a second grant.
        if(!same(governance.terminal_capabilities,request.capabilities)){
          check(same((governance.capability_grant_refs as JsonRecord[])[0],request.grant_ref),'CAPABILITY_GRANT_CHANGED',409);
          await reissue(client,row,request.capabilities,governance);
        }
        await client.query('COMMIT');
      } catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
    }
  };
}
