// Test instrumentation only. Keep official DTOs/enums; prohibit all native entrypoints.
export * from '../node_modules/.pnpm/@livekit+rtc-ffi-bindings@0.12.60/node_modules/@livekit/rtc-ffi-bindings/proto/audio_frame_pb.js';
export * from '../node_modules/.pnpm/@livekit+rtc-ffi-bindings@0.12.60/node_modules/@livekit/rtc-ffi-bindings/proto/data_stream_pb.js';
export * from '../node_modules/.pnpm/@livekit+rtc-ffi-bindings@0.12.60/node_modules/@livekit/rtc-ffi-bindings/proto/data_track_pb.js';
export * from '../node_modules/.pnpm/@livekit+rtc-ffi-bindings@0.12.60/node_modules/@livekit/rtc-ffi-bindings/proto/e2ee_pb.js';
export * from '../node_modules/.pnpm/@livekit+rtc-ffi-bindings@0.12.60/node_modules/@livekit/rtc-ffi-bindings/proto/ffi_pb.js';
export * from '../node_modules/.pnpm/@livekit+rtc-ffi-bindings@0.12.60/node_modules/@livekit/rtc-ffi-bindings/proto/handle_pb.js';
export * from '../node_modules/.pnpm/@livekit+rtc-ffi-bindings@0.12.60/node_modules/@livekit/rtc-ffi-bindings/proto/participant_pb.js';
export * from '../node_modules/.pnpm/@livekit+rtc-ffi-bindings@0.12.60/node_modules/@livekit/rtc-ffi-bindings/proto/room_pb.js';
export * from '../node_modules/.pnpm/@livekit+rtc-ffi-bindings@0.12.60/node_modules/@livekit/rtc-ffi-bindings/proto/rpc_pb.js';
export * from '../node_modules/.pnpm/@livekit+rtc-ffi-bindings@0.12.60/node_modules/@livekit/rtc-ffi-bindings/proto/stats_pb.js';
export * from '../node_modules/.pnpm/@livekit+rtc-ffi-bindings@0.12.60/node_modules/@livekit/rtc-ffi-bindings/proto/track_pb.js';
export * from '../node_modules/.pnpm/@livekit+rtc-ffi-bindings@0.12.60/node_modules/@livekit/rtc-ffi-bindings/proto/track_publication_pb.js';
export * from '../node_modules/.pnpm/@livekit+rtc-ffi-bindings@0.12.60/node_modules/@livekit/rtc-ffi-bindings/proto/video_frame_pb.js';
export class FfiHandle {
  constructor(handle){this.handle=handle;}
  dispose(){throw new Error('CONTROLLED_HANDLE_DISPOSAL_NOT_REGISTERED');}
}
export function livekitInitialize(){throw new Error('NATIVE_INITIALIZE_FORBIDDEN_IN_SOURCE_FIXTURE');}
export function livekitFfiRequest(){throw new Error('NATIVE_REQUEST_FORBIDDEN_IN_SOURCE_FIXTURE');}
export function livekitCopyBuffer(){throw new Error('NATIVE_COPY_FORBIDDEN_IN_SOURCE_FIXTURE');}
export function livekitRetrievePtr(){throw new Error('NATIVE_POINTER_FORBIDDEN_IN_SOURCE_FIXTURE');}
export function livekitDispose(){throw new Error('NATIVE_DISPOSE_FORBIDDEN_IN_SOURCE_FIXTURE');}
