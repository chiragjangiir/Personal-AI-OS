import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { check, ContractError } from '../contracts.ts';

const MAGIC = Buffer.from('PAIOSVP1'), AAD = Buffer.from('paios.voiceprint.registry.v2');
export interface RegistryCipher {
  seal(plaintext: Uint8Array): Uint8Array;
  open(envelope: Uint8Array): Uint8Array;
}
export function isSealedRegistry(bytes: Uint8Array): boolean {
  return Buffer.from(bytes).subarray(0, MAGIC.length).equals(MAGIC);
}
/** One app-level registry key; canonical base64 with an optional final line ending. */
export async function loadRegistryCipher(keyFile: string): Promise<RegistryCipher> {
  const encoded = (await readFile(keyFile, 'utf8')).replace(/\r?\n$/u, '');
  const key = Buffer.from(encoded, 'base64');
  check(key.length === 32 && key.toString('base64') === encoded, 'VOICEPRINT_REGISTRY_KEY_INVALID', 503);
  const keyId = createHash('sha256').update(key).digest().subarray(0, 8);
  return {
    seal(plaintext) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(AAD);
      return Buffer.concat([MAGIC, keyId, iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    },
    open(envelope) {
      const bytes = Buffer.from(envelope);
      check(bytes.length >= 44 && isSealedRegistry(bytes), 'VOICEPRINT_REGISTRY_CORRUPT', 503);
      check(timingSafeEqual(bytes.subarray(8, 16), keyId), 'VOICEPRINT_REGISTRY_KEY_MISMATCH', 503);
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(16, 28));
      decipher.setAAD(AAD); decipher.setAuthTag(bytes.subarray(-16));
      try { return Buffer.concat([decipher.update(bytes.subarray(28, -16)), decipher.final()]); }
      catch { throw new ContractError('VOICEPRINT_REGISTRY_CORRUPT', 503); }
    },
  };
}
