import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import type {PoolClient} from "pg";

/** T02 version-bound object scope. It never applies a migration or invents a migration ledger. */
export const PREVIOUS_BACKUP_MIGRATION_HEAD = "0011_device_lease_renewal" as const;
export const CURRENT_BACKUP_MIGRATION_HEAD = "0012_l3_payload_audit_split" as const;
export const BACKUP_MIGRATION_SHA256: Readonly<Record<string,string>> = Object.freeze({
 "0018_l3_forget_dependency_closure": "7beb97ce1fa4cf7262c6c1b88b142e578ca43253110bbc55d84760034fd39c00",
 "0001_idempotency_outbox": "6f46228ddf6a04e228d85dcd6608cc2f02f3c2a522548b9084e61a3cc309cee9",
 "0002_realtime_authority": "cffce1247115bc8ab179ef23362d455a88432209b61ecf2635b8c16e01a3556c",
 "0003_memory_authority": "3bb9add5ceafbb0cad465e8d9ffd998d717cae0d2e2d2c36c346351d61e9814c",
 "0004_memory_append_only_lifecycle": "b8a24c824ebba04aab69f83ac61b467cbb5626af57454d413268737cb85edbe4",
 "0005_apple_physical_canary_binding": "a69668e729e8d7f584b33375bf4dda8c39ef9fd362a8539ffa553c3b79fc9e74",
 "0006_accepted_activity_stream": "b4b817727f178ef70fdd2dd3246e7bc17b38c97738f2689bb7ad55dd9e74cc43",
 "0007_t04_accepted_user_activity_event": "4de35ab0cbc542fab4e63397cd898899e6edae1d2cd0b857d2d1a01949e38718",
 "0008_realtime_credential_fence": "779653195e834c503433581519c589f4d7defb6f63d87e5c352d30484c5ce37b",
 "0009_hermes_l3": "b285148d4c4d2a09bfcc74bafeeb9567d28564643a3b8d1307dae987184e7a21",
 "0010_formal_watch_binding": "e0391d566c15eceebd466186c2e8251d27bfc31e0c58f302d2f0b74f31f8e062",
 "0012_l3_payload_audit_split": "1fb3e74454e712efa953f324854903b9afcb632462814977386c29c05d6f2d8b",
 "0011_device_lease_renewal": "0f09d034277db308a80c6618cd4fce7b8a59753c6b50a75bd85033f24dcfea44"
});
export const L3_BACKUP_TABLES = Object.freeze([
 "paios_l3_dependencies", "paios_l3_heads", "paios_l3_invalidations", "paios_l3_receipts", "paios_l3_versions",
]);
export function isCurrentBackupHead(head:unknown) {return head===CURRENT_BACKUP_MIGRATION_HEAD || head===PREVIOUS_BACKUP_MIGRATION_HEAD;}
export function backupAuthorityScope(head: string, legacy: readonly string[], l3Namespace?: string | undefined) {
 if (head !== "0004_memory_append_only_lifecycle" && !isCurrentBackupHead(head))
   throw new Error("BACKUP_MIGRATION_UNSUPPORTED");
 const migrationSha256 = Object.freeze(Object.fromEntries(Object.entries(BACKUP_MIGRATION_SHA256)
   .filter(([name])=>name.slice(0,4) <= (head===CURRENT_BACKUP_MIGRATION_HEAD ? "0012" : head===PREVIOUS_BACKUP_MIGRATION_HEAD ? "0011" : "0004"))));
 if (!isCurrentBackupHead(head)) return Object.freeze({head,current:false as const,
   tables:Object.freeze([...legacy]),sequences:Object.freeze([] as string[]),
   namespaces:Object.freeze(["public"]),migrationSha256});
 if (!l3Namespace || !/^[a-z_][a-z0-9_]{0,62}$/u.test(l3Namespace))
   throw new Error("BACKUP_L3_NAMESPACE_REQUIRED");
 const qualify = (schema:string,name:string) => schema === "public" ? name : schema + "." + name;
 const tables = [...legacy,"apple_physical_canary_bindings",
   ...(head===CURRENT_BACKUP_MIGRATION_HEAD ? [...L3_BACKUP_TABLES,"paios_l3_payloads","paios_l3_forgotten"] : L3_BACKUP_TABLES).map(name=>qualify(l3Namespace,name))].sort();
 const sequences = ["outbox_events_accepted_activity_cursor_seq",qualify(l3Namespace,"paios_l3_watermark")].sort();
 const namespaces = l3Namespace !== "public" ? ["public",l3Namespace] : ["public"];
 return Object.freeze({head,l3Namespace,current:true as const,tables:Object.freeze(tables),sequences:Object.freeze(sequences),
   namespaces:Object.freeze(namespaces),migrationSha256});
}
export function backupRelationSql(name:string) {
 if (!/^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?$/u.test(name)) throw new Error("BACKUP_RELATION_INVALID");
 return name.includes(".") ? name : "public." + name;
}
export async function verifyBackupMigrationSources(scope:ReturnType<typeof backupAuthorityScope>) {
 for (const [name,hash] of Object.entries(scope.migrationSha256)) {
   const bytes=await readFile(new URL(`../../../migrations/${name}.up.sql`,import.meta.url));
   if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error("BACKUP_MIGRATION_SOURCE_DRIFT");
 }
}
export async function verifyBackupSequenceScope(client:PoolClient,scope:ReturnType<typeof backupAuthorityScope>) {
 const result=await client.query(`SELECT n.nspname AS schema_name,c.relname AS sequence_name FROM pg_catalog.pg_class c
   JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) AND c.relkind='S'
   ORDER BY n.nspname,c.relname`,[scope.namespaces]);
 const actual=result.rows.map(r=>r.schema_name==="public"?String(r.sequence_name):r.schema_name+"."+r.sequence_name).sort();
 if (scope.current && JSON.stringify(actual)!==JSON.stringify(scope.sequences)) throw new Error("BACKUP_SEQUENCE_SCOPE_MISMATCH");
 const l3=await client.query(`SELECT n.nspname AS namespace,c.relname AS name FROM pg_catalog.pg_class c
   JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.relname=ANY($1::text[]) AND c.relkind IN ('r','p','S')
   AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'`,[[...L3_BACKUP_TABLES,"paios_l3_payloads","paios_l3_forgotten","paios_l3_watermark"]]);
 if (scope.head===PREVIOUS_BACKUP_MIGRATION_HEAD && l3.rows.some(r=>['paios_l3_payloads','paios_l3_forgotten'].includes(r.name)))
   throw new Error('BACKUP_PAYLOAD_SCOPE_OMITTED');
 if (!scope.current && l3.rows.length) throw new Error("BACKUP_L3_SCOPE_OMITTED");
}
export const BACKUP_SEQUENCE_FINGERPRINT_COMPONENTS = ` UNION ALL
 SELECT format('sequence|%s|%s|%s|%s|%s|%s|%s|%s',n.nspname,c.relname,s.seqtypid::regtype,
   s.seqstart,s.seqincrement,s.seqmax,s.seqmin,s.seqcache)||'|'||s.seqcycle FROM pg_catalog.pg_sequence s
 JOIN pg_catalog.pg_class c ON c.oid=s.seqrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[])
 UNION ALL SELECT 'trigger|'||n.nspname||'|'||c.relname||'|'||pg_get_triggerdef(t.oid,true)
 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=ANY($1::text[]) AND NOT t.tgisinternal
 UNION ALL SELECT 'function|'||n.nspname||'|'||p.proname||'|'||encode(convert_to(pg_get_functiondef(p.oid),'UTF8'),'hex')
 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname=ANY($1::text[]) AND p.proname='paios_l3_immutable_guard'`;
