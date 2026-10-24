import { createCipheriv, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { check, ContractError } from '../../../services/personal-aios-integration/src/contracts.ts';

/** A notice for the user's phone while the app is not connected (hung up, closed or in the background). */
export interface Notice {title: string; body: string}
export type Notify = (notice: Notice) => Promise<void>;

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Bark's AES256-GCM "combined" ciphertext (sealed data then tag, base64) of the push fields; key and IV are ASCII,
 *  as the Bark app's Push Encryption settings take them (AES256, GCM, noPadding). */
export function barkEncrypt(fields: Record<string, string>, key: string, iv: string): string {
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  const sealed = Buffer.concat([cipher.update(JSON.stringify(fields), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return sealed.toString('base64');
}

/** Pushes through Bark (MIT, Finb/Bark) to the user's iPhone. Only ciphertext leaves the Mac: the Bark server and
 *  APNs never see the text. Both owner-only files are read per push, so Bark can be set up while the gateway runs:
 *  the device file holds the URL the Bark app shows (https://api.day.app/<device key>/…), the key file the
 *  32-character key entered in Bark. Tapping the notice opens the app (paios://). */
export function createBarkNotifier(deviceFile: string, keyFile: string, fetchImpl: typeof fetch = fetch): Notify {
  return async ({title, body}) => {
    const deviceUrl = await readFile(deviceFile, 'utf8').catch(error => {
      if(error.code === 'ENOENT')throw new ContractError('BARK_NOT_CONFIGURED',503);
      throw error;
    });
    check(deviceUrl.trim(), 'BARK_NOT_CONFIGURED', 503);
    const device = URL.parse(deviceUrl.trim());
    check(device, 'BARK_DEVICE_INVALID');
    const deviceKey = device.pathname.split('/').find(Boolean) ?? '';
    const key = (await readFile(keyFile, 'utf8')).trim();
    check(device.protocol === 'https:' && /^[A-Za-z0-9]{8,64}$/.test(deviceKey), 'BARK_DEVICE_INVALID');
    check(/^[\x21-\x7e]{32}$/.test(key), 'BARK_KEY_INVALID');
    const iv = Array.from(randomBytes(12), byte => ALNUM[byte % ALNUM.length]).join('');
    const ciphertext = barkEncrypt({title: title.slice(0, 60), body: body.slice(0, 1000), group: '依米', url: 'paios://'}, key, iv);
    const response = await fetchImpl(`${device.origin}/${deviceKey}`, {method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({ciphertext, iv}),
      signal: AbortSignal.timeout(10_000)});
    check(response.ok, 'BARK_PUSH_FAILED', 502);
  };
}
