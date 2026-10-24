import test from 'node:test';
import assert from 'node:assert/strict';
import {publicApiOrigins,configuredPublicApiOrigin} from '../src/public-api-origins.ts';

test('public API migration aliases are bounded, exact HTTPS origins', () => {
  const canonical = 'https://bj.example.invalid:9443';
  assert.deepEqual(publicApiOrigins(canonical), [canonical]);
  assert.deepEqual(publicApiOrigins(canonical, 'https://ai.example.invalid'), [canonical, 'https://ai.example.invalid']);
  for (const legacy of ['http://ai.example', 'https://ai.example/', 'https://ai.example:443', 'https://ai.example/path',
    'https://user@ai.example', 'https://ai.example?q=x', 'https://ai.example#x', ' https://ai.example',
    'https://ai.example,', canonical, Array.from({length:9},(_,i)=>`https://old${i}.example`).join(',')]) {
    assert.throws(()=>publicApiOrigins(canonical,legacy), /PRODUCT_PUBLIC_API_ORIGINS_INVALID/);
  }
});

// Legacy consumers require an explicit deployment origin instead of carrying a private default.
test('configured enrollment origin uses the shared canonical-origin contract', () => {
  assert.equal(configuredPublicApiOrigin({PAIOS_PUBLIC_API_URL:'https://ai.example.invalid'}), 'https://ai.example.invalid');
  assert.throws(() => configuredPublicApiOrigin({}), /PAIOS_PUBLIC_API_URL_REQUIRED/);
  assert.throws(() => configuredPublicApiOrigin({PAIOS_PUBLIC_API_URL:'https://ai.example.invalid/path'}), /PRODUCT_PUBLIC_API_ORIGINS_INVALID/);
});
