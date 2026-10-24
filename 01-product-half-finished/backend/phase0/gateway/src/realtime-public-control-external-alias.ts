type AliasRecord = Readonly<Record<string, unknown>>;

const MAX_ALIAS_TEXT = 512;
const ALIAS_PART = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ALIAS_KEYS = Object.freeze(['alias_type', 'issuer', 'value', 'provider_id'] as const);
const PROJECTION = Object.freeze([
  ['transport_session', 'transportSessionAlias'],
  ['room', 'roomAlias'],
  ['participant', 'deviceAlias'],
] as const);

export class RealtimeExternalAliasError extends Error {
  readonly code = 'REALTIME_EXTERNAL_ALIAS_INVALID' as const;

  constructor() {
    super('REALTIME_EXTERNAL_ALIAS_INVALID');
    this.name = 'RealtimeExternalAliasError';
  }
}

function fail(): never {
  throw new RealtimeExternalAliasError();
}

function plain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ALIAS_TEXT ||
      value.trim() !== value || value.includes('\u0000')) fail();
  return value;
}

function alias(value: unknown, role: 'transport_session' | 'room' | 'participant'): AliasRecord {
  if (typeof value === 'string') {
    return Object.freeze({ alias_type: role, issuer: 'livekit_cloud', value: text(value) });
  }
  if (!plain(value) || Reflect.ownKeys(value).some((key) => typeof key !== 'string')) fail();
  const keys = Object.keys(value);
  if (keys.length < 3 || keys.length > 4 || keys.some((key) => !ALIAS_KEYS.includes(key as typeof ALIAS_KEYS[number]))) fail();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) fail();
  }
  if (!Object.hasOwn(value, 'alias_type') || !Object.hasOwn(value, 'issuer') || !Object.hasOwn(value, 'value')) fail();
  const aliasType = text(value.alias_type);
  const issuer = text(value.issuer);
  if (!ALIAS_PART.test(aliasType) || !ALIAS_PART.test(issuer)) fail();
  if (role === 'transport_session' && aliasType !== 'transport_session') fail();
  if (role === 'room' && aliasType !== 'room') fail();
  if (role === 'participant' && aliasType !== 'participant' && aliasType !== 'device') fail();
  const result: Record<string, unknown> = {
    alias_type: aliasType,
    issuer,
    value: text(value.value),
  };
  if (Object.hasOwn(value, 'provider_id')) {
    const providerId = text(value.provider_id);
    if (!UUID_V7.test(providerId)) fail();
    result.provider_id = providerId;
  }
  return Object.freeze(result);
}

function identity(value: AliasRecord): string {
  return JSON.stringify({
    alias_type: value.alias_type,
    issuer: value.issuer,
    value: value.value,
    ...(value.provider_id === undefined ? {} : { provider_id: value.provider_id }),
  });
}

function aliasSort(left: AliasRecord, right: AliasRecord): number {
  for (const key of ['alias_type', 'issuer', 'value', 'provider_id'] as const) {
    const compared = Buffer.compare(Buffer.from(String(left[key] ?? ''), 'utf8'), Buffer.from(String(right[key] ?? ''), 'utf8'));
    if (compared !== 0) return compared;
  }
  return 0;
}

/** Normalize the three external transport aliases without minting or rewriting identity. */
export function projectRealtimeExternalAliases(binding: unknown): readonly AliasRecord[] {
  if (!plain(binding)) fail();
  for (const [, key] of PROJECTION) {
    const descriptor = Object.getOwnPropertyDescriptor(binding, key);
    if (descriptor === undefined || !('value' in descriptor)) fail();
  }
  const aliases = PROJECTION.map(([role, key]) => alias(binding[key], role)).sort(aliasSort);
  const identities = aliases.map(identity);
  if (new Set(identities).size !== identities.length) fail();
  return Object.freeze(aliases);
}
