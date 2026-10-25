import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {check} from './contracts.ts';

// One configuration root for both entrypoints. Secrets remain files, never JSON values.
export async function loadHostConfiguration(path: string): Promise<unknown> {
  const root = resolve(process.env.PAIOS_CONFIG_ROOT ?? dirname(resolve(path)));
  const expand = (value: unknown, key = ''): unknown => {
    if (Array.isArray(value)) return value.map(item => expand(item, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, expand(item, name)]));
    if (key === 'legacy_public_api_urls' && value === '${PAIOS_LEGACY_PUBLIC_API_URLS}') return process.env.PAIOS_LEGACY_PUBLIC_API_URLS ?? '';
    if (typeof value !== 'string' || !(key==='environment_id'||/^(?:path|file|profile_home|native_profile_home|host|endpoint|port)$|_(?:file|dir|root|port|url)$/u.test(key))) return value;
    const text = value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/gu, (_, name: string) => {
      const variable = name === 'PAIOS_CONFIG_ROOT' ? root : process.env[name];
      check(variable !== undefined && variable.length > 0, 'HOST_CONFIG_ENV_REQUIRED:' + name);
      return variable;
    });
    if (/^(?:path|file|profile_home|native_profile_home)$|_(?:file|dir|root)$/u.test(key)) return resolve(root, text);
    return /(?:^|_)port$/u.test(key) ? Number(text) : text;
  };
  return expand(JSON.parse(await readFile(path, 'utf8')));
}
