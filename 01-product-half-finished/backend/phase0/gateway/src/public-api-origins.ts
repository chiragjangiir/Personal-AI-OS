/** Canonical API origin and bounded migration aliases. Values are exact HTTPS origins. */
export function publicApiOrigins(canonical: string, legacy = ''): readonly string[] {
  const invalid = (): never => { throw new Error('PRODUCT_PUBLIC_API_ORIGINS_INVALID'); };
  if (typeof canonical !== 'string' || typeof legacy !== 'string' || legacy.length > 2048) invalid();
  const aliases = legacy === '' ? [] : legacy.split(',');
  if (aliases.length > 8) invalid();
  const origins = [canonical, ...aliases];
  for (const origin of origins) {
    if (origin.length > 253 || !URL.canParse(origin)) invalid();
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin) invalid();
  }
  if (new Set(origins).size !== origins.length) invalid();
  return Object.freeze(origins);
}

/** Legacy enrollment and pairing use the same public API origin as product resources. */
export function configuredPublicApiOrigin(environment: NodeJS.ProcessEnv = process.env): string {
  const origin = environment.PAIOS_PUBLIC_API_URL;
  if (!origin) throw new Error('PAIOS_PUBLIC_API_URL_REQUIRED');
  return publicApiOrigins(origin)[0]!;
}
