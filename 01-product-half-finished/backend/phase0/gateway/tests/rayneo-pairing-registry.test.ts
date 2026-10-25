// Synthetic gateway trust root for the pairing fixture.
process.env.PAIOS_GATEWAY_ROOT_SPKI_SHA256 = 'a1'.repeat(32);
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  RayneoPairingRegistry,
  canonicalRayneoPairingRecordBytes,
  parseRayneoPairingRecord,
  type PairingRegistryIo,
  type RayneoPairingRecord,
} from '../src/rayneo-pairing-registry.ts';

test('Windows ACL construction uses SID objects so service and built-in identities do not require name translation', () => {
  const source = readFileSync(new URL('../src/rayneo-pairing-registry.ts', import.meta.url), 'utf8');
  assert.match(source, /SecurityIdentifier\]::new\(\$identity\)/u);
  assert.match(source, /FileSystemAccessRule\]::new\(\$principal,/u);
  assert.match(source, /\$item\.SetAccessControl\(\$acl\)/u);
  assert.doesNotMatch(source, /Set-Acl/u);
  assert.doesNotMatch(source, /Get-Acl/u);
  assert.match(source, /PAIRING_REGISTRY_ACL_APPLY_FAILED/u);
  assert.match(source, /PAIRING_REGISTRY_ACL_VERIFY_FAILED/u);
  assert.doesNotMatch(source, /FileSystemAccessRule\(\$identity,/u);
});

const PATH = '/fixture/paired-device.v1.json';
const PAIRED_AT = '2026-08-12T03:00:00.000Z';
const REVOKED_AT = '2026-08-12T03:01:00.000Z';

function pairedRecord(): RayneoPairingRecord {
  return {
    schema: 'paios.rayneo.pairing.registry.v1',
    generation: 1,
    state: 'paired',
    install_id: 'rayneo_install_aaaaaaaaaaaaaaaaaaaa',
    device_id: 'rayneo_device_bbbbbbbbbbbbbbbbbbbb',
    key_id: 'c'.repeat(64),
    public_key_spki_b64url: 'A'.repeat(122),
    gateway_hostname: 'paios-gateway.local',
    root_spki_sha256: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
    paired_at_utc: PAIRED_AT,
    revoked_at_utc: null,
    revoke_reason: null,
  };
}

class FakeIo implements PairingRegistryIo {
  readonly files = new Map<string, Buffer>();
  readonly directories = new Set<string>();
  readonly calls: string[] = [];
  failAclPath?: string;
  failVerifyAclPath?: string;
  exists(path: string): boolean { return this.files.has(path) || this.directories.has(path); }
  ensureDirectory(path: string): void { this.calls.push(`mkdir:${path}`); this.directories.add(path); }
  list(path: string): readonly string[] {
    const prefix = path + '/';
    return [...this.files.keys()].filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes('/'))
      .map((candidate) => candidate.slice(prefix.length));
  }
  read(path: string): Buffer {
    const value = this.files.get(path);
    if (!value) throw new Error('missing');
    return Buffer.from(value);
  }
  assertSafeDirectory(path: string): void { this.calls.push(`safe-dir:${path}`); if (!this.directories.has(path)) throw new Error('unsafe'); }
  assertSafeFile(path: string): void { this.calls.push(`safe-file:${path}`); if (!this.files.has(path)) throw new Error('unsafe'); }
  createNewFlushed(path: string, bytes: Buffer): void {
    this.calls.push(`create-flush:${path}`);
    if (this.files.has(path)) throw new Error('exists');
    this.files.set(path, Buffer.from(bytes));
  }
  applyAndVerifyProtectedAcl(path: string): void {
    this.calls.push(`acl:${path}`);
    if (path === this.failAclPath) throw new Error('acl-failure');
  }
  verifyProtectedAcl(path: string): void {
    this.calls.push(`verify-acl:${path}`);
    if (path === this.failVerifyAclPath) throw new Error('acl-drift');
  }
  replaceWriteThrough(source: string, destination: string): void {
    this.calls.push(`replace:${source}->${destination}`);
    const value = this.files.get(source);
    if (!value) throw new Error('missing');
    this.files.set(destination, value);
    this.files.delete(source);
  }
  remove(path: string): void { this.calls.push(`remove:${path}`); this.files.delete(path); }
}

test('registry bytes are compact ordered UTF-8 with one LF and strict round-trip', () => {
  const record = pairedRecord();
  const bytes = canonicalRayneoPairingRecordBytes(record);
  assert.equal(bytes.at(-1), 0x0a);
  assert.notEqual(bytes.at(-2), 0x0a);
  assert.deepEqual(parseRayneoPairingRecord(bytes), record);
  assert.throws(() => parseRayneoPairingRecord(Buffer.concat([bytes, Buffer.from('\n')])), /BYTES_INVALID/u);
  const extra = Buffer.from(bytes.toString().replace('"generation":1', '"foreign":true,"generation":1'));
  assert.throws(() => parseRayneoPairingRecord(extra), /INVALID/u);
  const reordered = Buffer.from(bytes.toString().replace('"schema":"paios.rayneo.pairing.registry.v1","generation":1', '"generation":1,"schema":"paios.rayneo.pairing.registry.v1"'));
  assert.throws(() => parseRayneoPairingRecord(reordered), /INVALID/u);
});

test('atomic pairing applies protected ACL before write-through replace and exact readback', () => {
  const io = new FakeIo();
  const registry = new RayneoPairingRegistry({ path: PATH, io });
  const record = registry.writePaired({
    installId: pairedRecord().install_id,
    deviceId: pairedRecord().device_id,
    keyId: pairedRecord().key_id,
    publicKeySpkiB64url: pairedRecord().public_key_spki_b64url,
    pairedAtUtc: PAIRED_AT,
  });
  assert.deepEqual(record, pairedRecord());
  assert.ok(io.calls.includes('safe-dir:/fixture'));
  assert.equal(io.directories.has('.'), false);
  assert.deepEqual(registry.read(), record);
  assert.equal(io.files.has(PATH + '.new'), false);
  const createIndex = io.calls.findIndex((value) => value === `create-flush:${PATH}.new`);
  const newAclIndex = io.calls.findIndex((value) => value === `acl:${PATH}.new`);
  const replaceIndex = io.calls.findIndex((value) => value.startsWith('replace:'));
  assert.ok(createIndex >= 0 && createIndex < newAclIndex && newAclIndex < replaceIndex);
});

test('ACL failure removes partial .new and never publishes registry', () => {
  const io = new FakeIo();
  io.failAclPath = PATH + '.new';
  const registry = new RayneoPairingRegistry({ path: PATH, io });
  assert.throws(() => registry.writePaired({
    installId: pairedRecord().install_id,
    deviceId: pairedRecord().device_id,
    keyId: pairedRecord().key_id,
    publicKeySpkiB64url: pairedRecord().public_key_spki_b64url,
    pairedAtUtc: PAIRED_AT,
  }), /acl-failure/u);
  assert.equal(io.files.has(PATH), false);
  assert.equal(io.files.has(PATH + '.new'), false);
});

test('revoke increments generation and records only the closed public disposition', () => {
  const io = new FakeIo();
  const registry = new RayneoPairingRegistry({ path: PATH, io });
  registry.writePaired({
    installId: pairedRecord().install_id,
    deviceId: pairedRecord().device_id,
    keyId: pairedRecord().key_id,
    publicKeySpkiB64url: pairedRecord().public_key_spki_b64url,
    pairedAtUtc: PAIRED_AT,
  });
  const revoked = registry.revoke({
    deviceId: pairedRecord().device_id,
    keyId: pairedRecord().key_id,
    revokedAtUtc: REVOKED_AT,
  });
  assert.equal(revoked.generation, 2);
  assert.equal(revoked.state, 'revoked');
  assert.equal(revoked.revoked_at_utc, REVOKED_AT);
  assert.equal(revoked.revoke_reason, 'owner_revoke');
  const text = io.files.get(PATH)!.toString('utf8');
  for (const forbidden of ['capability', 'bearer', 'short_code', 'challenge', 'nonce', 'signature', 'session_id', 'source_ip']) {
    assert.equal(text.includes(forbidden), false);
  }
});

test('partial or foreign registry directory contents fail closed', () => {
  const io = new FakeIo();
  io.directories.add('/fixture');
  io.files.set(PATH + '.new', Buffer.from('{}'));
  const registry = new RayneoPairingRegistry({ path: PATH, io });
  assert.throws(() => registry.read(), /PARTIAL_WRITE/u);
  io.files.delete(PATH + '.new');
  io.files.set('/fixture/foreign.txt', Buffer.from('x'));
  assert.throws(() => registry.read(), /FOREIGN_ENTRY/u);
});

test('existing registry ACL drift fails closed without applying a repair', () => {
  const io = new FakeIo();
  io.directories.add('/fixture');
  io.files.set(PATH, canonicalRayneoPairingRecordBytes(pairedRecord()));
  io.failVerifyAclPath = PATH;
  const registry = new RayneoPairingRegistry({ path: PATH, io });
  assert.throws(() => registry.read(), /acl-drift/u);
  assert.equal(io.calls.some((call) => call === `acl:${PATH}`), false);
});
