import { PHONE_CAPABILITIES, GLASSES_CAPABILITIES, terminalCapabilities, type TerminalCapability } from '../../../services/personal-aios-integration/src/source-authority.ts';
import { assertCanonicalLiveKitCloudProjectUrl } from './livekit-cloud-token-signer.ts';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { createPostgresPool } from '../../../services/platform-data/src/postgres-pool.ts';
import type { RealtimeIdentityPort } from '../../../services/realtime-core/src/ports.ts';
import { DEVICE_SESSION_PURPOSE, PairedDeviceAuthorityError, wireGovernanceOf } from './paired-device-authority.ts';
import type { JsonRecord } from './realtime-public-control-runtime.ts';

/** What the phone imports once: bearer token, device id and the wire governance it sends with each operation. */
export const DEVICE_PAIRING_SCHEMA = 'paios.device-pairing.v1' as const;
// Video is the call camera (the phone publishes it only during a video call).

type Pool = ReturnType<typeof createPostgresPool>;
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const fail = (code: string): never => { throw new PairedDeviceAuthorityError(code, 422); };
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item !== null && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, (item as JsonRecord)[key]])) : item);

type ExchangeReceipt = {registration: JsonRecord; phone_device_id: string; expires_at: string};
const macProofHash = (proof: {nonce: string; pollToken: string}) => sha256(canonical(proof));
const mediaFor = (capabilities:readonly TerminalCapability[]) => ['data',...(capabilities.includes('microphone')?['audio']:[]),...(capabilities.includes('camera')?['video']:[])];

export interface DevicePairing {
  readonly schema: typeof DEVICE_PAIRING_SCHEMA;
  readonly origin: string;
  readonly device_id: string;
  readonly device_type?: 'glasses'|'mac';
  readonly capabilities?: readonly TerminalCapability[];
  readonly user_id: string;
  readonly token: string;
  readonly governance: JsonRecord;
  readonly media: readonly string[];
  readonly paired_at: string;
}

/** Registration and capability reissuance share one canonical grant and reference issuer. */
export function issueDeviceGovernance(input: {
  identity: Pick<RealtimeIdentityPort, 'createConnectionId'>; userId:string; deviceId:string;
  deviceType:'phone'|'glasses'|'mac'; publicKeySha256:string; capabilities:readonly TerminalCapability[];
  pairedAt:string; version?:number;
}): {governance:JsonRecord;media:string[]} {
  const media = mediaFor(input.capabilities);
  const version=input.version??1;
  const statement=canonical({schema:DEVICE_PAIRING_SCHEMA,user_id:input.userId,device_id:input.deviceId,
    device_class:input.deviceType==='phone'?'iphone':input.deviceType,capabilities:input.capabilities,
    public_key_sha256:input.publicKeySha256,media,purpose:DEVICE_SESSION_PURPOSE,paired_at:input.pairedAt,
    ...(version===1?{}:{grant_version:version})});
  const ref=(refType:string)=>({ref_type:refType,ref_id:input.identity.createConnectionId({deviceId:input.deviceId,
    requestId:version===1?refType:`${refType}.${version}`}),object_version:String(version),canonical_payload_sha256:sha256(statement)});
  return {media,governance:{device_type:input.deviceType,terminal_capabilities:input.capabilities,purpose_scopes:[DEVICE_SESSION_PURPOSE],
    consent_record_refs:[ref('ConsentRecord')],policy_decision_refs:[ref('PolicyDecision')],
    purpose_token_refs:[ref('PurposeToken')],capability_grant_refs:[ref('CapabilityGrant')]}};
}

/** Validate terminal registration against the shared capability authority. */
export function parseDeviceRegistration(bytes: Uint8Array): { readonly publicKey: string; readonly publicKeySha256: string; readonly deviceType: 'phone'|'glasses'|'mac'; readonly capabilities: readonly TerminalCapability[]; readonly label?: string } {
  let value: JsonRecord;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')) as JsonRecord; } catch { return fail('DEVICE_REGISTRATION_INVALID'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('DEVICE_REGISTRATION_INVALID');
  const publicKey = value.public_raw32_base64url, digest = value.public_sha256;
  if (typeof publicKey !== 'string' || typeof digest !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(publicKey)) fail('DEVICE_REGISTRATION_INVALID');
  const raw = Buffer.from(publicKey as string, 'base64url');
  if (raw.byteLength !== 32 || raw.toString('base64url') !== publicKey || sha256(raw) !== digest) fail('DEVICE_REGISTRATION_KEY_INVALID');
  const deviceType = value.device_type === undefined ? 'phone' : value.device_type;
  if (deviceType !== 'phone' && deviceType !== 'glasses' && deviceType !== 'mac') fail('DEVICE_REGISTRATION_TYPE_INVALID');
  const capabilities = terminalCapabilities({device_type:deviceType as string, capabilities:(Object.hasOwn(value,'capabilities') ? value.capabilities :
    (deviceType === 'phone' ? PHONE_CAPABILITIES : deviceType === 'glasses' ? GLASSES_CAPABILITIES : undefined)) as TerminalCapability[]});
  if (deviceType === 'mac' && !['display','chat_ui','desktop_tools'].every(value => capabilities.includes(value as TerminalCapability))) fail('TERMINAL_CAPABILITY_DENIED');
  if (value.label !== undefined && (typeof value.label !== 'string' || [...value.label].length < 1 || [...value.label].length > 64 || /[\p{Cc}]/u.test(value.label))) fail('DEVICE_REGISTRATION_LABEL_INVALID');
  return Object.freeze({ ...(value.label === undefined ? {} : {label:value.label as string}), publicKey: publicKey as string, publicKeySha256: digest as string, deviceType:deviceType as 'phone'|'glasses'|'mac', capabilities });
}

/**
 * Pair a terminal: mint its device id, credential ref, governance refs and bearer token. Revoke only the
 * previous phone or the same terminal public key and insert the new row in one transaction. The owner identity is stable across
 * re-pairing so sessions, memory and audit stay with one user.
 */
export async function pairDevice(input: {
  readonly pool: Pool;
  readonly identity: Pick<RealtimeIdentityPort, 'createConnectionId'>;
  readonly registration: Uint8Array;
  /** The installation's existing owner identity; used only by the first pairing, and must match afterwards. */
  readonly ownerUserId?: string;
  readonly origin: string;
  readonly now?: () => number;
  readonly artifactDirectory?: string;
  /** Consumed under the pairing lock in the same transaction as the new terminal. */
  readonly enrollmentToken?: string;
  readonly enrollmentClass?: 'glasses'|'mac';
  readonly macPairing?: {readonly nonce:string;readonly pollToken:string};
}): Promise<DevicePairing> {
  const origin = input.origin;
  if (typeof origin !== 'string' || !origin.startsWith('https://')) fail('DEVICE_PAIRING_ORIGIN_INVALID');
  assertCanonicalLiveKitCloudProjectUrl(origin.replace(/^https:/u, 'wss:'));
  const key = parseDeviceRegistration(input.registration);
  if (input.enrollmentToken !== undefined) {
    const enrolledClass = input.enrollmentClass ?? 'glasses';
    if (key.deviceType !== enrolledClass) fail('DEVICE_REGISTRATION_TYPE_MISMATCH');
    if (!/^[A-Za-z0-9_-]{43}$/u.test(input.enrollmentToken)) fail(`${enrolledClass.toUpperCase()}_ENROLLMENT_INVALID`);
  }
  if (input.macPairing && key.deviceType !== 'mac') fail('DEVICE_REGISTRATION_TYPE_MISMATCH');
  const deviceClass = key.deviceType === 'phone' ? 'iphone' : key.deviceType;
  const media = mediaFor(key.capabilities);
  const pairedAt = new Date((input.now ?? Date.now)()).toISOString();
  const client = await input.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('paios.paired-device-enrollment', 0))");
    const active = await client.query("SELECT device_id::text, user_id::text, device_class, token_sha256, governance FROM paired_devices WHERE recipient_public_key_sha256 = $1 AND status = 'active' FOR UPDATE", [key.publicKeySha256]);
    const previous = active.rows[0];
    const proofHash = input.macPairing ? macProofHash(input.macPairing) : input.enrollmentToken === undefined ? undefined : sha256(input.enrollmentToken);
    const denied = () => new PairedDeviceAuthorityError(input.macPairing ? 'MAC_PAIRING_EXPIRED_OR_USED' : `${(input.enrollmentClass ?? 'glasses').toUpperCase()}_ENROLLMENT_EXPIRED_OR_USED`, 403);
    const receipts = (previous?.governance as JsonRecord | undefined)?.pairing_exchange_receipts as Record<string, ExchangeReceipt> | undefined;
    const savedPairing = (row: NonNullable<typeof previous>, userId: string): DevicePairing => {
      const directory = input.artifactDirectory ?? fail('DEVICE_PAIRING_ARTIFACT_REQUIRED');
      const saved = JSON.parse(readFileSync(join(directory, `${key.deviceType}-pairing.${row.device_id}.v1.json`), 'utf8')) as DevicePairing;
      if (saved.device_id !== row.device_id || saved.user_id !== userId || sha256(saved.token) !== row.token_sha256) fail('DEVICE_PAIRING_ARTIFACT_MISMATCH');
      const governance=row.governance as JsonRecord;
      const capabilities=terminalCapabilities({device_type:key.deviceType,capabilities:governance.terminal_capabilities as TerminalCapability[]|undefined});
      return Object.freeze({...saved,origin,governance:wireGovernanceOf(governance),
        ...(key.deviceType==='phone'?{}:{capabilities}),
        media:mediaFor(capabilities)});
    };
    const receipt = proofHash === undefined ? undefined : receipts?.[proofHash];
    if (receipt) {
      if (previous!.device_class !== deviceClass || canonical(receipt.registration) !== canonical(JSON.parse(Buffer.from(input.registration).toString('utf8'))) ||
        Date.parse(receipt.expires_at) <= (input.now ?? Date.now)()) throw denied();
      const phone = await client.query("SELECT user_id::text FROM paired_devices WHERE device_id = $1 AND status = 'active' AND device_class = 'iphone' FOR UPDATE", [receipt.phone_device_id]);
      if (phone.rows.length !== 1 || phone.rows[0]!.user_id !== previous!.user_id || Date.parse(receipt.expires_at) <= (input.now ?? Date.now)()) throw denied();
      if (input.ownerUserId !== undefined && input.ownerUserId !== previous!.user_id) fail('PAIRED_DEVICE_OWNER_MISMATCH');
      const saved = savedPairing(previous!, String(previous!.user_id));
      await client.query('COMMIT');
      return saved;
    }
    let enrollmentOwner: string | undefined, consumed: ExchangeReceipt | undefined;
    const recordReceipt = async (deviceId: string) => {
      if (proofHash === undefined || !consumed) return;
      const current = Object.fromEntries(Object.entries(deviceId === previous?.device_id ? receipts ?? {} : {}).filter(([, value]) => Date.parse(value.expires_at) > (input.now ?? Date.now)()));
      await client.query("UPDATE paired_devices SET governance = jsonb_set(governance, '{pairing_exchange_receipts}', $2::jsonb) WHERE device_id = $1", [deviceId, JSON.stringify({...current, [proofHash]: consumed})]);
    };
    if (input.enrollmentToken !== undefined) {
      const enrolledClass = input.enrollmentClass ?? 'glasses', prefix = enrolledClass.toUpperCase();
      const grant = await client.query("SELECT p.user_id::text, e.phone_device_id::text, e.expires_at FROM terminal_enrollments e JOIN paired_devices p ON e.phone_device_id = p.device_id WHERE e.token_sha256 = $1 " +
        "AND e.device_class = $3 AND p.status = 'active' AND p.device_class = 'iphone' AND e.expires_at > $2 FOR UPDATE OF e, p", [sha256(input.enrollmentToken), new Date((input.now ?? Date.now)()).toISOString(), enrolledClass]);
      if (grant.rows.length !== 1) throw new PairedDeviceAuthorityError(`${prefix}_ENROLLMENT_EXPIRED_OR_USED`, 403);
      enrollmentOwner = String(grant.rows[0]!.user_id);
      if (Date.parse(String(grant.rows[0]!.expires_at)) <= (input.now ?? Date.now)()) throw denied();
      consumed = {registration:JSON.parse(Buffer.from(input.registration).toString('utf8')), phone_device_id:String(grant.rows[0]!.phone_device_id), expires_at:new Date(grant.rows[0]!.expires_at as string).toISOString()};
      await client.query('DELETE FROM terminal_enrollments WHERE token_sha256 = $1', [sha256(input.enrollmentToken)]);
    }
    if (input.macPairing) {
      const request = await client.query("SELECT p.user_id::text, r.expires_at, r.phone_device_id::text FROM mac_pairing_requests r JOIN paired_devices p ON r.phone_device_id = p.device_id WHERE r.nonce_sha256 = $1 AND r.poll_token_sha256 = $2 " +
        "AND r.phone_device_id = p.device_id AND p.status = 'active' AND p.device_class = 'iphone' AND r.expires_at > $3 " +
        "AND r.registration = $4::jsonb FOR UPDATE OF r,p", [sha256(input.macPairing.nonce),sha256(input.macPairing.pollToken),new Date((input.now??Date.now)()).toISOString(),Buffer.from(input.registration).toString('utf8')]);
      if (request.rows.length !== 1) throw new PairedDeviceAuthorityError('MAC_PAIRING_EXPIRED_OR_USED',403);
      if(Date.parse(String(request.rows[0]!.expires_at)) <= (input.now??Date.now)())throw new PairedDeviceAuthorityError('MAC_PAIRING_EXPIRED_OR_USED',403);
      enrollmentOwner = String(request.rows[0]!.user_id);
      consumed = {registration:JSON.parse(Buffer.from(input.registration).toString('utf8')), phone_device_id:String(request.rows[0]!.phone_device_id), expires_at:new Date(request.rows[0]!.expires_at as string).toISOString()};
      await client.query('DELETE FROM mac_pairing_requests WHERE nonce_sha256 = $1',[sha256(input.macPairing.nonce)]);
    }
    const owner = await client.query('SELECT user_id::text FROM paired_devices ORDER BY paired_at LIMIT 1');
    const userId = owner.rows.length === 1 ? String((owner.rows[0] as JsonRecord).user_id)
      : input.ownerUserId ?? input.identity.createConnectionId({ deviceId: 'paios-owner', requestId: `owner.${pairedAt}` });
    if (input.ownerUserId !== undefined && userId !== input.ownerUserId) fail('PAIRED_DEVICE_OWNER_MISMATCH');
    if (enrollmentOwner !== undefined && userId !== enrollmentOwner) fail('PAIRED_DEVICE_OWNER_MISMATCH');
    if (active.rows.length === 1 && active.rows[0]!.device_class !== deviceClass) fail('DEVICE_REGISTRATION_TYPE_MISMATCH');
    if (!input.macPairing && input.artifactDirectory && active.rows.length === 1 && canonical((active.rows[0]!.governance as JsonRecord).terminal_capabilities) === canonical(key.capabilities)) {
      const saved = savedPairing(active.rows[0]!, userId);
      await recordReceipt(saved.device_id);
      await client.query('COMMIT');
      // Origin is transport metadata; the existing device, user and token remain authoritative.
      return Object.freeze({...saved, origin});
    }
    const deviceId = input.identity.createConnectionId({ deviceId: userId, requestId: `terminal.${key.publicKeySha256}.${pairedAt}` });
    const issued=issueDeviceGovernance({identity:input.identity,userId,deviceId,deviceType:key.deviceType,
      publicKeySha256:key.publicKeySha256,capabilities:key.capabilities,pairedAt});
    const governance = {...issued.governance,...(input.macPairing ? {mac_pairing_nonce_sha256:sha256(input.macPairing.nonce)} : {})};
    const deviceCredentialRef = Object.freeze({ ref_type: 'DeviceCredential', ref_id: input.identity.createConnectionId({ deviceId, requestId: 'DeviceCredential' }),
      object_version: '1', canonical_payload_sha256: key.publicKeySha256 });
    const token = randomBytes(32).toString('base64url');
    const revoked = await client.query("UPDATE paired_devices SET status = 'revoked', revoked_at = $2 WHERE user_id = $1 AND status = 'active' AND (recipient_public_key_sha256 = $3 OR ($4 = 'iphone' AND device_class = 'iphone')) RETURNING device_id::text",
      [userId, pairedAt, key.publicKeySha256, deviceClass]);
    await client.query(
      'INSERT INTO paired_devices (device_id, user_id, device_class, token_sha256, recipient_public_key, recipient_public_key_sha256, ' +
      "device_credential_ref, media, governance, status, paired_at, label) VALUES ($1, $2, $10, $3, $4, $5, $6, $7, $8, 'active', $9, $11)",
      [deviceId, userId, sha256(token), key.publicKey, key.publicKeySha256, JSON.stringify(deviceCredentialRef), media,
        JSON.stringify(governance), pairedAt, deviceClass, key.label ?? null]);
    for (const row of revoked.rows) await client.query("SELECT pg_notify('paired_device_revoked', $1)", [String(row.device_id)]);
    const pairing: DevicePairing = Object.freeze({ schema: DEVICE_PAIRING_SCHEMA, origin, device_id: deviceId, ...(key.deviceType !== 'phone' ? {device_type:key.deviceType,capabilities:key.capabilities} : {}), user_id: userId, token,
      governance: wireGovernanceOf(governance), media: Object.freeze(media), paired_at: pairedAt });
    if (input.artifactDirectory) {
      const path = join(input.artifactDirectory, `${pairing.device_type ?? 'phone'}-pairing.${deviceId}.v1.json`);
      const next = `${path}.next`, file = openSync(next, 'wx', 0o600);
      try { writeFileSync(file, JSON.stringify(pairing) + '\n'); fsyncSync(file); } finally { closeSync(file); }
      renameSync(next, path);
      const directory = openSync(input.artifactDirectory, 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    await recordReceipt(deviceId);
    await client.query('COMMIT');
    return pairing;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Class-bound QR capabilities authorize terminal registration; paired_devices remains the authority. */
export function createGlassesEnrollment(input: {pool: Pool; identity: Pick<RealtimeIdentityPort, 'createConnectionId'>;
  origin: string; artifactDirectory: string; activate: (deviceId: string) => Promise<void>; now?: () => number;
  verifyMacApproval?:(phone:{deviceId:string;userId:string},nonce:string,keyDigest:string,signed:JsonRecord)=>Promise<void>}) {
  return Object.freeze({
    ...createMacPairingRequests(input),
    issue: async (phoneToken: string, deviceClass: 'glasses'|'mac' = 'glasses') => {
      if(deviceClass==='mac')fail('MAC_REVERSE_PAIRING_REQUIRED');
      const token = randomBytes(32).toString('base64url'), expiresAt = new Date((input.now ?? Date.now)() + 300_000).toISOString();
      const grant = await input.pool.query("INSERT INTO terminal_enrollments (token_sha256, phone_device_id, expires_at, device_class) " +
        "SELECT $1, device_id, $3, $4 FROM paired_devices WHERE token_sha256 = $2 AND status = 'active' AND device_class = 'iphone' " +
        "ON CONFLICT (phone_device_id, device_class) DO UPDATE SET token_sha256 = EXCLUDED.token_sha256, expires_at = EXCLUDED.expires_at RETURNING phone_device_id", [sha256(token), sha256(phoneToken), expiresAt, deviceClass]);
      if (grant.rows.length !== 1) throw new PairedDeviceAuthorityError('PAIRED_PHONE_REQUIRED', 403);
      return {schema:`paios.${deviceClass}-enrollment.v1`, origin:input.origin, token, expires_at:expiresAt};
    },
    exchange: async (token: string, registration: JsonRecord, deviceClass: 'glasses'|'mac' = 'glasses') => {
      if(deviceClass==='mac')fail('MAC_REVERSE_PAIRING_REQUIRED');
      if (registration.device_type !== deviceClass) fail('DEVICE_REGISTRATION_TYPE_MISMATCH');
      const pairing = await pairDevice({...input, registration:Buffer.from(JSON.stringify(registration)), enrollmentToken:token, enrollmentClass:deviceClass});
      await input.activate(pairing.device_id);
      return pairing;
    },
  });
}

/** The installation owner revokes an exact paired terminal; existing source/E2EE guards observe this row immediately. */
export async function revokePairedDevice(input:{pool:Pool;deviceId:string;ownerUserId:string;now?:()=>number}):Promise<{status:'revoked';device_id:string}> {
  const result=await input.pool.query("WITH revoked AS (UPDATE paired_devices SET status = 'revoked', revoked_at = COALESCE(revoked_at,$3) " +
    "WHERE device_id = $1 AND user_id = $2 RETURNING device_id::text) SELECT device_id, pg_notify('paired_device_revoked', device_id) FROM revoked",[input.deviceId,input.ownerUserId,new Date((input.now??Date.now)()).toISOString()]);
  if(result.rows.length!==1) throw new PairedDeviceAuthorityError('PAIRED_DEVICE_REQUIRED',404);
  return Object.freeze({status:'revoked',device_id:String(result.rows[0].device_id)});
}

/** Short-lived requests bind one immutable Mac registration; paired_devices owns the resulting authority. */
function createMacPairingRequests(input: Parameters<typeof createGlassesEnrollment>[0]) {
  const time=()=>new Date((input.now??Date.now)()).toISOString();
  const token=(value:unknown):string=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/u.test(value))fail('MAC_PAIRING_INVALID');return value as string;};
  return {
    requestMac:async(registration:JsonRecord)=>{
      if(parseDeviceRegistration(Buffer.from(JSON.stringify(registration))).deviceType!=='mac')fail('DEVICE_REGISTRATION_TYPE_MISMATCH');
      const nonce=randomBytes(32).toString('base64url'),pollToken=randomBytes(32).toString('base64url');
      const expiresAt=new Date((input.now??Date.now)()+300_000).toISOString();
      await input.pool.query('DELETE FROM mac_pairing_requests WHERE expires_at <= $1',[time()]);
      await input.pool.query('INSERT INTO mac_pairing_requests (nonce_sha256,poll_token_sha256,registration,expires_at) VALUES ($1,$2,$3,$4)',
        [sha256(nonce),sha256(pollToken),JSON.stringify(registration),expiresAt]);
      return {schema:'paios.mac-pairing-request.v1',origin:input.origin,nonce,poll_token:pollToken,expires_at:expiresAt,public_key_sha256:registration.public_sha256};
    },
    previewMac:async(phoneToken:string,nonce:unknown)=>{
      const nonceHash=sha256(token(nonce));
      const result=await input.pool.query(
        "SELECT r.registration->>'label' AS label,r.registration->>'public_sha256' AS public_key_sha256,r.expires_at," +
        "CASE WHEN r.phone_device_id IS NULL THEN 'pending' ELSE 'approved' END AS status " +
        "FROM mac_pairing_requests r CROSS JOIN paired_devices p WHERE r.nonce_sha256 = $1 AND r.expires_at > $2 " +
        "AND (r.phone_device_id IS NULL OR r.phone_device_id = p.device_id) AND p.token_sha256 = $3 " +
        "AND p.status = 'active' AND p.device_class = 'iphone' AND p.governance->'terminal_capabilities' ? 'owner_unlock' " +
        "UNION ALL SELECT m.label,m.recipient_public_key_sha256,m.paired_at + interval '5 minutes','connected' " +
        "FROM paired_devices m JOIN paired_devices p ON m.user_id = p.user_id " +
        "WHERE m.governance->>'mac_pairing_nonce_sha256' = $1 AND m.status = 'active' AND m.device_class = 'mac' " +
        "AND m.paired_at + interval '5 minutes' > $2 AND p.token_sha256 = $3 AND p.status = 'active' " +
        "AND p.device_class = 'iphone' AND p.governance->'terminal_capabilities' ? 'owner_unlock'",
        [nonceHash,time(),sha256(phoneToken)]);
      if(result.rows.length!==1)throw new PairedDeviceAuthorityError('MAC_PAIRING_EXPIRED_OR_USED',403);
      const row=result.rows[0]!;
      if(typeof row.label!=='string'||!row.label)throw new PairedDeviceAuthorityError('MAC_PAIRING_LABEL_REQUIRED',422);
      return {label:row.label,public_key_sha256:String(row.public_key_sha256),expires_at:new Date(row.expires_at as string).toISOString(),status:String(row.status)};
    },
    approveMac:async(phoneToken:string,nonce:unknown,signed:JsonRecord)=>{
      const nonceValue=token(nonce);
      const pending=await input.pool.query("SELECT r.registration,p.device_id::text,p.user_id::text FROM mac_pairing_requests r CROSS JOIN paired_devices p " +
        "WHERE r.nonce_sha256 = $1 AND r.expires_at > $2 AND r.phone_device_id IS NULL AND p.token_sha256 = $3 " +
        "AND p.status = 'active' AND p.device_class = 'iphone' AND p.governance->'terminal_capabilities' ? 'owner_unlock'",
        [sha256(nonceValue),time(),sha256(phoneToken)]);
      if(pending.rows.length!==1)throw new PairedDeviceAuthorityError('MAC_PAIRING_APPROVAL_DENIED',403);
      const row=pending.rows[0]!;
      if(!input.verifyMacApproval)throw new PairedDeviceAuthorityError('MAC_PAIRING_VERIFIER_UNAVAILABLE',503);
      await input.verifyMacApproval({deviceId:String(row.device_id),userId:String(row.user_id)},nonceValue,(row.registration as JsonRecord).public_sha256 as string,signed);
      const result=await input.pool.query("UPDATE mac_pairing_requests r SET phone_device_id = p.device_id FROM paired_devices p " +
        "WHERE r.nonce_sha256 = $1 AND r.expires_at > $2 AND r.phone_device_id IS NULL AND p.token_sha256 = $3 " +
        "AND p.status = 'active' AND p.device_class = 'iphone' RETURNING r.expires_at",[sha256(nonceValue),time(),sha256(phoneToken)]);
      if(result.rows.length!==1)throw new PairedDeviceAuthorityError('MAC_PAIRING_APPROVAL_DENIED',403);
      return {status:'approved'};
    },
    exchangeMac:async(nonce:unknown,pollToken:unknown)=>{
      const proof={nonce:token(nonce),pollToken:token(pollToken)};
      const result=await input.pool.query('SELECT registration,phone_device_id,expires_at FROM mac_pairing_requests WHERE nonce_sha256 = $1 AND poll_token_sha256 = $2 AND expires_at > $3',
        [sha256(proof.nonce),sha256(proof.pollToken),time()]);
      // The consumed request is gone; its exact proof can only retrieve its committed device.
      if(result.rows.length===0){
        const saved=await input.pool.query("SELECT governance->'pairing_exchange_receipts'->$1 AS receipt FROM paired_devices WHERE status = 'active' AND governance->'pairing_exchange_receipts' ? $1",[macProofHash(proof)]);
        if(saved.rows.length===1)result.rows.push(saved.rows[0]!.receipt as typeof result.rows[number]);
      }
      if(result.rows.length!==1 || Date.parse(String(result.rows[0]!.expires_at)) <= (input.now??Date.now)())throw new PairedDeviceAuthorityError('MAC_PAIRING_EXPIRED_OR_USED',403);
      const row=result.rows[0]!;
      if(row.phone_device_id===null)return {status:'pending' as const,expires_at:new Date(row.expires_at as string).toISOString()};
      const pairing=await pairDevice({...input,registration:Buffer.from(JSON.stringify(row.registration)),macPairing:proof});
      await input.activate(pairing.device_id);
      return pairing;
    },
  };
}
