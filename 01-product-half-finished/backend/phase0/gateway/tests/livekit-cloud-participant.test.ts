import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import {
  LiveKitCloudParticipant,
  type LiveKitCloudRoomPort,
} from '../src/livekit-cloud-participant.ts';
import { LiveKitCloudRecoveryObserver } from '../src/livekit-cloud-recovery-observer.ts';
import { DisconnectReason, TrackKind } from '@livekit/rtc-node';
import { FfiClient, FfiHandle, dispose } from '../node_modules/@livekit/rtc-node/dist/ffi_client.js';
import { createGatewayRoom } from '../src/sdk-room.ts';

test('a room reconnecting after a server-side disconnect handles each native event once', async (t) => {
  const ffi=FfiClient.instance,room=createGatewayRoom(),metadata:string[]=[];
  // Owned native IDs (room + local participant per connect), so the SDK's handle wrappers stay valid.
  const ids = Array.from({length:4}, () => (ffi.request({message:{case:'newVideoSource',value:{
    type:0,resolution:{width:2,height:2},
  }}}) as {source:{handle:{id:bigint}}}).source.handle.id);
  const emit=(kind:string,value:unknown)=>ffi.emit('ffi_event',{message:{case:kind,value}} as never);
  let connects=0;
  t.mock.method(ffi,'request',(req:Parameters<FfiClient['request']>[0])=>{
    if(req.message?.case==='connect'){
      const [roomId,localId]=ids.slice(connects*2,connects*2+2) as [bigint,bigint];connects+=1;
      queueMicrotask(()=>emit('connect',{asyncId:1n,message:{case:'result',value:{
        room:{handle:{id:roomId},info:{sid:'RM_test'}},localParticipant:{handle:{id:localId},info:{identity:'gateway',sid:'PA_local'}},participants:[],
      }}}));
    }
    if(req.message?.case==='disconnect')queueMicrotask(()=>emit('disconnect',{asyncId:1n}));
    return {asyncId:1n} as never;
  });
  const handles=()=>[(room as unknown as {ffiHandle:FfiHandle}).ffiHandle,room.localParticipant!.ffi_handle];
  room.on('roomMetadataChanged',value=>metadata.push(value));
  await room.connect('ws://synthetic.invalid','synthetic-token');
  const first=handles();
  emit('roomEvent',{roomHandle:ids[0],message:{case:'disconnected',value:{reason:DisconnectReason.ROOM_DELETED}}});
  await setImmediate();
  await room.connect('ws://synthetic.invalid','synthetic-token');
  const second=handles();
  t.after(async()=>{await room.disconnect();for(const handle of [...first,...second])handle.dispose();});
  emit('roomEvent',{roomHandle:ids[2],message:{case:'roomMetadataChanged',value:{metadata:'once'}}});
  await setImmediate();
  assert.deepEqual(metadata,['once']);
});

test('a connect whose native room handle is dropped before readiness retires that handle exactly once', async (t) => {
  const ffi=FfiClient.instance,room=createGatewayRoom(),real=ffi.request.bind(ffi);
  const [roomId,localId]=Array.from({length:2},()=>(real({message:{case:'newVideoSource',value:{
    type:0,resolution:{width:2,height:2},
  }}}) as {source:{handle:{id:bigint}}}).source.handle.id) as [bigint,bigint];
  const emit=(kind:string,value:unknown)=>ffi.emit('ffi_event',{message:{case:kind,value}} as never);
  t.mock.method(ffi,'request',(req:Parameters<FfiClient['request']>[0])=>{
    if(req.message?.case==='connect'){
      queueMicrotask(()=>emit('connect',{asyncId:1n,message:{case:'result',value:{
        room:{handle:{id:roomId},info:{sid:'RM_ready'}},localParticipant:{handle:{id:localId},info:{identity:'gateway',sid:'PA_local'}},participants:[],
      }}}));
      return {asyncId:1n} as never;
    }
    if(req.message?.case==='readyForRoomEvent'){
      // The pinned FFI waited 1 s for readiness, closed the room and dropped the handle the SDK had just wrapped.
      new FfiHandle(roomId).dispose();
      throw new Error('failed to handle request: invalid request: handle not found');
    }
    return real(req);
  });
  t.after(()=>room.localParticipant?.ffi_handle.dispose());
  await assert.rejects(room.connect('ws://synthetic.invalid','synthetic-token'),/handle not found/);
  // Retired: the finalizer's later dispose is a no-op instead of "trying to drop an invalid handle" with no JS stack.
  assert.doesNotThrow(()=>(room as unknown as {ffiHandle:FfiHandle}).ffiHandle.dispose());
});

test('native duplicate joins preserve the session or retire old tracks before participant replacement', async (t) => {
  const ffi=FfiClient.instance,room=createGatewayRoom(),events:string[]=[],disposed:bigint[]=[];
  // Allocate owned native IDs without wrappers; the SDK fixture owns their lifetime.
  const ids = Array.from({length:9}, () => {
    const result = ffi.request({message:{case:'newVideoSource',value:{
      type:0,resolution:{width:2,height:2},
    }}}) as {source:{handle:{id:bigint}}};
    return result.source.handle.id;
  });
  const [roomId,localId,oldId,duplicateOldId,newId,duplicateNewId,otherId,publicationId,trackId] = ids as [bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint];
  const nativeDispose = FfiHandle.prototype.dispose;
  const participant=(sid:string,id:bigint,identity='device')=>({handle:{id},info:{identity,sid}});
  const emit=(kind:string,value:unknown)=>ffi.emit('ffi_event',{message:{case:kind,value}} as never);
  const notification=(kind:string,value:unknown)=>emit('roomEvent',{roomHandle:roomId,message:{case:kind,value}});
  t.mock.method(FfiHandle.prototype,'dispose',function(this:FfiHandle){disposed.push(this.handle);nativeDispose.call(this);});
  t.mock.method(ffi,'request',(req:Parameters<FfiClient['request']>[0])=>{
    if(req.message?.case==='connect')queueMicrotask(()=>{
      notification('participantConnected',{info:participant('PA_old',duplicateOldId)});
      emit('connect',{asyncId:1n,message:{case:'result',value:{
        room:{handle:{id:roomId},info:{sid:'RM_test'}},localParticipant:participant('PA_local',localId,'gateway'),
        participants:[{participant:participant('PA_old',oldId),publications:[{handle:{id:publicationId},info:{sid:'TR_audio'}}]}],
      }}});
    });
    if(req.message?.case==='readyForRoomEvent')notification('trackSubscribed',{
      participantIdentity:'device',track:{handle:{id:trackId},info:{sid:'TR_audio',kind:TrackKind.KIND_AUDIO}},
    });
    if(req.message?.case==='disconnect')queueMicrotask(()=>emit('disconnect',{asyncId:1n}));
    return {asyncId:1n} as never;
  });
  room.on('trackUnsubscribed',(_track,_publication,p)=>events.push('unsubscribe:'+p.sid));
  room.on('trackUnpublished',(_publication,p)=>events.push('unpublish:'+p.sid));
  room.on('participantDisconnected',p=>events.push('disconnect:'+p.sid));
  room.on('participantConnected',p=>events.push('connect:'+p.sid));
  await room.connect('ws://synthetic.invalid','synthetic-token');
  await setImmediate();
  const original=room.remoteParticipants.get('device')!;
  const fixtureHandles = [
    (room as unknown as {ffiHandle:FfiHandle}).ffiHandle,
    room.localParticipant!.ffi_handle, original.ffi_handle,
    original.trackPublications.get('TR_audio')!.track!.ffi_handle,
  ];
  t.after(async()=>{
    await room.disconnect();
    for (const current of room.remoteParticipants.values()) current.ffi_handle.dispose();
    for (const handle of fixtureHandles) handle.dispose();
    await dispose();
  });
  assert.equal(original.trackPublications.get('TR_audio')?.track?.sid,'TR_audio');
  notification('participantConnected',{info:participant('PA_new',newId)});
  notification('participantConnected',{info:participant('PA_new',duplicateNewId)});
  notification('participantConnected',{info:participant('PA_other',otherId,'other')});
  await setImmediate();
  assert.deepEqual(events,['unsubscribe:PA_old','unpublish:PA_old','disconnect:PA_old','connect:PA_new','connect:PA_other']);
  assert.equal(original.trackPublications.size,0);
  assert.equal(room.remoteParticipants.get('device')?.sid,'PA_new');
  assert.deepEqual(disposed,[duplicateOldId,publicationId,duplicateNewId]);
});

const binding = {
  realtimeSessionRef: { ref_type: 'RealtimeSession', ref_id: 'session' },
  deviceLeaseRef: { ref_type: 'DeviceLease', ref_id: 'lease' },
  continuityId: 'continuity',
  transportAliases: ['room-alias', 'participant-alias'],
  connectionEpoch: '1',
};
const grants = {
  room: 'gateway-room', roomJoin: true as const, canPublish: false,
  canSubscribe: true, canPublishData: true, canPublishSources: [] as const,
};
const roomOptions = { encryption: { keyProviderOptions: {} } };

test('avatar publisher borrows the current envelope key and loses access on disconnect',async()=>{
  const {room}=roomState(),participant=new LiveKitCloudParticipant(room),key=new Uint8Array(32).fill(7);
  await assert.rejects(participant.withEncryptionKey(async()=>{}),/KEY_UNAVAILABLE/);
  await participant.connect({projectUrl:'wss://project.livekit.cloud',roomName:'gateway-room',identity:'gateway-identity',
    token:'opaque-participant-token',grants,binding,roomOptions:{encryption:{keyProviderOptions:{sharedKey:key}}}});
  await participant.withEncryptionKey(async current=>assert.equal(current,key));
  await participant.disconnect();await assert.rejects(participant.withEncryptionKey(async()=>{}),/KEY_UNAVAILABLE/);
});

function roomState(disconnectFails = false) {
  const listeners = new Map<string, (...args: readonly unknown[]) => void>();
  const state = { connects: [] as unknown[][], disconnects: 0, removed: 0 };
  const room: LiveKitCloudRoomPort = {
    async connect(...args) { state.connects.push(args); },
    async disconnect() { state.disconnects += 1; if (disconnectFails) throw new Error('ROOM_DISCONNECT_FAILED'); },
    on(event, listener) { listeners.set(event, listener); },
    removeAllListeners() { state.removed += 1; },
  };
  return { room, state, listeners };
}

function delayedRoom(connectFails = false) {
  let releaseConnect!: () => void;
  let rejectConnect!: (error: Error) => void;
  const connectGate = new Promise<void>((resolve, reject) => {
    releaseConnect = resolve;
    rejectConnect = reject;
  });
  const state = { connects: 0, disconnects: 0, removed: 0 };
  const room: LiveKitCloudRoomPort = {
    async connect() {
      state.connects += 1;
      if (connectFails) throw new Error('ROOM_CONNECT_FAILED');
      await connectGate;
    },
    async disconnect() { state.disconnects += 1; },
    on() {},
    removeAllListeners() { state.removed += 1; },
  };
  return { room, state, releaseConnect, rejectConnect };
}

function retryRoom() {
  let releaseSecond!: () => void;
  let attempts = 0;
  const state = { disconnects: 0 };
  const room: LiveKitCloudRoomPort = {
    async connect() {
      attempts += 1;
      if (attempts === 1) throw new Error('FIRST_CONNECT_FAILED');
      await new Promise<void>((resolve) => { releaseSecond = resolve; });
    },
    async disconnect() { state.disconnects += 1; },
    on() {},
    removeAllListeners() {},
  };
  return { room, state, get attempts() { return attempts; }, releaseSecond: () => releaseSecond() };
}

function listenerOnlyRoom() {
  type Listener = (...args: readonly unknown[]) => void;
  const listeners = new Map<string, Set<Listener>>();
  const state = { connects: 0, disconnects: 0, offCalls: 0 };
  const room: LiveKitCloudRoomPort = {
    async connect() { state.connects += 1; },
    async disconnect() { state.disconnects += 1; },
    on(event, listener) {
      let bucket = listeners.get(event);
      if (bucket === undefined) {
        bucket = new Set();
        listeners.set(event, bucket);
      }
      bucket.add(listener);
    },
    off(event, listener) {
      state.offCalls += 1;
      listeners.get(event)?.delete(listener);
    },
  };
  const emit = (event: string, ...args: readonly unknown[]) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
  };
  return { room, state, emit };
}

test('participant connects direct to Cloud and forwards E2EE room options', async () => {
  const { room, state } = roomState();
  const participant = new LiveKitCloudParticipant(room);
  await participant.connect({
    projectUrl: 'wss://project.livekit.cloud', roomName: 'gateway-room', identity: 'gateway-identity',
    token: 'opaque-participant-token', grants, binding, roomOptions,
  });
  assert.equal(state.connects.length, 1);
  assert.equal(state.connects[0]![0], 'wss://project.livekit.cloud');
  assert.deepEqual(state.connects[0]![2], { encryption: { keyProviderOptions: {} } });
  assert.deepEqual(participant.snapshot(), { connected: true, transportState: 'connected', projectUrl: 'wss://project.livekit.cloud', roomName: 'gateway-room', identity: 'gateway-identity', connectionEpoch: '1' });
});

test('participant connects the exact PAIOS self-hosted origin through the private signaling origin and public binding', async () => {
  const { room, state } = roomState();
  const participant = new LiveKitCloudParticipant(room, 'http://127.0.0.1:7880');
  await participant.connect({
    projectUrl: 'wss://ai.example.invalid', roomName: 'gateway-room', identity: 'gateway-identity',
    token: 'opaque-participant-token', grants, binding, roomOptions,
  });
  assert.equal(state.connects.length, 1);
  assert.equal(state.connects[0]![0], 'ws://127.0.0.1:7880');
  assert.equal(participant.snapshot().projectUrl, 'wss://ai.example.invalid');
  assert.deepEqual(participant.bindingSnapshot(), binding);
  await participant.close();
  assert.equal(state.disconnects, 1);
  assert.throws(() => new LiveKitCloudParticipant(room, 'http://192.0.2.1:7880'), /INVALID_LIVEKIT_API_URL/);
  assert.throws(() => new LiveKitCloudParticipant(room, 'https://rtc.example/path'), /INVALID_LIVEKIT_API_URL/);
});

test('duplicate same binding is idempotent while a drifted binding is rejected', async () => {
  const { room, state } = roomState();
  const participant = new LiveKitCloudParticipant(room);
  const input = { projectUrl: 'wss://project.livekit.cloud', roomName: 'gateway-room', identity: 'gateway-identity', token: 'opaque-participant-token', grants, binding, roomOptions };
  await participant.connect(input);
  await participant.connect(input);
  assert.equal(state.connects.length, 1);
  await assert.rejects(participant.connect({ ...input, identity: 'other-identity' }), /LIVEKIT_PARTICIPANT_BINDING_CONFLICT/);
});

test('connected idempotency compares token, grants, room options, and opaque provenance fail-closed', async () => {
  const { room, state } = roomState();
  const participant = new LiveKitCloudParticipant(room);
  const input = {
    projectUrl: 'wss://project.livekit.cloud', roomName: 'gateway-room', identity: 'gateway-identity',
    token: 'opaque-participant-token', grants, binding, roomOptions,
  };
  await participant.connect(input);
  await participant.connect({ ...input, grants: { ...grants }, roomOptions: { ...roomOptions, encryption: { ...roomOptions.encryption } } });
  assert.equal(state.connects.length, 1);
  await assert.rejects(participant.connect({ ...input, token: 'different-participant-token' }), /LIVEKIT_PARTICIPANT_BINDING_CONFLICT/);
  await assert.rejects(participant.connect({ ...input, grants: { ...grants, canSubscribe: false } }), /LIVEKIT_PARTICIPANT_BINDING_CONFLICT/);
  let rootGetterReads = 0;
  const hostileRootOptions = Object.defineProperty({}, 'encryption', {
    get() { rootGetterReads += 1; return {}; },
  });
  await assert.rejects(participant.connect({ ...input, roomOptions: hostileRootOptions }), /LIVEKIT_E2EE_OPTIONS_REQUIRED/);
  assert.equal(rootGetterReads, 0);

  class EmptyKeyProvider {}
  const providerA = new EmptyKeyProvider();
  const providerB = new EmptyKeyProvider();
  const opaqueOptions = { encryption: { keyProviderOptions: providerA } };
  const opaqueParticipant = new LiveKitCloudParticipant(roomState().room);
  const opaqueInput = { ...input, roomOptions: opaqueOptions };
  await opaqueParticipant.connect(opaqueInput);
  await assert.rejects(
    opaqueParticipant.connect({ ...opaqueInput, roomOptions: { encryption: { keyProviderOptions: providerB } } }),
    /LIVEKIT_PARTICIPANT_BINDING_CONFLICT/,
  );

  let getterReads = 0;
  const hostileKeyOptions = Object.defineProperty({}, 'key', {
    get() { getterReads += 1; return 'must-not-read'; },
  });
  await assert.rejects(
    opaqueParticipant.connect({ ...opaqueInput, roomOptions: { encryption: { keyProviderOptions: hostileKeyOptions } } }),
    /LIVEKIT_PARTICIPANT_PROVENANCE_INVALID/,
  );
  assert.equal(getterReads, 0);

  const secretRoom = roomState();
  const secretParticipant = new LiveKitCloudParticipant(secretRoom.room);
  const secretToken = 'JWT-secret-token-must-not-escape';
  const secretKey = 'E2EE-key-material-must-not-escape';
  const secretInput = {
    ...input,
    token: secretToken,
    roomOptions: { encryption: { keyProviderOptions: { secretKey } } },
  };
  await secretParticipant.connect(secretInput);
  assert.equal(JSON.stringify(secretParticipant.snapshot()).includes(secretToken), false);
  assert.equal(JSON.stringify(secretParticipant.snapshot()).includes(secretKey), false);
  let errorText = '';
  try {
    await secretParticipant.connect({ ...secretInput, token: 'JWT-different-token' });
  } catch (error) {
    errorText = String(error);
  }
  assert.equal(errorText.includes(secretToken), false);
  assert.equal(errorText.includes(secretKey), false);
});

test('participant rejects non-Cloud URL, malformed epoch, and invalid grant room', async () => {
  const { room } = roomState();
  const participant = new LiveKitCloudParticipant(room);
  const input = { projectUrl: 'ws://127.0.0.1:7880', roomName: 'gateway-room', identity: 'gateway-identity', token: 'opaque-participant-token', grants, binding, roomOptions };
  await assert.rejects(participant.connect(input), /INVALID_LIVEKIT_CLOUD_URL/);
  await assert.rejects(participant.connect({ ...input, projectUrl: 'wss://project.livekit.cloud', binding: { ...binding, connectionEpoch: '0' } }), /LIVEKIT_PARTICIPANT_BINDING_INVALID/);
  await assert.rejects(participant.connect({ ...input, projectUrl: 'wss://project.livekit.cloud', grants: { ...grants, room: 'other-room' } }), /LIVEKIT_PARTICIPANT_GRANTS_INVALID/);
  await assert.rejects(participant.connect({ ...input, projectUrl: 'wss://project.livekit.cloud', roomOptions: { e2ee: {} } }), /LIVEKIT_E2EE_OPTIONS_REQUIRED/);
  await assert.rejects(participant.connect({ ...input, projectUrl: 'wss://project.livekit.cloud', roomOptions: {} }), /LIVEKIT_E2EE_OPTIONS_REQUIRED/);
  await assert.rejects(participant.connect({ ...input, projectUrl: 'wss://project.livekit.cloud', roomOptions: { encryption: null } }), /LIVEKIT_E2EE_OPTIONS_REQUIRED/);
  await assert.rejects(participant.connect({ ...input, projectUrl: 'wss://project.livekit.cloud', roomOptions: { encryption: undefined } }), /LIVEKIT_E2EE_OPTIONS_REQUIRED/);
});

test('participant exposes reconnect and encryption error transport state without claiming room recovery', async () => {
  const { room, listeners } = roomState();
  const participant = new LiveKitCloudParticipant(room);
  await participant.connect({ projectUrl: 'wss://project.livekit.cloud', roomName: 'gateway-room', identity: 'gateway-identity', token: 'opaque-participant-token', grants, binding, roomOptions });
  listeners.get('reconnecting')?.();
  assert.equal(participant.snapshot().transportState, 'reconnecting');
  assert.equal(participant.snapshot().connected, true, 'reconnect retains SDK ownership for explicit new Start cleanup');
  listeners.get('reconnected')?.();
  assert.equal(participant.snapshot().transportState, 'reconnecting', 'SDK recovery alone cannot admit the participant');
  participant.setReconnectAdmissionGuard(async () => {});
  listeners.get('reconnected')?.();
  await setImmediate();
  assert.equal(participant.snapshot().transportState, 'reconnected');
  listeners.get('encryptionError')?.();
  assert.equal(participant.snapshot().transportState, 'encryption_error');
  listeners.get('disconnected')?.();
  assert.deepEqual(participant.snapshot(), { connected: false, transportState: 'disconnected' });
  await participant.disconnect();
  assert.deepEqual(participant.snapshot(), { connected: false, transportState: 'disconnected' });
});

test('disconnect and close are idempotent and clear participant state', async () => {
  const { room, state } = roomState();
  const participant = new LiveKitCloudParticipant(room);
  await participant.connect({ projectUrl: 'wss://project.livekit.cloud', roomName: 'gateway-room', identity: 'gateway-identity', token: 'opaque-participant-token', grants, binding, roomOptions });
  await Promise.all([participant.disconnect(), participant.disconnect()]);
  await participant.close();
  await participant.close();
  assert.equal(state.disconnects, 1);
  assert.equal(state.removed, 1);
  assert.deepEqual(participant.snapshot(), { connected: false, transportState: 'disconnected' });
});

test('owner cleanup unpublishes every local track and verifies closure without deleting the room', async () => {
  const calls: string[] = [];
  const publications = new Map<string, unknown>([['video-sid', {}], ['audio-sid', {}]]);
  const listeners = new Map<string, (...args: readonly unknown[]) => void>();
  const room: LiveKitCloudRoomPort = {
    localParticipant: {
      trackPublications: publications,
      async unpublishTrack(trackSid) {
        calls.push(trackSid);
        publications.delete(trackSid);
      },
    },
    async connect() {},
    async disconnect() {},
    on(event, listener) { listeners.set(event, listener); },
    removeAllListeners() {},
  };
  const participant = new LiveKitCloudParticipant(room);
  await participant.connect({ projectUrl: 'wss://project.livekit.cloud', roomName: 'gateway-room', identity: 'gateway-identity', token: 'opaque-participant-token', grants, binding, roomOptions });
  await participant.unpublishAllTracks();
  assert.deepEqual(calls, ['audio-sid', 'video-sid']);
  await assert.rejects(participant.verifyClosed(), /LIVEKIT_PARTICIPANT_CLOSURE_UNVERIFIED/);
  listeners.get('disconnected')?.();
  await participant.verifyClosed();
});

test('reconnect admission guard allows a current fence and disconnects a fenced participant', async () => {
  const first = roomState();
  const participant = new LiveKitCloudParticipant(first.room);
  await participant.connect({ projectUrl: 'wss://project.livekit.cloud', roomName: 'gateway-room', identity: 'gateway-identity', token: 'opaque-participant-token', grants, binding, roomOptions });
  let admissions = 0;
  participant.setReconnectAdmissionGuard(async (current) => {
    admissions += 1;
    assert.equal(current.connectionEpoch, '1');
  });
  first.listeners.get('reconnected')?.();
  await setImmediate();
  assert.equal(admissions, 1);
  assert.equal(participant.snapshot().transportState, 'reconnected');
  await participant.close();

  const fenced = roomState();
  const fencedParticipant = new LiveKitCloudParticipant(fenced.room);
  await fencedParticipant.connect({ projectUrl: 'wss://project.livekit.cloud', roomName: 'gateway-room', identity: 'gateway-identity', token: 'opaque-participant-token', grants, binding, roomOptions });
  fencedParticipant.setReconnectAdmissionGuard(async () => { throw new Error('CREDENTIAL_FENCE_ACTIVE'); });
  fenced.listeners.get('reconnected')?.();
  await setImmediate();
  assert.equal(fencedParticipant.snapshot().connected, false);
  assert.equal(fenced.state.disconnects, 1);
  await fencedParticipant.close();
});

test('superseded reconnect checks cannot admit or disconnect a newer generation; close cancels pending borrowers', {timeout:3000}, async () => {
  for(const stale of ['resolve','reject'] as const){
    const fixture=listenerOnlyRoom(),participant=new LiveKitCloudParticipant(fixture.room),key=new Uint8Array(32).fill(7);
    await participant.connect({projectUrl:'wss://project.livekit.cloud',roomName:'gateway-room',identity:'gateway-identity',token:'opaque-participant-token',
      grants,binding,roomOptions:{encryption:{keyProviderOptions:{sharedKey:key}}}});
    const checks=Array.from({length:3},()=>Promise.withResolvers<void>());let n=0;
    participant.setReconnectAdmissionGuard(()=>checks[n++]!.promise);
    fixture.emit('reconnecting');fixture.emit('reconnected');
    fixture.emit('reconnecting');fixture.emit('reconnected');
    if(stale==='resolve')checks[0]!.resolve();else checks[0]!.reject(new Error('STALE_FENCE_REJECTION'));
    await setImmediate();
    await assert.rejects(participant.withEncryptionKey(async()=>{}),/KEY_UNAVAILABLE/);
    assert.equal(fixture.state.disconnects,0,'obsolete checks have no transport authority');
    checks[1]!.resolve();await setImmediate();await participant.withEncryptionKey(async current=>assert.equal(current,key));
    fixture.emit('reconnecting');fixture.emit('reconnected');
    await participant.close();checks[2]!.resolve();await setImmediate();
    await assert.rejects(participant.withEncryptionKey(async()=>{}),/KEY_UNAVAILABLE/);
    assert.equal(participant.snapshot().connected,false,'a late success cannot reopen a stopped generation');
  }
});

test('close removes room listeners even when SDK disconnect fails', async () => {
  const { room, state } = roomState(true);
  const participant = new LiveKitCloudParticipant(room);
  await participant.connect({ projectUrl: 'wss://project.livekit.cloud', roomName: 'gateway-room', identity: 'gateway-identity', token: 'opaque-participant-token', grants, binding, roomOptions });
  await assert.rejects(participant.close(),(error:Error)=>{
    assert.equal(error.message,'LIVEKIT_PARTICIPANT_DISCONNECT_FAILED');
    assert.equal((error.cause as Error).message,'ROOM_DISCONNECT_FAILED');return true;
  });
  assert.equal(state.removed, 1);
  assert.deepEqual(participant.snapshot(), { connected: false, transportState: 'disconnected' });
});

test('participant disconnect cancels passive recovery observation while retaining the last owner binding internally', async () => {
  const { room, state } = roomState();
  const participant = new LiveKitCloudParticipant(room);
  await participant.connect({
    projectUrl: 'wss://project.livekit.cloud', roomName: 'gateway-room', identity: 'gateway-identity',
    token: 'opaque-participant-token', grants, binding, roomOptions,
  });
  const observer = new LiveKitCloudRecoveryObserver(participant, room);
  await participant.disconnect();
  assert.equal(state.disconnects, 1);
  assert.equal(observer.snapshot().active, false);
  assert.equal(observer.snapshot().closed, true);
  assert.equal(participant.snapshot().connected, false);
  assert.equal(participant.bindingSnapshot()?.connectionEpoch, '1');
});

test('concurrent same connect input shares one promise while a flight conflict fails closed and a failed flight clears', async () => {
  const gate = delayedRoom();
  const participant = new LiveKitCloudParticipant(gate.room);
  const input = {
    projectUrl: 'wss://project.livekit.cloud', roomName: 'gateway-room', identity: 'gateway-identity',
    token: 'opaque-participant-token', grants, binding, roomOptions,
  };
  const first = participant.connect(input);
  const same = participant.connect({
    ...input,
    grants: { ...grants, canPublishSources: [...grants.canPublishSources] },
    binding: { ...binding },
    roomOptions: { ...roomOptions, encryption: { ...roomOptions.encryption } },
  });
  assert.strictEqual(first, same);
  assert.equal(gate.state.connects, 1);
  await assert.rejects(
    participant.connect({ ...input, binding: { ...binding, connectionEpoch: '2' } }),
    /LIVEKIT_PARTICIPANT_CONNECT_FLIGHT_CONFLICT/,
  );
  gate.releaseConnect();
  await Promise.all([first, same]);

  const failedGate = delayedRoom(true);
  const failed = new LiveKitCloudParticipant(failedGate.room);
  await assert.rejects(failed.connect(input), /LIVEKIT_PARTICIPANT_CONNECT_FAILED/);
  assert.equal(failed.snapshot().connected, false);

  const retry = retryRoom();
  const retryParticipant = new LiveKitCloudParticipant(retry.room);
  await assert.rejects(retryParticipant.connect(input), /LIVEKIT_PARTICIPANT_CONNECT_FAILED/);
  const secondAttempt = retryParticipant.connect(input);
  assert.equal(retry.attempts, 2);
  retry.releaseSecond();
  await secondAttempt;
});

test('delayed connect followed by disconnect converges the late SDK success and never commits connected', async () => {
  const gate = delayedRoom();
  const participant = new LiveKitCloudParticipant(gate.room);
  const input = {
    projectUrl: 'wss://project.livekit.cloud', roomName: 'gateway-room', identity: 'gateway-identity',
    token: 'opaque-participant-token', grants, binding, roomOptions,
  };
  const connecting = participant.connect(input);
  const stopping = participant.disconnect();
  assert.deepEqual(participant.snapshot(), { connected: false, transportState: 'disconnected' });
  gate.releaseConnect();
  await assert.rejects(connecting, /LIVEKIT_PARTICIPANT_CONNECT_CANCELLED/);
  await stopping;
  assert.equal(gate.state.connects, 1);
  assert.equal(gate.state.disconnects, 1);
  assert.deepEqual(participant.snapshot(), { connected: false, transportState: 'disconnected' });
});

test('delayed connect followed by close cannot resurrect a permanently closed participant', async () => {
  const gate = delayedRoom();
  const participant = new LiveKitCloudParticipant(gate.room);
  const input = {
    projectUrl: 'wss://project.livekit.cloud', roomName: 'gateway-room', identity: 'gateway-identity',
    token: 'opaque-participant-token', grants, binding, roomOptions,
  };
  const connecting = participant.connect(input);
  const closing = participant.close();
  gate.releaseConnect();
  await assert.rejects(connecting, /LIVEKIT_PARTICIPANT_CONNECT_CANCELLED/);
  await closing;
  assert.equal(gate.state.disconnects, 1);
  assert.equal(gate.state.removed, 1);
  assert.equal(participant.snapshot().connected, false);
  await assert.rejects(participant.connect(input), /LIVEKIT_PARTICIPANT_CLOSED/);
});

test('SDK listeners are fenced after disconnect and removed on close even without removeAllListeners', async () => {
  const fixture = listenerOnlyRoom();
  const participant = new LiveKitCloudParticipant(fixture.room);
  const input = {
    projectUrl: 'wss://project.livekit.cloud', roomName: 'gateway-room', identity: 'gateway-identity',
    token: 'opaque-participant-token', grants, binding, roomOptions,
  };
  await participant.connect(input);
  await participant.disconnect();
  fixture.emit('reconnected');
  assert.deepEqual(participant.snapshot(), { connected: false, transportState: 'disconnected' });

  await participant.connect(input);
  const offBeforeClose = fixture.state.offCalls;
  await participant.close();
  assert.ok(fixture.state.offCalls > offBeforeClose);
  fixture.emit('reconnected');
  assert.deepEqual(participant.snapshot(), { connected: false, transportState: 'disconnected' });
});
