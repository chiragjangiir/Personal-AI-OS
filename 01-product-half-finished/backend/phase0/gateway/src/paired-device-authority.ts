import { createHash, randomBytes } from 'node:crypto';
import type { CredentialFenceAdmissionClient } from '../../../services/platform-data/src/realtime-credential-fence.ts';
import { terminalCapabilities, type TerminalCapability } from '../../../services/personal-aios-integration/src/source-authority.ts';
import type { createPostgresPool } from '../../../services/platform-data/src/postgres-pool.ts';
import type { ActivityAcceptancePort, LeasePolicyDecision, LeasePolicyPort } from '../../../services/realtime-core/src/ports.ts';
import type { ProductionAuthorityFactoryResult } from '../../../services/realtime-core/src/production-authority-factory.ts';
import {
  assertCanonicalTimestamp,
  DEVICE_CLOCK_LEAD_MS,
  type AcceptedUserActivity,
  type CanonicalTimestamp,
  type CurrentBindingLookup,
  type OpaqueGovernanceValue,
  type RealtimeCurrentBindingProjection,
  type VerifiedActivityAcceptance,
} from '../../../services/realtime-core/src/types.ts';
import type { RecipientCredentialPort } from './realtime-e2ee-ciphertext-resolver.ts';
import type { PersistentPublicBearerAuthorityPort } from './realtime-public-control-persistent-public-ports.ts';
import type { JsonRecord, RealtimeBearerContext, RealtimeGovernanceDecision, RealtimeOperation } from './realtime-public-control-runtime.ts';
import type { T11bOwnerContext, T11bOwnerContextPort, T11bT03GovernancePort } from './realtime-public-control-t11b-t02-adapter.ts';

/** Lease purpose shared with existing T02 session rows and the Hermes source resolver. */
export const DEVICE_SESSION_PURPOSE = 'cycling_assistant' as const;
/** A lease spans one continuity, so an active device never needs out-of-band re-issuance. */
export const PAIRED_LEASE_MS = 24 * 60 * 60 * 1000;
const OPERATIONS: readonly RealtimeOperation[] = Object.freeze(['bootstrap', 'realtime_e2ee_key_resolve',
  'connected_credential_refresh', 'media_stop', 'end_continuity', 'handoff']);
const MEDIA = ['audio', 'video', 'data'] as const;
const START_SKEW_MS = 10 * 60 * 1000;

type Pool = ReturnType<typeof createPostgresPool>;
type CurrentBindingReader = ProductionAuthorityFactoryResult['readCurrentBinding'];

export class PairedDeviceAuthorityError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 403) { super(code); this.name = 'PairedDeviceAuthorityError'; this.code = code; this.status = status; }
}
const fail = (code: string, status?: number): never => { throw new PairedDeviceAuthorityError(code, status); };

export interface PairedDevice {
  readonly deviceId: string;
  readonly deviceType: 'phone'|'glasses'|'mac';
  readonly capabilities: readonly TerminalCapability[];
  readonly userId: string;
  readonly publicKey: string;
  readonly deviceCredentialRef: JsonRecord;
  readonly media: readonly string[];
  /** Full canonical refs minted at pairing; the wire form carries ref ids only. */
  readonly governance: JsonRecord;
  readonly pairedAt: string;
  readonly label?: string;
}

/** Read-only view for the Hermes source resolver and Watch primary checks. */
export interface DeviceAuthorityProjection {
  readonly recipientPublicKey?: string;
  readonly deviceType: 'phone'|'glasses'|'mac';
  readonly capabilities: readonly TerminalCapability[];
  readonly userId: string;
  readonly deviceId: string;
  readonly principal: string;
  readonly capabilityRef: OpaqueGovernanceValue;
  readonly allowedMediaCapabilities: readonly string[];
  readonly purpose: typeof DEVICE_SESSION_PURPOSE;
  readonly governance: OpaqueGovernanceValue;
  readonly policyDecisionRef: OpaqueGovernanceValue;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface DeviceAuthorityReadiness {
  readonly owner: 'paired-device-authority';
  readonly environment: 'production';
  readonly isReady: () => boolean;
  readonly current: () => Readonly<{ ready: boolean; bound: boolean; authorityReady: boolean; closed: boolean }>;
  readonly assertReady: () => void;
  readonly reason: string;
}

/** The single owner of device authority for public control, T02 leases, E2EE recipients and Hermes sources. */
export interface DeviceOwnerAuthority {
  readonly deviceId: string;
  readonly readCurrentAuthority: (atSystemTime?: string) => DeviceAuthorityProjection;
  readonly readActiveAuthority: () => Promise<DeviceAuthorityProjection>;
  readonly formalWatchPrimaryAuthority: { readonly resolve: (bearer: unknown, client?: CredentialFenceAdmissionClient) => Promise<Readonly<{ userId: string; deviceId: string;
    principalRef: unknown; expiresAt: string; purpose: string; policyDecisionRef: unknown; capabilities: readonly string[] }>> };
  readonly place: PairedPlaceAuthority;
  readonly bearer: PersistentPublicBearerAuthorityPort;
  readonly policy: Readonly<{ port: LeasePolicyPort; readiness: DeviceAuthorityReadiness }>;
  readonly activityAcceptance: Readonly<{ port: ActivityAcceptancePort; readiness: DeviceAuthorityReadiness }>;
  readonly recipientCredential: Readonly<{ port: RecipientCredentialPort; readiness: DeviceAuthorityReadiness }>;
  readonly deviceCredential: { readonly resolve: (input: { readonly bearer: RealtimeBearerContext }) => Promise<JsonRecord> };
  readonly governance: T11bT03GovernancePort & { readonly evaluate: (input: { readonly operation: RealtimeOperation;
    readonly request: JsonRecord; readonly bearer: RealtimeBearerContext }) => Promise<RealtimeGovernanceDecision> };
  readonly ownerContext: {resolve(input:Parameters<T11bOwnerContextPort['resolve']>[0],client?:CredentialFenceAdmissionClient):Promise<T11bOwnerContext>};
  readonly bindCurrentBinding: (reader: CurrentBindingReader) => void;
  readonly readiness: DeviceAuthorityReadiness;
  readonly close: () => Promise<void>;
}

export interface PairedPlaceAuthority {
  resolve(tokenSha256:string):Promise<DeviceAuthorityProjection|undefined>;
  credential(token:string,input:{device_id:string;action:'issue'|'rotate'|'revoke'}):Promise<JsonRecord>;
}
const tokenDigest = (token:string):string => createHash('sha256').update(token).digest('hex');

const isRecord = (value: unknown): value is JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => isRecord(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
const frozen = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Wire governance: the same refs by id, as clients send and T02 stores. */
export function wireGovernanceOf(governance: JsonRecord): JsonRecord {
  const id = (key: string): string => {
    const refs = governance[key];
    const ref = Array.isArray(refs) && refs.length === 1 && isRecord(refs[0]) ? refs[0].ref_id : undefined;
    return typeof ref === 'string' && ref.length > 0 ? ref : fail('PAIRED_DEVICE_GOVERNANCE_INVALID', 503);
  };
  return Object.freeze({ purpose_scopes: governance.purpose_scopes, consent_record_refs: [id('consent_record_refs')],
    policy_decision_refs: [id('policy_decision_refs')], purpose_token_refs: [id('purpose_token_refs')],
    capability_grant_refs: [id('capability_grant_refs')] });
}

/** Load a selected terminal. The legacy no-selector path requires one active phone. */
export async function readActivePairedDevice(pool: Pool, deviceId?: string): Promise<PairedDevice> {
  const devices = await readActivePairedDevices(pool);
  const selected = devices.filter(device => deviceId ? device.deviceId === deviceId : device.deviceType === 'phone');
  if (selected.length !== 1) fail(selected.length === 0 ? 'PAIRED_DEVICE_REQUIRED' : 'PAIRED_DEVICE_AMBIGUOUS', 503);
  return selected[0]!;
}
export async function readActivePairedDevices(pool: Pick<Pool,'query'>): Promise<readonly PairedDevice[]> {
  const result = await pool.query(
    "SELECT device_id::text, user_id::text, device_class, recipient_public_key, device_credential_ref, media, governance, paired_at, label " +
    "FROM paired_devices WHERE status = 'active' ORDER BY device_id");
  return Object.freeze(result.rows.map(row => {
    const governance = row.governance as JsonRecord;
    if (row.device_class !== undefined && row.device_class !== 'iphone' && row.device_class !== 'glasses' && row.device_class !== 'mac') fail('PAIRED_DEVICE_CLASS_INVALID',503);
    const deviceType = row.device_class === 'mac' ? 'mac' : row.device_class === 'glasses' ? 'glasses' : 'phone';
    if (deviceType !== 'phone' && governance.terminal_capabilities === undefined) fail('PAIRED_DEVICE_CAPABILITIES_REQUIRED',503);
    const capabilities = terminalCapabilities({device_type:deviceType,capabilities:governance.terminal_capabilities as TerminalCapability[]|undefined});
    return Object.freeze({ ...(row.label == null ? {} : {label:String(row.label)}), deviceType, capabilities, deviceId: String(row.device_id), userId: String(row.user_id), publicKey: String(row.recipient_public_key),
      deviceCredentialRef: frozen(row.device_credential_ref as JsonRecord), media: Object.freeze([...(row.media as string[])]),
      governance: frozen(governance), pairedAt: new Date(row.paired_at as string).toISOString() });
  }));
}

export async function createPairedDeviceAuthority(options: {
  readonly pool: Pool;
  readonly now?: () => number;
  readonly leaseMs?: number;
  readonly deviceId?: string;
}): Promise<DeviceOwnerAuthority> {
  const device = await readActivePairedDevice(options.pool, options.deviceId);
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? PAIRED_LEASE_MS;
  const wire = wireGovernanceOf(device.governance);
  const policyRef = (device.governance.policy_decision_refs as JsonRecord[])[0] as OpaqueGovernanceValue;
  const capabilityRef = (device.governance.capability_grant_refs as JsonRecord[])[0] as OpaqueGovernanceValue;
  const at = (ms: number): CanonicalTimestamp => assertCanonicalTimestamp(new Date(ms).toISOString());
  let reader: CurrentBindingReader | undefined;
  let closed = false;
  const assertActive = async (client:Pick<Pool,'query'> = options.pool):Promise<void> => {
    const result = await client.query("SELECT device_id::text FROM paired_devices WHERE device_id = $1 AND status = 'active'",[device.deviceId]);
    if (closed || result.rows.length !== 1 || String(result.rows[0].device_id) !== device.deviceId) fail('PAIRED_DEVICE_REVOKED');
  };

  const isReady = (): boolean => !closed && reader !== undefined;
  const readiness: DeviceAuthorityReadiness = Object.freeze({
    owner: 'paired-device-authority', environment: 'production', isReady,
    current: () => Object.freeze({ ready: isReady(), bound: reader !== undefined, authorityReady: !closed, closed }),
    assertReady: () => { if (!isReady()) fail('PAIRED_DEVICE_AUTHORITY_NOT_READY', 503); },
    reason: 'PAIRED_DEVICE_AUTHORITY_NOT_READY',
  });
  const assertBearer = (bearer: unknown): void => {
    if (!isRecord(bearer) || bearer.deviceId !== device.deviceId || bearer.principal !== device.userId) fail('PAIRED_DEVICE_BEARER_MISMATCH');
  };
  const requestedMedia = (request: JsonRecord): string[] | undefined => {
    const media = request.requested_media;
    return isRecord(media) ? MEDIA.filter((name) => media[name] === true) : undefined;
  };
  const decide = (operation: RealtimeOperation, request: JsonRecord, bearer: unknown): string | undefined => {
    if (closed) return 'PAIRED_DEVICE_AUTHORITY_CLOSED';
    if (!OPERATIONS.includes(operation)) return 'PAIRED_DEVICE_OPERATION_DENIED';
    if (!isRecord(bearer) || bearer.deviceId !== device.deviceId || bearer.principal !== device.userId) return 'PAIRED_DEVICE_BEARER_MISMATCH';
    if (!same(request.governance, wire)) return 'PAIRED_DEVICE_GOVERNANCE_MISMATCH';
    if (request.device_id !== undefined && request.device_id !== device.deviceId) return 'PAIRED_DEVICE_REQUEST_DEVICE_MISMATCH';
    if (operation === 'bootstrap') {
      const start = isRecord(request.start) ? request.start : undefined;
      const media = requestedMedia(request);
      if ((request.bootstrap_mode !== 'initial' && request.bootstrap_mode !== 'fully_disconnected') ||
          request.device_id !== device.deviceId || start?.device_id !== device.deviceId) return 'PAIRED_DEVICE_BOOTSTRAP_DENIED';
      if (media === undefined || !media.includes('data') || media.some((item) => !device.media.includes(item))) return 'PAIRED_DEVICE_MEDIA_DENIED';
    }
    return undefined;
  };
  const lookupOf = (request: JsonRecord): CurrentBindingLookup => {
    if (isRecord(request.realtime_session_ref)) return { realtimeSessionRef: request.realtime_session_ref as never };
    if (typeof request.continuity_id === 'string' && request.continuity_id.length > 0) return { continuityId: request.continuity_id };
    return fail('PAIRED_DEVICE_BINDING_LOOKUP_REQUIRED', 422);
  };
  /** The current PG binding must belong to the paired device and hold a live lease minted by this authority. */
  // Ownership always holds. Cleanup (stop, end continuity) is the owner's right to release what it holds: it needs
  // neither a usable lease nor an unexpired continuity — a Stop pressed after the continuity ran out must still clean
  // up — while bootstrap, refresh and key resolve (new media or credentials) keep both requirements.
  const readOwnedBinding = async (lookup: CurrentBindingLookup, cleanup = false): Promise<RealtimeCurrentBindingProjection> => {
    readiness.assertReady();
    const binding = await reader!(lookup);
    if (binding === undefined) fail('PAIRED_DEVICE_BINDING_MISSING');
    const { session, lease } = binding!;
    const nowMs = now();
    const leaseUsable = lease.state === 'active' && session.activeDeviceId === device.deviceId && nowMs < Date.parse(lease.expiresAt);
    if (session.state !== 'active' || session.continuityState !== 'active' || (!cleanup && !leaseUsable) ||
        session.userId !== device.userId || lease.userId !== device.userId ||
        lease.deviceId !== device.deviceId || session.binding.deviceId !== device.deviceId ||
        lease.purpose !== DEVICE_SESSION_PURPOSE || !same(lease.policyDecisionRef, policyRef) ||
        (!cleanup && nowMs >= Date.parse(session.continuityExpiresAt))) fail('PAIRED_DEVICE_BINDING_INVALID');
    return binding!;
  };
  const ownerContextValue = (occurredAt: CanonicalTimestamp, capabilities: readonly string[]): T11bOwnerContext => Object.freeze({
    userId: device.userId, deviceId: device.deviceId, purpose: DEVICE_SESSION_PURPOSE,
    capabilities: Object.freeze([...capabilities]), occurredAt });

  const projection = (): DeviceAuthorityProjection => Object.freeze({
    recipientPublicKey: device.publicKey,
    deviceType:device.deviceType, capabilities:device.capabilities,
    userId: device.userId, deviceId: device.deviceId, principal: device.userId, capabilityRef,
    allowedMediaCapabilities: device.media, purpose: DEVICE_SESSION_PURPOSE, governance: device.governance as OpaqueGovernanceValue,
    policyDecisionRef: policyRef, issuedAt: device.pairedAt, expiresAt: at(now() + leaseMs) });

  const policyPort: LeasePolicyPort = Object.freeze({
    evaluate: async (input: Parameters<LeasePolicyPort['evaluate']>[0]): Promise<LeasePolicyDecision> => {
      const occurredMs = Date.parse(input.occurredAt);
      const capabilities = MEDIA.filter((name) => input.capabilities.includes(name));
      if (closed || input.userId !== device.userId || input.deviceId !== device.deviceId || input.purpose !== DEVICE_SESSION_PURPOSE ||
          capabilities.length !== input.capabilities.length || !capabilities.includes('data') ||
          capabilities.some((item) => !device.media.includes(item)) || !same(input.governance, wire) ||
          !Number.isSafeInteger(occurredMs) || occurredMs > now() + DEVICE_CLOCK_LEAD_MS) fail('PAIRED_DEVICE_POLICY_DENIED');
      return Object.freeze({ allowed: true, policyDecisionRef: policyRef, capabilities: Object.freeze(capabilities), purpose: DEVICE_SESSION_PURPOSE,
        leaseExpiresAt: at(occurredMs + leaseMs), revocable: true });
    },
  });

  // Accepted activities are minted by the T04 owner, whose proof is its own ContextAssertion; this authority confirms
  // the paired user/device and echoes that proof. T02 calls verify inside its session-row transaction and checks the
  // binding itself, so verify must not read T02 state on another connection (that self-deadlocks on the row lock).
  const activityPort: ActivityAcceptancePort = Object.freeze({
    verify: async (activity: AcceptedUserActivity): Promise<VerifiedActivityAcceptance> => {
      const proof: unknown = isRecord(activity) ? activity.acceptanceRef : undefined;
      if (!isRecord(activity) || activity.kind !== 'accepted_user_activity' || activity.accepted !== true ||
          activity.userId !== device.userId || activity.deviceId !== device.deviceId || !isRecord(proof) ||
          proof.ref_type !== 'ContextAssertion' || typeof proof.ref_id !== 'string' ||
          Date.parse(activity.occurredAt) > now() + DEVICE_CLOCK_LEAD_MS) fail('PAIRED_DEVICE_ACTIVITY_INVALID');
      return Object.freeze({ verified: true, acceptanceRef: frozen(activity.acceptanceRef), acceptedAt: activity.occurredAt,
        authorityWatermark: frozen(policyRef) });
    },
  });

  const recipientPort: RecipientCredentialPort = Object.freeze({
    resolve: async (input: Parameters<NonNullable<RecipientCredentialPort['resolve']>>[0]) => {
      if (closed || input.deviceId !== device.deviceId || !same(input.credentialRef, device.deviceCredentialRef)) return undefined;
      await assertActive();
      return Object.freeze({ publicKey: Buffer.from(device.publicKey, 'base64url'), status: 'active' as const,
        expiresAt: at(now() + leaseMs), deviceId: device.deviceId, credentialRef: frozen(device.deviceCredentialRef) });
    },
  });

  const bearer: PersistentPublicBearerAuthorityPort = Object.freeze({
    isReady: () => !closed,
    resolve: async ({ tokenSha256,operation }: { tokenSha256: string; operation: RealtimeOperation }) => {
      if (closed) return undefined;
      const result = await options.pool.query(
        (operation==='place_upload'?"SELECT device_id::text FROM paired_devices WHERE place_token_sha256 = $1 AND status = 'active' AND device_class = 'iphone'":"SELECT device_id::text FROM paired_devices WHERE token_sha256 = $1 AND status = 'active'"), [tokenSha256]);
      if (result.rows.length !== 1 || (result.rows[0] as { device_id: string }).device_id !== device.deviceId) return undefined;
      return Object.freeze({ tokenSha256, principal: device.userId, deviceId: device.deviceId, capabilityRef: frozen(capabilityRef),
        expiresAt: at(now() + leaseMs), scopes: operation==='place_upload'?Object.freeze(['place_upload'] as const):OPERATIONS });
    },
  });

  return Object.freeze({
    deviceId: device.deviceId,
    place: Object.freeze({
      resolve: async (tokenSha256:string) => {
        if(closed || device.deviceType!=='phone')return undefined;
        return await bearer.resolve({tokenSha256,operation:'place_upload'}) ? projection() : undefined;
      },
      credential: async (token:string,input:{device_id:string;action:'issue'|'rotate'|'revoke'}) => {
        if(closed || device.deviceType!=='phone' || input.device_id!==device.deviceId)fail('PLACE_CREDENTIAL_DENIED',403);
        if(!await bearer.resolve({tokenSha256:tokenDigest(token),operation:'bootstrap'}))fail('PLACE_CREDENTIAL_DENIED',403);
        const issued=input.action==='revoke'?undefined:randomBytes(32).toString('base64url');
        const result=await options.pool.query("UPDATE paired_devices SET place_token_sha256 = $3 WHERE device_id = $1 AND token_sha256 = $2 AND status = 'active' AND device_class = 'iphone' " +
          (input.action==='issue'?"AND place_token_sha256 IS NULL ":'') + "RETURNING device_id::text",[device.deviceId,tokenDigest(token),issued?tokenDigest(issued):null]);
        if(result.rows.length!==1)fail('PLACE_CREDENTIAL_DENIED',403);
        return {schema:'paios.place-credential.v1',device_id:device.deviceId,scope:'place_upload',...(issued?{token:issued}:{revoked:true})};
      },
    }),
    readCurrentAuthority: () => projection(),
    readActiveAuthority: async () => {await assertActive();return projection();},
    formalWatchPrimaryAuthority: Object.freeze({
      resolve: async (authenticated: unknown, client?:CredentialFenceAdmissionClient) => {
        assertBearer(authenticated);
        await assertActive(client);
        return Object.freeze({ userId: device.userId, deviceId: device.deviceId, principalRef: device.userId,
          expiresAt: at(now() + leaseMs), purpose: DEVICE_SESSION_PURPOSE, policyDecisionRef: frozen(policyRef),
          capabilities: Object.freeze([...device.media]) });
      },
    }),
    bearer,
    policy: Object.freeze({ port: policyPort, readiness }),
    activityAcceptance: Object.freeze({ port: activityPort, readiness }),
    recipientCredential: Object.freeze({ port: recipientPort, readiness }),
    deviceCredential: Object.freeze({
      resolve: async (input: { readonly bearer: RealtimeBearerContext }) => {
        assertBearer(input.bearer);
        await assertActive();
        return frozen(device.deviceCredentialRef);
      },
    }),
    governance: Object.freeze({
      evaluate: async (input: { readonly operation: RealtimeOperation; readonly request: JsonRecord; readonly bearer: RealtimeBearerContext }) => {
        const reason = decide(input.operation, input.request, input.bearer);
        return reason === undefined ? Object.freeze({ accepted: true, refs: frozen(wire) }) : Object.freeze({ accepted: false, reason });
      },
      assertAuthorized: async (input: Parameters<T11bT03GovernancePort['assertAuthorized']>[0]) => {
        const reason = decide(input.operation as RealtimeOperation, input.request, input.bearer);
        if (reason !== undefined || !same(input.governance, wire)) fail(reason ?? 'PAIRED_DEVICE_GOVERNANCE_MISMATCH');
        return frozen(wire) as OpaqueGovernanceValue;
      },
    }),
    ownerContext: Object.freeze({
      resolve: async (input: Parameters<T11bOwnerContextPort['resolve']>[0],client?:CredentialFenceAdmissionClient) => {
        assertBearer(input.bearer);
        await assertActive(client);
        if (input.operation === 'bootstrap') {
          const start = isRecord(input.request.start) ? input.request.start : undefined;
          const startedAt = assertCanonicalTimestamp(start?.started_at as string);
          const startedMs = Date.parse(startedAt), nowMs = now();
          // Freshness gates a new Start only; re-judging it on every read of an established source expired formal
          // input ten minutes into any session although its lease (24 h) was valid.
          if (input.phase !== 'established' && (startedMs > nowMs + DEVICE_CLOCK_LEAD_MS || startedMs < nowMs - START_SKEW_MS))
            fail('PAIRED_DEVICE_START_TIME_INVALID', 422);
          return ownerContextValue(startedAt, requestedMedia(input.request) ?? fail('PAIRED_DEVICE_MEDIA_DENIED'));
        }
        // Only operations that use the media lease need it usable. Ending (stop, end continuity) must stay possible once
        // the lease is released or expired — a retried stop whose first attempt already released the lease is idempotent.
        const binding = await readOwnedBinding(lookupOf(input.request), input.operation === 'end_continuity' || input.operation === 'media_stop');
        return ownerContextValue(at(now()), binding.lease.capabilities);
      },
    }),
    bindCurrentBinding: (next: CurrentBindingReader) => {
      if (reader !== undefined) fail('PAIRED_DEVICE_BINDING_ALREADY_BOUND', 503);
      reader = next;
    },
    readiness,
    close: async () => { closed = true; },
  });
}

/** Device dispatch uses the same enrolled authority ports; no second session, key or permission owner. */
export async function createPairedTerminalAuthorities(options: {pool:Pool;now?:()=>number;leaseMs?:number;ownerUserId?:string}):
  Promise<Omit<DeviceOwnerAuthority,'deviceId'|'readCurrentAuthority'|'readActiveAuthority'> & {readonly terminals:readonly DeviceOwnerAuthority[];register(deviceId:string,refresh?:boolean):Promise<DeviceOwnerAuthority>;forDevice(deviceId:string):DeviceOwnerAuthority;onRevoked(callback:(deviceId:string)=>Promise<void>):()=>void}> {
  const records = await readActivePairedDevices(options.pool);
  const ownerUserId=options.ownerUserId??records[0]?.userId;
  if (!ownerUserId) fail('PAIRED_DEVICE_REQUIRED',503);
  if (records.some(device=>device.userId!==ownerUserId)) fail('PAIRED_DEVICE_OWNER_MISMATCH',503);
  const terminals = await Promise.all(records.map(device => createPairedDeviceAuthority({...options,deviceId:device.deviceId})));
  let bindingReader: CurrentBindingReader | undefined;
  let listener:import('pg').PoolClient|undefined;
  let listenerClosed=false,listenerReady=false,retryMs=100;
  let retryTimer:ReturnType<typeof setTimeout>|undefined,reconnecting:Promise<void>|undefined,closing:Promise<void>|undefined;
  const callbacks = new Set<(deviceId:string)=>Promise<void>>();
  const revoked=async(deviceId:string)=>{
    const terminal=terminals.find(device=>device.deviceId===deviceId);
    await terminal?.close();
    await Promise.all([...callbacks].map(callback=>callback(deviceId)));
    if(terminal){const index=terminals.indexOf(terminal);if(index>=0)terminals.splice(index,1);}
  };
  const retry=():void=>{
    if(listenerClosed||retryTimer||reconnecting)return;
    retryTimer=setTimeout(()=>{
      retryTimer=undefined;
      reconnecting=listen().catch(()=>{console.error(JSON.stringify({event:'PAIRED_DEVICE_LISTENER_RECONNECT_FAILED'}));})
        .finally(()=>{reconnecting=undefined;if(!listenerReady)retry();});
    },retryMs);
    retryTimer.unref();retryMs=Math.min(retryMs*2,5000);
  };
  const disconnected=(client:NonNullable<typeof listener>):void=>{
    if(listener!==client)return;
    listener=undefined;listenerReady=false;
    console.error(JSON.stringify({event:'PAIRED_DEVICE_LISTENER_DISCONNECTED'}));
    client.removeListener('notification',notified);client.release(true);retry();
  };
  const notified = (event:{channel:string;payload?:string|undefined}) => {
    if(listenerClosed||event.channel!=='paired_device_revoked'||!event.payload)return;
    const client=listener;
    void revoked(event.payload).catch(()=>{
      console.error(JSON.stringify({event:'PAIRED_DEVICE_REVOCATION_FAILED'}));
      if(client)disconnected(client);
    });
  };
  const listen=async():Promise<void>=>{
    const client=await options.pool.connect();
    if(listenerClosed){client.release(true);return;}
    listener=client;
    // Retain an error owner until the discarded client ends, including errors following release(true).
    client.on('error',()=>disconnected(client));client.on('end',()=>disconnected(client));
    client.on('notification',notified);
    try{
      await client.query('LISTEN paired_device_revoked');
      const known=[...terminals];
      const active=await client.query("SELECT device_id::text FROM paired_devices WHERE status = 'active'");
      if(listenerClosed||listener!==client)return;
      const ids=new Set(active.rows.map(row=>String(row.device_id)));
      await Promise.all(known.filter(device=>!ids.has(device.deviceId)).map(device=>revoked(device.deviceId)));
      if(!listenerClosed&&listener===client){listenerReady=true;retryMs=100;}
    }catch(error){disconnected(client);throw error;}
  };
  try{await listen();}catch(error){listenerClosed=true;clearTimeout(retryTimer);await Promise.all(terminals.map(device=>device.close()));throw error;}
  const forDevice = (deviceId:string):DeviceOwnerAuthority => terminals.find(device => device.deviceId === deviceId) ?? fail('PAIRED_DEVICE_REQUIRED');
  const readiness:DeviceAuthorityReadiness = Object.freeze({owner:'paired-device-authority',environment:'production',reason:'PAIRED_DEVICE_AUTHORITY_NOT_READY',
    isReady:()=>!listenerClosed&&listenerReady&&terminals.every(device=>device.readiness.isReady()),
    current:()=>Object.freeze({ready:!listenerClosed&&listenerReady&&terminals.every(device=>device.readiness.isReady()),bound:terminals.length>0&&terminals.every(device=>device.readiness.current().bound),
      authorityReady:!listenerClosed&&listenerReady&&terminals.every(device=>device.readiness.current().authorityReady),closed:listenerClosed}),
    assertReady:()=>{if(listenerClosed||!listenerReady)fail('PAIRED_DEVICE_AUTHORITY_NOT_READY',503);for(const device of terminals)device.readiness.assertReady();}});
  const aggregate:Omit<DeviceOwnerAuthority,'deviceId'|'readCurrentAuthority'|'readActiveAuthority'> & {readonly terminals:readonly DeviceOwnerAuthority[];register(deviceId:string,refresh?:boolean):Promise<DeviceOwnerAuthority>;forDevice(deviceId:string):DeviceOwnerAuthority;onRevoked(callback:(deviceId:string)=>Promise<void>):()=>void} = {get terminals(){return Object.freeze([...terminals]);},forDevice,readiness,
    register:async(deviceId:string,refresh=false)=>{
      if (listenerClosed) fail('PAIRED_DEVICE_AUTHORITY_NOT_READY',503);
      const existing=terminals.find(device=>device.deviceId===deviceId);if(existing&&!refresh)return existing;
      const terminal=await createPairedDeviceAuthority({...options,deviceId});
      if(listenerClosed){await terminal.close();fail('PAIRED_DEVICE_AUTHORITY_NOT_READY',503);}
      if(terminal.readCurrentAuthority().userId!==ownerUserId) {await terminal.close();fail('PAIRED_DEVICE_OWNER_MISMATCH',503);}
      if(bindingReader)terminal.bindCurrentBinding(bindingReader);
      if(existing){
        await existing.close();const index=terminals.indexOf(existing);
        if(index<0){await terminal.close();fail('PAIRED_DEVICE_REVOKED');}
        terminals[index]=terminal;
      }else terminals.push(terminal);return terminal;
    },onRevoked:(callback:(deviceId:string)=>Promise<void>)=>{callbacks.add(callback);return ()=>{callbacks.delete(callback);};},
    place:{resolve:async tokenSha256=>{
      const issued=await aggregate.bearer.resolve({tokenSha256,operation:'place_upload'});
      return issued?forDevice(issued.deviceId).readCurrentAuthority():undefined;
    },credential:(token,input)=>forDevice(input.device_id).place.credential(token,input)},
    bearer:{isReady:()=>!listenerClosed&&listenerReady&&terminals.every(device=>device.bearer.isReady()),resolve:async input=>{
      const result=await options.pool.query((input.operation==='place_upload'?"SELECT device_id::text FROM paired_devices WHERE place_token_sha256 = $1 AND status = 'active' AND device_class = 'iphone'":"SELECT device_id::text FROM paired_devices WHERE token_sha256 = $1 AND status = 'active'"),[input.tokenSha256]);
      return result.rows.length === 1 ? forDevice(String(result.rows[0].device_id)).bearer.resolve(input) : undefined;
    }},
    policy:{readiness,port:{evaluate:input=>forDevice(input.deviceId).policy.port.evaluate(input)}},
    activityAcceptance:{readiness,port:{verify:input=>forDevice(input.deviceId).activityAcceptance.port.verify(input)}},
    recipientCredential:{readiness,port:{resolve:input=>forDevice(input.deviceId).recipientCredential.port.resolve!(input)}},
    deviceCredential:{resolve:input=>forDevice(input.bearer.deviceId).deviceCredential.resolve(input)},
    governance:{evaluate:input=>forDevice(input.bearer.deviceId).governance.evaluate(input),
      assertAuthorized:input=>forDevice(input.bearer.deviceId).governance.assertAuthorized(input)},
    ownerContext:{resolve:(input,client)=>forDevice(input.bearer.deviceId).ownerContext.resolve(input,client)},
    formalWatchPrimaryAuthority:{resolve:async (input,client)=>{
      if (!isRecord(input) || typeof input.deviceId !== 'string') fail('PAIRED_DEVICE_BEARER_MISMATCH');
      const device=forDevice((input as JsonRecord).deviceId as string);
      if(device.readCurrentAuthority().deviceType!=='phone') fail('PAIRED_DEVICE_WATCH_PRIMARY_REQUIRED');
      return device.formalWatchPrimaryAuthority.resolve(input,client);
    }},
    bindCurrentBinding:(reader:CurrentBindingReader)=>{for(const device of terminals)device.bindCurrentBinding(reader);bindingReader=reader;},
    close:()=>closing??=(async()=>{
      listenerClosed=true;listenerReady=false;clearTimeout(retryTimer);callbacks.clear();
      const client=listener;listener=undefined;
      try{if(client)await client.query('UNLISTEN paired_device_revoked');}
      finally{client?.removeListener('notification',notified);client?.release(true);await reconnecting;await Promise.all(terminals.map(device=>device.close()));}
    })(),
  };
  return Object.freeze(aggregate);
}
