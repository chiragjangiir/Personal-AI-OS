/**
 * Private implementation types for the public RTC static core.
 *
 * These declarations are intentionally internal, non-canonical, and
 * non-wire.  They are an adapter seam for a future T01-owned contract (or an
 * opaque typed port) and must never be serialised as a replacement for that
 * contract.  In particular, `continuityId` is only an opaque value consumed
 * by this seam; this module defines no second continuity field.
 */

declare const opaqueIdentifierBrand: unique symbol;
declare const opaqueExternalAliasBrand: unique symbol;
declare const signedAccessTokenBrand: unique symbol;
declare const roomOptionsReferenceBrand: unique symbol;
declare const canonicalProjectUrlBrand: unique symbol;

/** An opaque identifier supplied by an owner port.  It has no wire meaning here. */
export type InternalOpaqueIdentifier = string & {
  readonly [opaqueIdentifierBrand]: 'public-rtc-internal-opaque-identifier';
};

/**
 * A value owned by a future T01 port.  The adapter deliberately does not
 * model its fields: refs may be objects and a continuity ID may be a UUIDv7
 * string.  This is an implementation boundary, not a canonical schema.
 */
export type InternalOpaqueOwnerValue = string | object;

/** An external transport alias supplied by an owner port, with no local shape. */
export type InternalOpaqueExternalAlias = InternalOpaqueOwnerValue & {
  readonly [opaqueExternalAliasBrand]: 'public-rtc-internal-external-alias';
};

/** A signed token handle returned by an injected signer; never persisted here. */
export type InternalSignedAccessToken = string & {
  readonly [signedAccessTokenBrand]: 'public-rtc-internal-signed-access-token';
};

/** An opaque reference to SDK room options, including optional E2EE options. */
export type InternalRoomOptionsReference = object & {
  readonly [roomOptionsReferenceBrand]: 'public-rtc-internal-room-options-reference';
};

/** The only URL form this adapter accepts. */
export type CanonicalLiveKitCloudProjectUrl = string & {
  readonly [canonicalProjectUrlBrand]: 'public-rtc-livekit-cloud-project-url';
};

/**
 * Owner-provided identity/binding seam.
 *
 * The four values correspond to already-owned opaque values.  No canonical
 * schema is defined or reconstructed by this package.
 */
export interface LiveKitCloudMediaBinding<TOpaqueOwnerValue extends InternalOpaqueOwnerValue = InternalOpaqueOwnerValue> {
  readonly realtimeSessionRef: TOpaqueOwnerValue;
  readonly deviceLeaseRef: TOpaqueOwnerValue;
  readonly continuityId: TOpaqueOwnerValue;
  readonly transportAliases: readonly TOpaqueOwnerValue[];
}

export type InternalLiveKitMediaSource = 'microphone' | 'camera' | 'screen_share';

/**
 * Least-privilege media grant description passed to the injected signer.
 * Unknown/admin grants are rejected by the adapter before signing.
 */
export interface LiveKitCloudGrantPolicy {
  readonly room: InternalOpaqueIdentifier;
  readonly roomJoin: true;
  readonly canPublish: boolean;
  readonly canSubscribe: boolean;
  /** LiveKit data-packet permission, always explicit. */
  readonly canPublishData: boolean;
  /** LiveKit track sources, explicit so `canPublish: true` never means all. */
  readonly canPublishSources: readonly InternalLiveKitMediaSource[];
}

export interface LiveKitCloudTokenRequest {
  readonly room: InternalOpaqueIdentifier;
  readonly identity: InternalOpaqueIdentifier;
  readonly ttlSeconds: number;
  readonly grants: LiveKitCloudGrantPolicy;
}

/** The signer owns all provider credentials; this seam receives no key material. */
export interface LiveKitCloudTokenSignerPort {
  sign(request: LiveKitCloudTokenRequest): Promise<InternalSignedAccessToken>;
}

/**
 * Minimal room port backed by the LiveKit SDK by the caller.  This package
 * never constructs SDK encryption primitives; the opaque options reference is
 * forwarded unchanged when supplied.
 */
export interface LiveKitCloudRoomPort {
  connect(
    projectUrl: CanonicalLiveKitCloudProjectUrl,
    token: InternalSignedAccessToken,
    roomOptionsReference: InternalRoomOptionsReference,
  ): Promise<void>;
  disconnect(): Promise<void>;
}

export interface LiveKitCloudAdapterPorts {
  readonly room: LiveKitCloudRoomPort;
  readonly tokenSigner: LiveKitCloudTokenSignerPort;
}

export interface LiveKitCloudConnectInput<TOpaqueOwnerValue extends InternalOpaqueOwnerValue = InternalOpaqueOwnerValue> {
  readonly projectUrl: string;
  readonly roomName: InternalOpaqueIdentifier;
  readonly identity: InternalOpaqueIdentifier;
  readonly binding: LiveKitCloudMediaBinding<TOpaqueOwnerValue>;
  readonly ttlSeconds: number;
  readonly grants: LiveKitCloudGrantPolicy;
  readonly e2eeRoomOptionsReference: InternalRoomOptionsReference;
}

export interface LiveKitCloudAdapterOptions {
  readonly ports: LiveKitCloudAdapterPorts;
  readonly nowEpochSeconds?: () => number;
}

export interface LiveKitCloudConnection {
  readonly projectUrl: CanonicalLiveKitCloudProjectUrl;
  readonly roomName: InternalOpaqueIdentifier;
  readonly identity: InternalOpaqueIdentifier;
  readonly expiresAtEpochSeconds: number;
  readonly transport: 'livekit-cloud-direct';
  readonly disconnect: () => Promise<void>;
}
