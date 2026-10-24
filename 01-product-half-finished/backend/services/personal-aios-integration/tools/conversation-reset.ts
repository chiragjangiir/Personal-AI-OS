/** Private JSON-stdin worker for deploy/cloud/conversation_reset.py. No service is started. */
import {promises as fs} from 'node:fs';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {acquireProcessLock} from '../src/process-lock.ts';
import {loadHostConfiguration} from '../src/host-configuration.ts';
import {check} from '../src/contracts.ts';
import {planArchiveConversationReset,executeArchiveConversationReset} from '../src/archive-conversation-reset.ts';
import {resetIntegrationConversation} from '../src/conversation-reset.ts';
import {resetPostgresConversations,inspectPostgresConversationReferences} from '../../platform-data/src/conversation-reset.ts';
import type {ColdConfig} from '../src/cold-storage.ts';
import {resetTurnCorpus} from '../src/voice/turn-collection.ts';

interface Request {
  action:'preview'|'execute'|'prepare_backup';cutoff:string;data_root:string;
  config:string;postgres_dsn:string;cold_pin?:string;
  native_reference_targets?:{native_session_ids:string[];native_message_ids:string[]};
}
let stage='request';
async function run(request:Request){
  check(['preview','execute','prepare_backup'].includes(request.action),'RESET_ACTION_INVALID');
  const cutoff=new Date(request.cutoff).toISOString(),root=resolve(request.data_root),storageRoot=join(root,'central-storage');
  const config=await loadHostConfiguration(request.config) as {lock_file:string;archive_tiering?:{cold?:ColdConfig};max_event_bytes?:number};
  const writable=request.action!=='preview';
  // Preview takes no admission lock and never creates or changes a store.
  // Offline apply claims the same lock as the runtime in its network namespace.
  check(typeof config.lock_file==='string','RESET_CONFIG_LOCK_REQUIRED');
  const release=writable?await acquireProcessLock(config.lock_file):undefined;
  const storage=new PosixStorage(storageRoot,{read_only:!writable,...(config.archive_tiering?.cold?{cold:config.archive_tiering.cold}:{})});
  let pool:import('pg').Pool|undefined;
  try{
    const archive=new RawArchive(storage,config.max_event_bytes??67108864);
    if(request.action==='prepare_backup'){
      stage='cold_backup';check(request.cold_pin,'RESET_BACKUP_PIN_REQUIRED');
      return await archive.retainBackupDependencies(request.cold_pin!);
    }
    if(request.cold_pin){
      stage='cold_backup_pin';
      const pin=JSON.parse(Buffer.from(await storage.read('backup-dependencies',request.cold_pin)).toString());
      check(Array.isArray(pin.dependency_packs),'RESET_BACKUP_PIN_INVALID');
    }
    stage='archive_inventory';const raw=await planArchiveConversationReset(storage,cutoff);
    const options={storage_root:storageRoot,storage,cutoff,known_raw_refs:raw.known_sources,
      removed_raw_refs:raw.targets.map(t=>t.raw_ref),selected_records:raw.selected_records};
    stage='integration_inventory';const derived=await resetIntegrationConversation(options);
    const corpus=await resetTurnCorpus(join(root,'state','call-turns'),cutoff);
    stage='postgres_inventory';
    const {Pool}=createRequire(new URL('../../platform-data/package.json',import.meta.url))('pg');
    pool=new Pool({connectionString:request.postgres_dsn,max:1,connectionTimeoutMillis:5000,
      application_name:'paios-offline-conversation-reset'});
    const postgres=await resetPostgresConversations(pool!,{cutoff});
    const references=await inspectPostgresConversationReferences(pool!,{
      raw_refs:raw.targets.map(t=>t.raw_ref),processed_event_ids:derived.removed_processed_events.map(t=>t.processed_event_id),
      event_ids:[],native_session_ids:request.native_reference_targets?.native_session_ids??[],
      native_message_ids:request.native_reference_targets?.native_message_ids??[]},cutoff);
    const blockers=[...corpus.blockers,...derived.blockers,...(derived.blocked_raw_refs.length?['new_processed_event_uses_old_source']:[]),
      ...(raw.crossing_sources.length?['immutable_source_crosses_cutoff']:[]),
      ...(raw.unknown_sources?['source_creation_time_unknown']:[])];
    const packs=await storage.cold?.packs(true)??[];
    const report={archive:{deleted:raw.deleted,kept:raw.kept,categories:raw.categories,
      crossing_sources:raw.crossing_sources.length,unknown_sources:raw.unknown_sources,
      cold_backup_retention:{delete_count:0,delete_bytes:0,keep_count:packs.length,keep_bytes:packs.reduce((n,p)=>n+p.size,0)}},
      integration:{categories:[...derived.categories,corpus.category],blocked_sources:derived.blocked_raw_refs.length},postgres,references,blockers};
    if(request.action==='execute'){
      check(!blockers.length,'RESET_CUTOFF_CROSSING_SOURCE');
      stage='cold_backup_pin';check(request.cold_pin,'RESET_BACKUP_PIN_REQUIRED');
      stage='postgres_apply';await resetPostgresConversations(pool!,{cutoff,execute:true});
      stage='integration_apply';await resetIntegrationConversation({...options,apply:true});
      stage='legacy_corpus_apply';await resetTurnCorpus(join(root,'state','call-turns'),cutoff,true);
      stage='archive_apply';await executeArchiveConversationReset(archive,raw);
    }
    return report;
  }finally{await pool?.end();await storage.close();await release?.();}
}
try{
  let input='';for await(const part of process.stdin)input+=part;
  const result=await run(JSON.parse(input));process.stdout.write(JSON.stringify(result)+'\n');
}catch{
  process.stdout.write(JSON.stringify({stage,code:'RESET_WORKER_FAILED'})+'\n');process.exitCode=1;
}
