import type { Pool, PoolClient } from 'pg';
import { withTransaction } from './transaction.ts';

export interface AvatarProfileRecord {
  principal_id:string; version:number; active:unknown|null; active_avatar_id:string|null; requested_command:string|null;
  recent_versions?:{version:number;profile:unknown|null;avatar_id:string|null}[];
  loaded_receipts?:{device_id:string;device_type:string;profile_version:number;loaded_at:string}[];
}
export interface AvatarCommandRecord {
  principal_id:string; command_id:string; device_id:string; expected_version:number; look:unknown;
  state:'queued'|'submitting'|'pending'|'ready'|'failed'|'submission_uncertain'|'superseded';
  avatar_id:string|null; error:string|null; created_at:string; owner_request:string; submission_started_at?:string;
  cancelled_at?:string;reuse_version?:number;
}
export interface AvatarProfileTransaction {
  profile:AvatarProfileRecord;
  command(id:string):Promise<AvatarCommandRecord|null>;
  saveCommand(command:AvatarCommandRecord):Promise<void>;
  creationBusy():Promise<boolean>;
}
/** PostgreSQL owns both the current projection and durable external submission intent. */
export class AvatarProfileRepository {
  readonly pool:Pool;
  constructor(pool:Pool) {this.pool=pool;}
  async read(principal:string):Promise<AvatarProfileRecord|null> {
    const result=await this.pool.query('SELECT record FROM avatar_profiles WHERE principal_id=$1',[principal]);
    return result.rows[0]?.record??null;
  }
  async outstanding():Promise<{principal_id:string;command_id:string}[]> {
    const result=await this.pool.query("SELECT principal_id,command_id FROM avatar_profile_commands WHERE state IN ('queued','submitting','pending') OR (state='failed' AND record->>'error'='processing_timeout') ORDER BY created_at");
    return result.rows;
  }
  async transact<T>(principal:string, work:(tx:AvatarProfileTransaction)=>Promise<T>):Promise<T> {
    return withTransaction(this.pool,async(client:PoolClient)=>{
      // Global admission also serializes the single account-wide asset creation budget.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('paios.avatar-profile',0))");
      const result=await client.query('SELECT record FROM avatar_profiles WHERE principal_id=$1 FOR UPDATE',[principal]);
      const profile:AvatarProfileRecord=result.rows[0]?.record??{
        principal_id:principal,version:0,active:null,active_avatar_id:null,requested_command:null,
      };
      const tx:AvatarProfileTransaction={profile,
        command:async id=>{
          const found=await client.query('SELECT record FROM avatar_profile_commands WHERE principal_id=$1 AND command_id=$2',[principal,id]);
          return found.rows[0]?.record??null;
        },
        saveCommand:async command=>{
          await client.query(`INSERT INTO avatar_profile_commands(principal_id,command_id,state,created_at,record)
            VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(principal_id,command_id)
            DO UPDATE SET state=EXCLUDED.state,record=EXCLUDED.record`,
            [principal,command.command_id,command.state,command.created_at,JSON.stringify(command)]);
        },
        creationBusy:async()=>{
          const found=await client.query("SELECT 1 FROM avatar_profile_commands WHERE state IN ('submitting','pending','submission_uncertain') OR (state='failed' AND record->>'error'='processing_timeout') LIMIT 1");
          return found.rowCount!==0;
        },
      };
      const output=await work(tx);
      await client.query(`INSERT INTO avatar_profiles(principal_id,record) VALUES($1,$2::jsonb)
        ON CONFLICT(principal_id) DO UPDATE SET record=EXCLUDED.record`,[principal,JSON.stringify(profile)]);
      return output;
    });
  }
}
