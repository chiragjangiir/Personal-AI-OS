import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { barkEncrypt, createBarkNotifier } from '../src/bark-notifier.ts';

const KEY = 'k'.repeat(16) + '0123456789abcdef';

// What the Bark app does with the key and IV set in its Push Encryption screen (CryptoSwift GCM, combined mode).
function barkDecrypt(ciphertext: string, key: string, iv: string) {
  const sealed = Buffer.from(ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]).toString('utf8'));
}

test('the push carries only ciphertext that the Bark app can open with the shared key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bark-'));
  await writeFile(join(dir, 'device'), 'https://api.day.app/AbCdEf123456/这里改成你自己的推送内容\n');
  await writeFile(join(dir, 'key'), KEY + '\n');
  const sent: {url: string; body: URLSearchParams}[] = [];
  const notify = createBarkNotifier(join(dir, 'device'), join(dir, 'key'), (async (url: string, init: RequestInit) => {
    sent.push({url, body: init.body as URLSearchParams}); return new Response('{"code":200}');
  }) as typeof fetch);
  await notify({title: '依米：办好了', body: '1点点 香柠养乐多，实付 16.6 元'});
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, 'https://api.day.app/AbCdEf123456');
  assert.deepEqual([...sent[0]!.body.keys()].sort(), ['ciphertext', 'iv'], 'no plaintext field leaves the Mac');
  const iv = sent[0]!.body.get('iv')!;
  assert.match(iv, /^[A-Za-z0-9]{12}$/);
  assert.deepEqual(barkDecrypt(sent[0]!.body.get('ciphertext')!, KEY, iv),
    {title: '依米：办好了', body: '1点点 香柠养乐多，实付 16.6 元', group: '依米', url: 'paios://'});
});

test('a missing or malformed setup fails the push, not the gateway', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bark-'));
  const never = (async () => { throw new Error('must not send'); }) as typeof fetch;
  await assert.rejects(createBarkNotifier(join(dir, 'device'), join(dir, 'key'), never)({title: 't', body: 'b'}), {code:'BARK_NOT_CONFIGURED',status:503});
  for(const empty of ['', ' \n']){
    await writeFile(join(dir, 'device'), empty);
    await assert.rejects(createBarkNotifier(join(dir, 'device'), join(dir, 'key'), never)({title: 't', body: 'b'}), {code:'BARK_NOT_CONFIGURED',status:503});
  }
  await writeFile(join(dir, 'device'), 'not a URL');
  await assert.rejects(createBarkNotifier(join(dir, 'device'), join(dir, 'key'), never)({title: 't', body: 'b'}), {code:'BARK_DEVICE_INVALID'});
  await writeFile(join(dir, 'device'), 'https://api.day.app/AbCdEf123456/');
  await writeFile(join(dir, 'key'), 'too-short');
  await assert.rejects(createBarkNotifier(join(dir, 'device'), join(dir, 'key'), never)({title: 't', body: 'b'}), /BARK_KEY_INVALID/);
  assert.equal(barkEncrypt({a: '1'}, KEY, 'AAAAAAAAAAAA').length > 0, true);
});
