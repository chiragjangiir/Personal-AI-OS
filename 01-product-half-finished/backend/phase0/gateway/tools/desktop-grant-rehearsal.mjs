// Scenario driver for the existing synthetic host. Run only in the approved synthetic gateway.
import {readFile,writeFile,mkdir,open} from 'node:fs/promises';
import {resolve,join,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
if(!process.argv.includes('--execute')){
  console.log(JSON.stringify({dry_run:true,required:['--origin','--phone-pairing','--phone-recipient','--out','--candidate-binding'],
    steps:['enroll','connect existing host','drag/paste grant and formal attachment','phone read + bounded upload','verify bytes and rendered reply','revoke new Mac']}));
  process.exit(0);
}
for(const name of ['origin','phone-pairing','phone-recipient','out','candidate-binding'])if(!arg('--'+name))throw Error('Missing --'+name);
const origin=arg('--origin'),out=resolve(arg('--out')),via=arg('--via')??'drag';
if(new URL(origin).protocol!=='https:'||new URL(origin).origin!==origin||!['drag','paste'].includes(via))throw Error('INVALID_REHEARSAL_INPUT');
const binding=JSON.parse(await readFile(arg('--candidate-binding'),'utf8'));
const cli=fileURLToPath(new URL('./mac-product-sim-client.ts',import.meta.url));
if(!/^[a-f0-9]{40}$/.test(binding.candidate)||!/^sha256:[a-f0-9]{64}$/.test(binding.image_id)||binding.container_image_id!==binding.image_id||
  cli!==join(binding.source_root,'01-product-half-finished/backend/phase0/gateway/tools/mac-product-sim-client.ts'))throw Error('EXTERNAL_CANDIDATE_BINDING_INVALID');
const phone=JSON.parse(await readFile(arg('--phone-pairing'),'utf8'));
await mkdir(out,{mode:0o700});const scratch=join(out,'scratch');await mkdir(scratch,{mode:0o700});
await mkdir(join(scratch,'文稿','依米'),{recursive:true});
const input=join(scratch,'attached.txt'),bytes=Buffer.from('DK_FIXTURE_'+randomUUID()+'\n');await writeFile(input,bytes,{flag:'wx',mode:0o600});
const pairing=join(out,'mac-pairing.json'),recipient=join(out,'mac-recipient.jwk'),enrollment=join(out,'enrollment.json'),handles=[];
const phoneArgs=['--pairing',arg('--phone-pairing'),'--recipient-key',arg('--phone-recipient'),'--origin',origin];
let host,primaryError,receipt;
async function start(label,args){
  const stdout=await open(join(out,label+'.jsonl'),'wx',0o600),stderr=await open(join(out,label+'.stderr'),'wx',0o600);handles.push(stdout,stderr);
  const child=spawn(process.execPath,[...(arg('--preload')?['--import',arg('--preload')]:[]),cli,...args],{stdio:['ignore',stdout.fd,stderr.fd]});
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});void done.catch(()=>{});
  return {child,done};
}
async function runPhone(label,args){
  const job=await start(label,[...phoneArgs,...args]),timer=setTimeout(()=>job.child.kill('SIGTERM'),360000);
  try{const result=await job.done;if(result.code!==0)throw Error(label.toUpperCase()+'_CLI_FAILED');
    const report=JSON.parse(await readFile(join(out,label+'.jsonl'),'utf8'));
    if(!report.steps.some(row=>row.step==='prompt_playback'&&row.status==='rendered'))throw Error('PHONE_RENDER_NOT_OBSERVED');return report;
  }finally{clearTimeout(timer);}
}
async function hostRows(){const text=await readFile(join(out,'desktop.jsonl'),'utf8');return text.slice(0,text.lastIndexOf('\n')+1).split('\n').filter(line=>line.startsWith('{"step":')).map(line=>JSON.parse(line));}
try{
  const response=await fetch(origin+'/v1/devices/mac/enrollment',{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+phone.token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(30000)});
  if(response.status!==200)throw Error('MAC_ENROLLMENT_HTTP_'+response.status);const issued=await response.json();
  if(issued.schema!=='paios.mac-enrollment.v1'||issued.origin!==origin)throw Error('MAC_ENROLLMENT_BINDING_INVALID');
  await writeFile(enrollment,JSON.stringify(issued),{flag:'wx',mode:0o600});
  host=await start('desktop',['--desktop',scratch,'--desktop-seconds','900','--enrollment',enrollment,'--pairing',pairing,'--recipient-key',recipient,
    '--desktop-attachment',input,'--desktop-via',via]);
  const deadline=Date.now()+300000;
  while(!(await hostRows()).some(row=>row.step==='desktop_attachment'&&row.status==='rendered')){
    if(host.child.exitCode!==null||host.child.signalCode!==null||Date.now()>deadline)throw Error('DESKTOP_ATTACHMENT_NOT_RENDERED');await delay(1000);
  }
  const before=(await hostRows()).length;
  await runPhone('phone-read',['--prompt',`这是隔离合成验收。请调用 desktop read_text_file 读取 ${input}，再调用 upload_to_workshop 上传同一文件。仅用文字报告结果。`]);
  const rows=(await hostRows()).slice(before),read=rows.some(row=>row.step==='desktop_tool'&&row.tool==='read_text_file'&&row.outcome==='ok'),upload=rows.findLast(row=>row.step==='desktop_tool'&&row.tool==='upload_to_workshop'&&row.outcome==='ok');
  if(!read||!upload)throw Error('DESKTOP_TOOLS_NOT_OBSERVED');
  if(!/^dt-[0-9a-f-]+$/.test(upload.transfer_id))throw Error('TRANSFER_RECEIPT_INVALID');
  const received=await readFile(join('/var/lib/paios/desktop-in',upload.transfer_id,basename(input)));
  if(!received.equals(bytes))throw Error('RECEIVED_BYTES_DIFFER');
  receipt={candidate:binding.candidate,image_id:binding.image_id,via,desktop_read:'observed',bounded_upload:'byte_equal',phone_reply:'rendered',native_no_grant:'run_focused_native_suite_separately'};
}catch(error){primaryError=error;}
finally{
  try{
    const mac=await readFile(pairing,'utf8').then(JSON.parse).catch(error=>{if(error.code!=='ENOENT')throw error;});
    if(mac){
      const control=join(out,'revoke.json');await writeFile(control,JSON.stringify({operation:'terminal_revoke',control_id:'dk-fixture-'+randomUUID(),device_id:mac.device_id}),{flag:'wx',mode:0o600});
      const job=await start('phone-revoke',[...phoneArgs,'--control',control]),timer=setTimeout(()=>job.child.kill('SIGTERM'),90000);
      try{if((await job.done).code!==0)throw Error('NEW_MAC_REVOKE_FAILED');}finally{clearTimeout(timer);}
    }
  }catch(error){primaryError??=error;console.error('NEW_MAC_REVOKE_INCOMPLETE');}
  if(host){if(host.child.exitCode===null&&host.child.signalCode===null)host.child.kill('SIGTERM');
    const timer=setTimeout(()=>{if(host.child.exitCode===null&&host.child.signalCode===null)host.child.kill('SIGKILL');},10000);
    try{await host.done;}finally{clearTimeout(timer);}}
  for(const handle of handles)await handle.close();
}
if(primaryError)throw primaryError;
console.log(JSON.stringify({...receipt,new_mac:'revoked'}));
