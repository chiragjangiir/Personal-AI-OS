import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {provisionCentralResources,type CentralProvisionConfiguration} from '../src/main.ts';
import type {ThinkingModeConfiguration} from '../src/voice/contracts.ts';

const thinking:ThinkingModeConfiguration={enabled:true,reader_instructions:'逐字朗读权威正文，不自行回答。',
  status_text:{greeting:'我在。',waiting:'我在想。',slow:'请稍等。',failed:'请再试一次。',interrupted:'你说。',readout_mismatch:'请以正文为准。'}};
const voice={provider:'dashscope' as const,model:'fixture-model',region:'cn-beijing' as const,endpoint:'wss://example.invalid/realtime',
  key_file:'/unused/key',voice:'fixture-voice',instructions:'只转写。'};
test('thinking mode validates its external config at provisioning',async()=>{
  for(const thinking_mode of [null,[],false,{}, {...thinking,enabled:'yes'}, {...thinking,reader_instructions:''},
    {...thinking,unexpected:1}, {...thinking,status_text:{...thinking.status_text,slow:''}}, {...thinking,status_text:{greeting:'x'}},
    {...thinking,status_text:{...thinking.status_text,unexpected:'x'}}])
    await assert.rejects(provisionCentralResources({port:19091,voice_frontend:{...voice,call:{model:voice.model,voice:voice.voice,thinking_mode}}} as unknown as CentralProvisionConfiguration),/VOICE_FRONTEND_CONFIGURATION_INVALID/);
});
test('provisioning forwards configured thinking mode to voice resources; absent stays disabled',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'thinking-config-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(join(root,'key'),'synthetic-offline-fixture-key',{mode:0o600});await fs.writeFile(join(root,'skill'),'fixture');
  for(const configured of [undefined,thinking,{...thinking,enabled:false}]){
    const config:CentralProvisionConfiguration={port:19091,storage_root:join(root,'storage'),lock_file:join(root,'lock'),
      hermes_base_url:'http://127.0.0.1:1',hermes_key_file:join(root,'key'),internal_key_file:join(root,'key'),skill_file:join(root,'skill'),
      native_request_timeout_ms:1000,http_request_timeout_ms:1000,max_request_bytes:8192,max_event_bytes:8192,max_read_bytes:8192,
      admission:{max_pending_events:4,max_pending_bytes:65536,max_event_age_ms:10000,poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'thinking-config'},
      voice_frontend:{...voice,key_file:join(root,'key'),call:{model:voice.model,voice:voice.voice,...(configured?{thinking_mode:configured}:{})}}};
    const provision=await provisionCentralResources(config);
    try {assert.deepEqual((provision.resources.voice as unknown as {thinkingMode?:ThinkingModeConfiguration}).thinkingMode,configured);}
    finally {await provision.release();}
  }
});
