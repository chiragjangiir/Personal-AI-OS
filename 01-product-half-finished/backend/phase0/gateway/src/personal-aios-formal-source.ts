import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { CredentialFenceAdmissionClient } from '../../../services/platform-data/src/realtime-credential-fence.ts';
import { canonical, check, digest } from '../../../services/personal-aios-integration/src/contracts.ts';
import { WATCH_CAPABILITIES, terminalCapabilities, hasTerminalCapability, type TerminalCapability, sourceSnapshot, type RegisteredDevice, type SourceDeviceAuthority } from '../../../services/personal-aios-integration/src/source-authority.ts';
import type { CurrentBindingLookup, RealtimeCurrentBindingProjection } from '../../../services/realtime-core/src/types.ts';
import type { RealtimeBootstrapConnectedInput } from './realtime-public-control-runtime.ts';
import type { T11bOwnerContext, T11bOwnerContextPort } from './realtime-public-control-t11b-t02-adapter.ts';
import type { AuthenticatedMediaSource } from './source-media-admission.ts';
export interface FormalSourceOptions {
  credentialRegistry?: FormalTerminalSources;
  watchCredentials?: Pick<import('../../../services/platform-data/src/apple-physical-canary-binding-postgres.ts').AppleCompanionBindingPostgresPort,'resolveCredential'|'withCredentialAdmission'|'readWatchInAdmission'|'withWatchAdmission'>;
  place?: import('./paired-device-authority.ts').PairedPlaceAuthority;
  scheduled?: {deviceId:string;read:()=>Promise<import('./paired-device-authority.ts').DeviceAuthorityProjection>};
  ownerContext: {resolve(input:Parameters<T11bOwnerContextPort['resolve']>[0],client?:CredentialFenceAdmissionClient):Promise<T11bOwnerContext>};
  runControlPermission?: import('./source-media-permission.ts').SourceMediaPermissionPort;
  readCurrentBinding: (lookup: CurrentBindingLookup) => Promise<RealtimeCurrentBindingProjection | undefined>;
  sameRef: (left: unknown, right: unknown) => boolean;
  // Existing device/source owner supplies this projection; never copy wire/body identity or route fields.
  resolveSource: (owner: T11bOwnerContext, current: RealtimeCurrentBindingProjection, input: RealtimeBootstrapConnectedInput, client?:CredentialFenceAdmissionClient) => Promise<Omit<RegisteredDevice, 'principal_id' | 'device_id'>>;
  readCurrentBindingInAdmission?: (client: import('../../../services/platform-data/src/realtime-credential-fence.ts').CredentialFenceAdmissionClient, lookup: CurrentBindingLookup) => Promise<RealtimeCurrentBindingProjection | undefined>;
  watchSnapshot?: import('./apple-production-enrollment-owner.ts').AppleCurrentBindingSnapshotProvider;
  now?: () => number;
}
type Provenance = {watch?: {deviceId:string;clientInstanceId:string}; input: RealtimeBootstrapConnectedInput; fingerprint: string};
// SDK roomOptions may contain native objects and key material; only source/auth facts are fingerprinted.
const fingerprint = (input: RealtimeBootstrapConnectedInput) => digest(JSON.parse(JSON.stringify({
  request:input.request,bearer:input.bearer,governance:input.governance,currentBinding:input.currentBinding,enabledMedia:input.enabledMedia,
})));
// Source identity owner; no second session or media-permission implementation.
export class FormalSourceAuthority implements SourceDeviceAuthority {
  private readonly watchAdmission = new AsyncLocalStorage<{token:string;client:CredentialFenceAdmissionClient;active:boolean}>();
  private readonly watchCredentials = new WeakMap<object,string>();
  private readonly directWatchSources = new WeakMap<RegisteredDevice,string>();
  private readonly placeCredentials = new WeakMap<object,string>();
  private readonly placeSources = new WeakMap<RegisteredDevice,string>();
  private readonly scheduledSources = new WeakSet<RegisteredDevice>();
  private readonly credentials = new WeakMap<object, Provenance>();
  private readonly sources = new WeakMap<RegisteredDevice, Provenance>();
  private readonly options: FormalSourceOptions;
  constructor(options: FormalSourceOptions) {this.options=options;if(options.scheduled)options.credentialRegistry?.bindScheduled(options.scheduled.deviceId,this);}
  credentialForWatch(token:string):object {
    const credential=Object.freeze({});this.watchCredentials.set(credential,token);
    this.options.credentialRegistry?.bind(this,credential);return credential;
  }
  private async readDirectWatch(token:string, client?:CredentialFenceAdmissionClient):Promise<RegisteredDevice> {
    check(this.options.watchCredentials,'WATCH_CREDENTIAL_OWNER_REQUIRED',503);
    const admitted=this.watchAdmission.getStore();
    const {binding,governance}=await this.options.watchCredentials.resolveCredential(token,client??(admitted?.active&&admitted.token===token?admitted.client:undefined));
    const refs=governance.consent_record_refs as {ref_type?:string;ref_id?:string}[];
    check(refs?.length===1&&refs[0]?.ref_type==='ConsentRecord'&&typeof refs[0].ref_id==='string','SOURCE_T03_CONSENT_REQUIRED',403);
    const source=sourceSnapshot({principal_id:binding.userId,device_id:binding.watch.deviceId,device_type:'watch',
      capabilities:WATCH_CAPABILITIES,channel:'watch_https',consent_ref:refs[0].ref_id,relay_device_id:binding.iphone.deviceId,
      output_target:{device_id:binding.iphone.deviceId,device_type:'phone'},output_modes:['text'],
      route_version:`route:watch:https:${digest({binding:binding.bindingId,pair:binding.pairVersion})}`});
    this.directWatchSources.set(source,token);this.options.credentialRegistry?.bindSource(this,source);return source;
  }
  credentialForPlace(token:string):object {
    const credential=Object.freeze({});this.placeCredentials.set(credential,token);
    this.options.credentialRegistry?.bind(this,credential);return credential;
  }
  private async readPlace(token:string):Promise<RegisteredDevice> {
    const authority=await this.options.place?.resolve(createHash('sha256').update(token).digest('hex'));
    check(authority && authority.deviceType==='phone','PLACE_CAPABILITY_INVALID',401);
    const source=this.background(authority,'background_place');
    this.placeSources.set(source,token);return source;
  }
  private background(authority:import('./paired-device-authority.ts').DeviceAuthorityProjection,channel:string):RegisteredDevice {
    const refs=(authority.governance as Record<string,unknown>).consent_record_refs as {ref_id?:string;ref_type?:string}[];
    check(refs?.length===1 && refs[0]?.ref_type==='ConsentRecord' && typeof refs[0].ref_id==='string','SOURCE_T03_CONSENT_REQUIRED',403);
    const source=sourceSnapshot({principal_id:authority.userId,device_id:authority.deviceId,device_type:authority.deviceType,
      capabilities:authority.capabilities,channel,consent_ref:refs[0].ref_id,
      route_version:`route:${channel==='background_place'?'place':'scheduled'}:${authority.deviceId}`,output_modes:['text']});
    this.options.credentialRegistry?.bindSource(this,source);return source;
  }
  async scheduled(principal:string,device:string):Promise<RegisteredDevice> {
    const authority=await this.options.scheduled?.read();
    check(authority&&authority.userId===principal&&authority.deviceId===device,'SCHEDULE_OWNER_REQUIRED',403);
    const source=this.background(authority,'background_scheduled');this.scheduledSources.add(source);return source;
  }
  credentialForBootstrap(input: RealtimeBootstrapConnectedInput): object {
    const credential = Object.freeze({});
    this.credentials.set(credential, {input, fingerprint: fingerprint(input)}); this.options.credentialRegistry?.bind(this, credential); return credential;
  }
  private async read(provenance: Provenance, client?: import('../../../services/platform-data/src/realtime-credential-fence.ts').CredentialFenceAdmissionClient) {
    const {input} = provenance; const expected = input.currentBinding;
    check(fingerprint(input) === provenance.fingerprint, 'SOURCE_HOST_CONTEXT_MUTATED', 403);
    // Established source: identity from the original Start, currentness from the live session/lease checks below.
    const owner = await this.options.ownerContext.resolve({operation:'bootstrap',phase:'established',request:input.request,
      bearer:input.bearer,governance:input.governance},client);
    check(!client || this.options.readCurrentBindingInAdmission,'SOURCE_ADMISSION_READER_REQUIRED',503);
    const lookup={realtimeSessionRef:expected.realtimeSessionRef} as CurrentBindingLookup;
    const current=client ? await this.options.readCurrentBindingInAdmission!(client,lookup) : await this.options.readCurrentBinding(lookup);
    check(current, 'SOURCE_CURRENT_BINDING_REQUIRED', 403);
    const {session, lease} = current; const binding = session.binding;
    const same = this.options.sameRef; const now = this.options.now?.() ?? Date.now();
    check(session.state === 'active' && session.continuityState === 'active' && binding.state === 'connected' &&
      lease.state === 'active' && Date.parse(session.continuityExpiresAt) > now && Date.parse(lease.expiresAt) > now,
      'SOURCE_BINDING_INACTIVE', 403);
    check(owner.userId === session.userId && owner.userId === lease.userId && owner.deviceId === input.bearer.deviceId &&
      owner.deviceId === session.activeDeviceId && owner.deviceId === lease.deviceId && owner.deviceId === binding.deviceId &&
      same(session.realtimeSessionRef, expected.realtimeSessionRef) && same(session.realtimeSessionRef, lease.realtimeSessionRef) &&
      same(session.realtimeSessionRef, binding.realtimeSessionRef) && same(session.activeDeviceLeaseRef, lease.deviceLeaseRef) &&
      same(lease.deviceLeaseRef, expected.deviceLeaseRef) && same(lease.deviceLeaseRef, binding.deviceLeaseRef) &&
      session.connectionEpoch === expected.connectionEpoch && binding.connectionEpoch === session.connectionEpoch &&
      session.continuityId === expected.continuityId && lease.continuityId === session.continuityId && binding.continuityId === session.continuityId,
      'SOURCE_OWNER_BINDING_DENIED', 403);
    const source = await this.options.resolveSource(owner, current, input, client);
    const handle = sourceSnapshot({...source, principal_id:owner.userId,device_id:owner.deviceId});
    if (provenance.watch) {
      const provider = this.options.watchSnapshot;
      check(handle.device_type === 'phone' && provider?.snapshotIsolation === 'REPEATABLE READ' && provider.readOnly === true && provider.readCurrentBindingSnapshot,
        'SOURCE_WATCH_SNAPSHOT_REQUIRED',503);
      check(!client || provider.readCurrentBindingSnapshotInAdmission,'SOURCE_WATCH_ADMISSION_READER_REQUIRED',503);
      const snapshot = client ? await provider.readCurrentBindingSnapshotInAdmission!(client) : await provider.readCurrentBindingSnapshot({continuityId:session.continuityId});
      check(snapshot && !Array.isArray(snapshot) && 'binding' in snapshot, 'SOURCE_WATCH_BINDING_REQUIRED',403);
      const pair = snapshot.formalWatchPairState; const watch = snapshot.formalWatchBinding;
      check(pair?.status === 'active' && pair.requiresRebind === false && watch?.kind === 't02.apple.watch-binding.v1' &&
        watch.status === 'active' && watch.pairVersion === pair.pairVersion && watch.userId === owner.userId &&
        watch.iphone.deviceId === owner.deviceId && watch.watch.deviceId !== owner.deviceId &&
        watch.watch.deviceId === provenance.watch.deviceId && watch.watch.clientInstanceId === provenance.watch.clientInstanceId &&
        same(watch.realtimeSessionRef,session.realtimeSessionRef) && same(watch.iphone.deviceLeaseRef,lease.deviceLeaseRef) &&
        same(snapshot.binding.session.realtimeSessionRef,session.realtimeSessionRef) &&
        same(snapshot.binding.lease.deviceLeaseRef,lease.deviceLeaseRef) &&
        snapshot.binding.session.connectionEpoch === session.connectionEpoch &&
        snapshot.binding.session.revision === session.revision && Date.parse(watch.expiresAt) > now,
        'SOURCE_WATCH_BINDING_DENIED',403);
      const companion = sourceSnapshot({...handle,device_id:watch.watch.deviceId,device_type:'watch',capabilities:WATCH_CAPABILITIES,channel:'watch_connectivity',
        relay_device_id:owner.deviceId,output_target:{device_id:owner.deviceId,device_type:'phone'},route_version:`route:watch:${digest({primary:handle.route_version,
          device:watch.watch.deviceId,client:watch.watch.clientInstanceId,pair:watch.pairVersion})}`});
      this.sources.set(companion,provenance); this.options.credentialRegistry?.bindSource(this, companion); return {source:companion,current};
    }
    this.sources.set(handle, provenance); this.options.credentialRegistry?.bindSource(this, handle); return {source:handle, current};
  }
  async authenticate(credential: unknown): Promise<RegisteredDevice> {
    const direct=credential&&typeof credential==='object'?this.watchCredentials.get(credential):undefined;
    if(direct)return this.readDirectWatch(direct);
    const token=credential && typeof credential==='object'?this.placeCredentials.get(credential):undefined;
    if(token)return this.readPlace(token);
    const provenance = credential !== null && typeof credential === 'object' ? this.credentials.get(credential) : undefined;
    check(provenance, 'SOURCE_HOST_CREDENTIAL_REQUIRED', 401); return (await this.read(provenance)).source;
  }
  async verifyOutputRecipient(primary:RegisteredDevice,d:import('../../../services/personal-aios-integration/src/contracts.ts').ProcessedEvent,routeVersion:string) {
    const provenance=this.sources.get(primary);check(provenance && !provenance.watch && primary.device_type==='phone' &&
      d.principal_id===primary.principal_id && d.device_type==='watch' && d.origin==='device_observation' && d.source.relay_device_id===primary.device_id,'SOURCE_OUTPUT_RECIPIENT_DENIED',403);
    const event=d.content.app_event as {origin?:{device_id?:string;client_instance_id?:string}}|undefined;
    if(d.source.channel==='watch_https'){
      const current=await this.read(provenance);
      const snapshot=await this.options.watchSnapshot?.readCurrentBindingSnapshot?.({continuityId:current.current.session.continuityId});
      check(snapshot&&!Array.isArray(snapshot)&&'binding' in snapshot,'SOURCE_WATCH_BINDING_REQUIRED',403);
      const binding=snapshot.formalWatchBinding,pair=snapshot.formalWatchPairState;
      check(binding?.status==='active'&&pair?.status==='active'&&!pair.requiresRebind&&binding.pairVersion===pair.pairVersion&&
        binding.userId===primary.principal_id&&binding.iphone.deviceId===primary.device_id&&binding.watch.deviceId===d.device_id&&
        Date.parse(binding.expiresAt)>(this.options.now?.()??Date.now())&&
        routeVersion===`route:watch:https:${digest({binding:binding.bindingId,pair:binding.pairVersion})}`,'SOURCE_OUTPUT_ROUTE_CHANGED',403);
      return;
    }
    check(event?.origin?.device_id===d.device_id && typeof event.origin.client_instance_id==='string','SOURCE_OUTPUT_ORIGIN_REQUIRED',403);
    const watch=(await this.read({...provenance,watch:{deviceId:d.device_id,clientInstanceId:event.origin.client_instance_id}})).source;
    // Route excludes renewable receipt bytes; pair version still binds the original DEST.
    check(watch.output_target?.device_id===primary.device_id && watch.route_version===routeVersion,'SOURCE_OUTPUT_ROUTE_CHANGED',403);
  }
  async verifyRunController(primary:RegisteredDevice,d:import('../../../services/personal-aios-integration/src/contracts.ts').ProcessedEvent,sourceRouteVersion:string) {
    const provenance=this.sources.get(primary);
    check(provenance && !provenance.watch && primary.device_type==='phone' && d.principal_id===primary.principal_id &&
      d.device_type==='watch' && d.origin==='device_observation' && (d.source.channel==='watch_connectivity'||d.source.channel==='watch_https') &&
      d.source.relay_device_id===primary.device_id,'SOURCE_RUN_CONTROLLER_DENIED',403);
    const event=d.content.app_event as {origin?:{device_id?:string;client_instance_id?:string}}|undefined;
    const permission=this.options.runControlPermission;
    check(permission,'SOURCE_CONTROL_ADMISSION_REQUIRED',503);
    const captured=await this.captureSource(primary);
    if(d.source.channel==='watch_https'){
      check(this.options.watchCredentials,'WATCH_CREDENTIAL_OWNER_REQUIRED',503);
      // Binding precedes the primary fence/session locks, as in direct final admission and pair mutation.
      await this.options.watchCredentials.withWatchAdmission(primary.principal_id,primary.device_id,d.device_id,async binding=>{
        check(sourceRouteVersion===`route:watch:https:${digest({binding:binding.bindingId,pair:binding.pairVersion})}`,'SOURCE_CONTROL_BINDING_CHANGED',403);
        await permission.withPermission(captured.binding,'data',async()=>undefined,async client=>{
          check(client,'SOURCE_CONTROL_ADMISSION_CLIENT_REQUIRED',503);
          const current=(await this.read(provenance,client)).source;
          check(canonical(current)===canonical(primary),'SOURCE_CONTROL_BINDING_CHANGED',403);
        });
      });
      return;
    }
    check(event?.origin?.device_id===d.device_id && typeof event.origin.client_instance_id==='string','SOURCE_CONTROL_ORIGIN_REQUIRED',403);
    await permission.withPermission(captured.binding,'data',async()=>undefined,async client=>{
      check(client,'SOURCE_CONTROL_ADMISSION_CLIENT_REQUIRED',503);
      const watch=(await this.read({...provenance,watch:{deviceId:d.device_id,clientInstanceId:event.origin!.client_instance_id!}},client)).source;
      // Explicit primary control is admitted under the same Stop/pair fence; DEST grants nothing.
      check(watch.route_version===sourceRouteVersion,'SOURCE_CONTROL_BINDING_CHANGED',403);
    });
  }
  async withVoiceAction<T>(source:RegisteredDevice,modality:'audio'|'data',consume:()=>Promise<T>):Promise<T> {
    const token=this.directWatchSources.get(source);
    if(token){
      check(this.options.watchCredentials,'WATCH_CREDENTIAL_OWNER_REQUIRED',503);
      const action=async(client:CredentialFenceAdmissionClient)=>{
        const current=await this.readDirectWatch(token,client);
        check(canonical(current)===canonical(source),'VOICE_SOURCE_CHANGED',403);return consume();
      };
      const admitted=this.watchAdmission.getStore();
      if(admitted?.active&&admitted.token===token)return action(admitted.client);
      return this.options.watchCredentials.withCredentialAdmission(token,async(_resolved,client)=>{
        const context={token,client,active:true};
        return this.watchAdmission.run(context,async()=>{try{return await action(client);}finally{context.active=false;}});
      });
    }
    const provenance=this.sources.get(source);
    check(provenance && !provenance.watch,'VOICE_PRIMARY_SOURCE_REQUIRED',403);
    const permission=this.options.runControlPermission;
    check(permission,'VOICE_SOURCE_PERMISSION_REQUIRED',503);
    const captured=await this.captureSource(source);
    return permission.withPermission(captured.binding,modality,consume,async client=>{
      check(client,'VOICE_ADMISSION_CLIENT_REQUIRED',503);
      const current=(await this.read(provenance,client)).source;
      check(canonical(current)===canonical(source),'VOICE_SOURCE_CHANGED',403);
    });
  }
  async revalidate(source: RegisteredDevice): Promise<RegisteredDevice> {
    const direct=this.directWatchSources.get(source);if(direct)return this.readDirectWatch(direct);
    if(this.scheduledSources.has(source))return this.scheduled(source.principal_id,source.device_id);
    const token=this.placeSources.get(source);if(token)return this.readPlace(token);
    const provenance = this.sources.get(source);
    check(provenance, 'SOURCE_PROVENANCE_REQUIRED', 403);
    const current = (await this.read(provenance)).source;
    check(canonical([source.principal_id,source.device_id,source.device_type,source.channel,source.relay_device_id ?? null]) ===
      canonical([current.principal_id,current.device_id,current.device_type,current.channel,current.relay_device_id ?? null]),
      'SOURCE_IDENTITY_CHANGED', 403);
    return current;
  }
  /** Host-only issued-source context; client objects cannot cross the WeakMap source authority. */
  async captureSource(source:RegisteredDevice):ReturnType<AuthenticatedMediaSource['capture']> {
    const direct=this.directWatchSources.get(source);
    if(direct){
      const current=await this.readDirectWatch(direct);
      const admitted=this.watchAdmission.getStore();
      const resolved=await this.options.watchCredentials!.resolveCredential(direct,admitted?.active&&admitted.token===direct?admitted.client:undefined);
      const binding=resolved.binding;
      const active=await this.options.readCurrentBinding({realtimeSessionRef:binding.realtimeSessionRef});
      check(active&&active.session.userId===binding.userId,'SOURCE_CURRENT_BINDING_REQUIRED',403);
      return {trusted:{...current,submission:'observation'},binding:{realtimeSessionRef:binding.realtimeSessionRef,
        deviceLeaseRef:binding.iphone.deviceLeaseRef as never,continuityId:active.session.continuityId,
        connectionEpoch:active.session.connectionEpoch,userId:binding.userId,deviceId:binding.watch.deviceId,purpose:active.lease.purpose}};
    }
    const provenance=this.sources.get(source);check(provenance,'SOURCE_PROVENANCE_REQUIRED',403);
    const {source:current,current:{session,lease}}=await this.read(provenance);
    check(source.principal_id===current.principal_id&&source.device_id===current.device_id,'SOURCE_IDENTITY_CHANGED',403);
    return {trusted:{...current,submission:'observation'},binding:{realtimeSessionRef:session.realtimeSessionRef,
      deviceLeaseRef:lease.deviceLeaseRef as never,continuityId:session.continuityId,connectionEpoch:session.connectionEpoch,
      userId:current.principal_id,deviceId:current.device_id,purpose:lease.purpose}};
  }
  /** Same validated source projection as runtime; route/output fields must not be guessed by collectors. */
  async capture(credential: unknown): ReturnType<AuthenticatedMediaSource['capture']> {
    const direct=credential&&typeof credential==='object'?this.watchCredentials.get(credential):undefined;
    if(direct)return this.captureSource(await this.readDirectWatch(direct));
    const provenance = credential !== null && typeof credential === 'object' ? this.credentials.get(credential) : undefined;
    check(provenance, 'SOURCE_HOST_CREDENTIAL_REQUIRED', 401);
    const {source, current:{session,lease}} = await this.read(provenance);
    return {trusted:{...source,submission:'observation'},binding:{realtimeSessionRef:session.realtimeSessionRef,
      deviceLeaseRef:lease.deviceLeaseRef as never,continuityId:session.continuityId,connectionEpoch:session.connectionEpoch,
      userId:source.principal_id,deviceId:source.device_id,purpose:lease.purpose}};
  }
}

/** What the formal source needs from the device authority: owner context plus read-only scope views. */
export interface FormalSourceDeviceAuthority {
  readonly readActiveAuthority?: import('./paired-device-authority.ts').DeviceOwnerAuthority['readActiveAuthority'];
  readonly place?: import('./paired-device-authority.ts').PairedPlaceAuthority;
  readonly ownerContext: {resolve(input:Parameters<T11bOwnerContextPort['resolve']>[0],client?:CredentialFenceAdmissionClient):Promise<T11bOwnerContext>};
  readonly readCurrentAuthority?: (atSystemTime?: string) => Readonly<{ userId: string; deviceId: string; principal: unknown;
    recipientPublicKey?:string;
    deviceType?: DeviceType; capabilities?: readonly TerminalCapability[]; policyDecisionRef: unknown; allowedMediaCapabilities: readonly string[]; governance: unknown }>;
  readonly formalWatchPrimaryAuthority: { readonly resolve: (bearer: unknown, client?:CredentialFenceAdmissionClient) => Promise<Readonly<{ userId: string; deviceId: string;
    principalRef: unknown; policyDecisionRef: unknown }>> };
}
import type { DeviceType } from '../../../services/personal-aios-integration/src/contracts.ts';
// One producer-bound family scope, not another device/token registry. Canonical identity and consent stay T03-owned.
export function createAppleCyclingTypedSourceResolver(options: {
  t03: Pick<FormalSourceDeviceAuthority, 'readCurrentAuthority' | 'formalWatchPrimaryAuthority'>;
  producer: {device_id: string; device_type: DeviceType; channel: string};
  playback?: {device_id:string;transport:'wav_byte_stream_v1'}; now?: () => number;
}): FormalSourceOptions['resolveSource'] {
  const producer = Object.freeze({...options.producer});
  const playback = options.playback && Object.freeze({...options.playback});
  check(!playback || playback.device_id === producer.device_id &&
    playback.transport === 'wav_byte_stream_v1', 'SOURCE_PLAYBACK_CAPABILITY_DENIED',403);
  return async (owner, current, input, client) => {
    const authenticated = await options.t03.formalWatchPrimaryAuthority.resolve(input.bearer,client);
    check(options.t03.readCurrentAuthority, 'SOURCE_T03_READER_REQUIRED', 503);
    const authority = options.t03.readCurrentAuthority(new Date(options.now?.() ?? Date.now()).toISOString());
    check(authenticated.userId === owner.userId && authenticated.deviceId === owner.deviceId &&
      authority.userId === owner.userId && authority.deviceId === owner.deviceId && producer.device_id === owner.deviceId &&
      canonical(authenticated.principalRef) === canonical(authority.principal) &&
      canonical(authenticated.policyDecisionRef) === canonical(authority.policyDecisionRef) &&
      canonical(current.lease.policyDecisionRef) === canonical(authority.policyDecisionRef) &&
      authority.allowedMediaCapabilities.includes('data') && current.lease.capabilities.includes('data'), 'SOURCE_T03_SCOPE_DENIED', 403);
    const governance = authority.governance as Record<string,unknown>;
    const capabilities = terminalCapabilities({device_type:authority.deviceType ?? producer.device_type,capabilities:authority.capabilities});
    check(!authority.deviceType || producer.device_type === authority.deviceType, 'SOURCE_TERMINAL_TYPE_DENIED',403);
    check(!playback || hasTerminalCapability({device_type:producer.device_type,capabilities},'speaker'), 'SOURCE_PLAYBACK_CAPABILITY_DENIED',403);
    const refs = governance.consent_record_refs;
    check(Array.isArray(refs) && refs.length === 1 && refs[0]?.ref_type === 'ConsentRecord' &&
      typeof refs[0].ref_id === 'string', 'SOURCE_T03_CONSENT_REQUIRED', 403);
    return {capabilities,device_type:producer.device_type,channel:producer.channel,consent_ref:refs[0].ref_id,
      ...(authority.recipientPublicKey?{recipient_public_key:authority.recipientPublicKey}:{}),
      // Route identity follows the binding and producer; renewable permission is checked above.
      route_version:`route:v2:${digest({session:current.session.realtimeSessionRef,lease:current.lease.deviceLeaseRef,
        epoch:current.session.connectionEpoch,producer,capabilities,...(playback ? {playback} : {}),owner:{user_id:owner.userId,device_id:owner.deviceId,
          principal:authority.principal}})}`,output_modes:[...(capabilities.includes('display') ? ['text'] : []), ...(playback ? ['voice'] : [])]};
  };
}

/** Routes host-issued credentials to the terminal authority that minted them. */
export class FormalTerminalSources implements SourceDeviceAuthority {
  private readonly scheduledAuthorities = new Map<string,FormalSourceAuthority>();
  private readonly credentials = new WeakMap<object, FormalSourceAuthority>();
  private readonly sources = new WeakMap<RegisteredDevice, FormalSourceAuthority>();
  bind(authority: FormalSourceAuthority, credential: object): void { this.credentials.set(credential, authority); }
  bindSource(authority: FormalSourceAuthority, source: RegisteredDevice): void {this.sources.set(source,authority); }
  bindScheduled(device:string,authority:FormalSourceAuthority):void {this.scheduledAuthorities.set(device,authority);}
  async scheduled(principal:string,device:string):Promise<RegisteredDevice> {
    const authority=this.scheduledAuthorities.get(device);check(authority,'SCHEDULE_DEVICE_REQUIRED',403);
    return authority.scheduled(principal,device);
  }
  private owner(source: RegisteredDevice): FormalSourceAuthority {
    const authority = this.sources.get(source); check(authority, 'SOURCE_PROVENANCE_REQUIRED', 403); return authority;
  }
  async authenticate(credential: unknown): Promise<RegisteredDevice> {
    const authority = credential && typeof credential === 'object' ? this.credentials.get(credential) : undefined;
    check(authority, 'SOURCE_HOST_CREDENTIAL_REQUIRED', 401);
    const source = await authority.authenticate(credential); this.sources.set(source, authority); return source;
  }
  async revalidate(source: RegisteredDevice): Promise<RegisteredDevice> {
    const authority = this.owner(source), current = await authority.revalidate(source);
    this.sources.set(current, authority); return current;
  }
  withVoiceAction<T>(source: RegisteredDevice, modality: 'audio'|'data', consume: () => Promise<T>): Promise<T> {
    return this.owner(source).withVoiceAction(source, modality, consume);
  }
  verifyRunController(source: RegisteredDevice, event: import('../../../services/personal-aios-integration/src/contracts.ts').ProcessedEvent, route: string) {
    return this.owner(source).verifyRunController(source, event, route);
  }
  verifyOutputRecipient(source: RegisteredDevice, event: import('../../../services/personal-aios-integration/src/contracts.ts').ProcessedEvent, route: string) {
    return this.owner(source).verifyOutputRecipient(source, event, route);
  }
}
