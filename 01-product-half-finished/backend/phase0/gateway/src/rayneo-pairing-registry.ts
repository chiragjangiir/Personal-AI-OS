import { GATEWAY_DATA_ROOT } from './gateway-runtime-paths.ts';
import { spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { posix, resolve, win32 } from 'node:path';
import { assertAppleEnrollmentOwnerProtectedPath } from './apple-production-enrollment-owner.ts';

export const RAYNEO_PAIRING_REGISTRY_PATH =
  resolve(GATEWAY_DATA_ROOT, 'resources/pairing/paired-device.v1.json');

const SCHEMA = 'paios.rayneo.pairing.registry.v1' as const;
const HOSTNAME = 'paios-gateway.local' as const;
function rootSpkiSha256(): string {
  const value = process.env.PAIOS_GATEWAY_ROOT_SPKI_SHA256;
  if (!value || !/^[a-f0-9]{64}$/u.test(value)) throw new Error('PAIOS_GATEWAY_ROOT_SPKI_SHA256_INVALID');
  return value;
}
const INSTALL_ID = /^rayneo_install_[a-f0-9]{20}$/u;
const DEVICE_ID = /^rayneo_device_[a-f0-9]{20}$/u;
const KEY_ID = /^[a-f0-9]{64}$/u;
const SPKI_B64URL = /^[A-Za-z0-9_-]{122}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface RayneoPairingRecord {
  readonly schema: typeof SCHEMA;
  readonly generation: number;
  readonly state: 'paired' | 'revoked';
  readonly install_id: string;
  readonly device_id: string;
  readonly key_id: string;
  readonly public_key_spki_b64url: string;
  readonly gateway_hostname: typeof HOSTNAME;
  readonly root_spki_sha256: string;
  readonly paired_at_utc: string;
  readonly revoked_at_utc: string | null;
  readonly revoke_reason: 'owner_revoke' | null;
}

export interface PairingRegistryIo {
  exists(path: string): boolean;
  ensureDirectory(path: string): void;
  list(path: string): readonly string[];
  read(path: string): Buffer;
  assertSafeDirectory(path: string): void;
  assertSafeFile(path: string): void;
  createNewFlushed(path: string, bytes: Buffer): void;
  applyAndVerifyProtectedAcl(path: string): void;
  verifyProtectedAcl(path: string): void;
  replaceWriteThrough(source: string, destination: string): void;
  remove(path: string): void;
}

export interface PairingRegistryConfig {
  readonly path?: string;
  readonly io?: PairingRegistryIo;
}

export class RayneoPairingRegistry {
  readonly #path: string;
  readonly #directory: string;
  readonly #temporary: string;
  readonly #io: PairingRegistryIo;

  constructor(config: PairingRegistryConfig = {}) {
    this.#path = config.path ?? RAYNEO_PAIRING_REGISTRY_PATH;
    const paths = pairingPathApi(this.#path);
    if (!paths.isAbsolute(this.#path) || paths.resolve(this.#path) !== this.#path ||
        paths.basename(this.#path) !== 'paired-device.v1.json') {
      throw new Error('PAIRING_REGISTRY_PATH_INVALID');
    }
    this.#directory = paths.dirname(this.#path);
    this.#temporary = this.#path + '.new';
    this.#io = config.io ?? createPairingRegistryIo(this.#path);
  }

  read(): RayneoPairingRecord | undefined {
    if (!this.#io.exists(this.#directory)) return undefined;
    this.#io.assertSafeDirectory(this.#directory);
    const entries = [...this.#io.list(this.#directory)].sort();
    if (entries.includes('paired-device.v1.json.new')) {
      throw new Error('PAIRING_REGISTRY_PARTIAL_WRITE');
    }
    if (entries.some((entry) => entry !== 'paired-device.v1.json')) {
      throw new Error('PAIRING_REGISTRY_FOREIGN_ENTRY');
    }
    if (!this.#io.exists(this.#path)) return undefined;
    this.#io.assertSafeFile(this.#path);
    this.#io.verifyProtectedAcl(this.#directory);
    this.#io.verifyProtectedAcl(this.#path);
    return parseRayneoPairingRecord(this.#io.read(this.#path));
  }

  writePaired(input: {
    readonly installId: string;
    readonly deviceId: string;
    readonly keyId: string;
    readonly publicKeySpkiB64url: string;
    readonly pairedAtUtc: string;
  }): RayneoPairingRecord {
    const current = this.read();
    if (current?.state === 'paired') throw new Error('DEVICE_ALREADY_PAIRED');
    if (current?.state === 'revoked') throw new Error('PAIRING_REVOKED');
    return this.#write({
      schema: SCHEMA,
      generation: 1,
      state: 'paired',
      install_id: input.installId,
      device_id: input.deviceId,
      key_id: input.keyId,
      public_key_spki_b64url: input.publicKeySpkiB64url,
      gateway_hostname: HOSTNAME,
      root_spki_sha256: rootSpkiSha256(),
      paired_at_utc: input.pairedAtUtc,
      revoked_at_utc: null,
      revoke_reason: null,
    });
  }

  revoke(input: {
    readonly deviceId: string;
    readonly keyId: string;
    readonly revokedAtUtc: string;
  }): RayneoPairingRecord {
    const current = this.read();
    if (!current || current.device_id !== input.deviceId || current.key_id !== input.keyId) {
      throw new Error('DEVICE_NOT_PAIRED');
    }
    if (current.state === 'revoked') throw new Error('PAIRING_REVOKED');
    return this.#write({
      ...current,
      generation: current.generation + 1,
      state: 'revoked',
      revoked_at_utc: input.revokedAtUtc,
      revoke_reason: 'owner_revoke',
    });
  }

  #write(record: RayneoPairingRecord): RayneoPairingRecord {
    assertRayneoPairingRecord(record);
    const directoryExisted = this.#io.exists(this.#directory);
    this.#io.ensureDirectory(this.#directory);
    this.#io.assertSafeDirectory(this.#directory);
    if (directoryExisted) this.#io.verifyProtectedAcl(this.#directory);
    else this.#io.applyAndVerifyProtectedAcl(this.#directory);
    if (this.#io.exists(this.#temporary)) throw new Error('PAIRING_REGISTRY_PARTIAL_WRITE');
    const bytes = canonicalRayneoPairingRecordBytes(record);
    let temporaryCreated = false;
    try {
      this.#io.createNewFlushed(this.#temporary, bytes);
      temporaryCreated = true;
      this.#io.assertSafeFile(this.#temporary);
      this.#io.applyAndVerifyProtectedAcl(this.#temporary);
      this.#io.replaceWriteThrough(this.#temporary, this.#path);
      temporaryCreated = false;
      this.#io.assertSafeFile(this.#path);
      this.#io.verifyProtectedAcl(this.#path);
      if (this.#io.exists(this.#temporary)) throw new Error('PAIRING_REGISTRY_PARTIAL_WRITE');
      const roundTrip = this.#io.read(this.#path);
      if (!roundTrip.equals(bytes)) throw new Error('PAIRING_REGISTRY_READBACK_DRIFT');
      return parseRayneoPairingRecord(roundTrip);
    } catch (error) {
      if (temporaryCreated && this.#io.exists(this.#temporary)) {
        try { this.#io.remove(this.#temporary); } catch { /* fail remains closed */ }
      }
      throw error;
    }
  }
}

export function canonicalRayneoPairingRecordBytes(record: RayneoPairingRecord): Buffer {
  assertRayneoPairingRecord(record);
  const ordered: RayneoPairingRecord = {
    schema: SCHEMA,
    generation: record.generation,
    state: record.state,
    install_id: record.install_id,
    device_id: record.device_id,
    key_id: record.key_id,
    public_key_spki_b64url: record.public_key_spki_b64url,
    gateway_hostname: HOSTNAME,
    root_spki_sha256: rootSpkiSha256(),
    paired_at_utc: record.paired_at_utc,
    revoked_at_utc: record.revoked_at_utc,
    revoke_reason: record.revoke_reason,
  };
  return Buffer.from(JSON.stringify(ordered) + '\n', 'utf8');
}

export function parseRayneoPairingRecord(bytes: Uint8Array): RayneoPairingRecord {
  const buffer = Buffer.from(bytes);
  if (buffer.byteLength < 2 || buffer[0] === 0xef || buffer.at(-1) !== 0x0a || buffer.at(-2) === 0x0a) {
    throw new Error('PAIRING_REGISTRY_BYTES_INVALID');
  }
  const text = buffer.subarray(0, -1).toString('utf8');
  if (Buffer.from(text, 'utf8').byteLength !== buffer.byteLength - 1) {
    throw new Error('PAIRING_REGISTRY_BYTES_INVALID');
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('PAIRING_REGISTRY_BYTES_INVALID'); }
  if (!plainObject(value)) throw new Error('PAIRING_REGISTRY_BYTES_INVALID');
  const record = value as unknown as RayneoPairingRecord;
  assertRayneoPairingRecord(record);
  if (!canonicalRayneoPairingRecordBytes(record).equals(buffer)) {
    throw new Error('PAIRING_REGISTRY_BYTES_INVALID');
  }
  return Object.freeze({ ...record });
}

function assertRayneoPairingRecord(record: RayneoPairingRecord): void {
  if (!plainObject(record)) throw new Error('PAIRING_REGISTRY_INVALID');
  const exact = [
    'schema', 'generation', 'state', 'install_id', 'device_id', 'key_id',
    'public_key_spki_b64url', 'gateway_hostname', 'root_spki_sha256',
    'paired_at_utc', 'revoked_at_utc', 'revoke_reason',
  ];
  if (Object.keys(record).join('\n') !== exact.join('\n')) throw new Error('PAIRING_REGISTRY_INVALID');
  if (
    record.schema !== SCHEMA || !Number.isSafeInteger(record.generation) || record.generation < 1 ||
    !INSTALL_ID.test(record.install_id) || !DEVICE_ID.test(record.device_id) ||
    !KEY_ID.test(record.key_id) || !SPKI_B64URL.test(record.public_key_spki_b64url) ||
    record.gateway_hostname !== HOSTNAME || record.root_spki_sha256 !== rootSpkiSha256() ||
    !canonicalUtc(record.paired_at_utc)
  ) throw new Error('PAIRING_REGISTRY_INVALID');
  if (record.state === 'paired') {
    if (record.revoked_at_utc !== null || record.revoke_reason !== null) throw new Error('PAIRING_REGISTRY_INVALID');
  } else if (record.state === 'revoked') {
    if (typeof record.revoked_at_utc !== 'string' || !canonicalUtc(record.revoked_at_utc) || record.revoke_reason !== 'owner_revoke') {
      throw new Error('PAIRING_REGISTRY_INVALID');
    }
  } else throw new Error('PAIRING_REGISTRY_INVALID');
}

function canonicalUtc(value: string): boolean {
  return UTC.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function runPowerShell(script: string, target: string, failure: string): void {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000,
    env: { ...process.env, PAIOS_PAIRING_REGISTRY_TARGET: target },
  });
  if (result.status !== 0) throw new Error(failure);
}

function pairingPathApi(path: string): typeof posix {
  return process.platform !== 'win32' && posix.isAbsolute(path) ? posix : win32;
}

export function createPairingRegistryIo(path: string): PairingRegistryIo {
  const io: PairingRegistryIo = {
    exists: existsSync,
    ensureDirectory: (path) => mkdirSync(path, { recursive: true }),
    list: (path) => readdirSync(path),
    read: (path) => readFileSync(path),
    assertSafeDirectory: (path) => assertSafeNode(path, true),
    assertSafeFile: (path) => assertSafeNode(path, false),
    createNewFlushed: (path, bytes) => {
      const descriptor = openSync(path, 'wx', 0o600);
      try {
        let offset = 0;
        while (offset < bytes.byteLength) offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
        fsyncSync(descriptor);
        const stat = fstatSync(descriptor);
        if (!stat.isFile() || stat.size !== bytes.byteLength || stat.nlink !== 1) {
          throw new Error('PAIRING_REGISTRY_FILE_INVALID');
        }
      } finally { closeSync(descriptor); }
    },
    applyAndVerifyProtectedAcl: (path) => runPowerShell(`
$ErrorActionPreference='Stop'
$p=$env:PAIOS_PAIRING_REGISTRY_TARGET
$item=Get-Item -LiteralPath $p -Force
if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'reparse'}
if(-not $item.PSIsContainer){$streams=@(Get-Item -LiteralPath $p -Stream *);if($streams.Count -ne 1 -or $streams[0].Stream -ne ':$DATA'){throw 'ads'}}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl=$item.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
$acl.SetAccessRuleProtection($true,$false)
foreach($rule in @($acl.Access)){[void]$acl.RemoveAccessRuleAll($rule)}
$inherit=if($item.PSIsContainer){[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
foreach($identity in @($sid,'S-1-5-18','S-1-5-32-544')){
  $principal=[Security.Principal.SecurityIdentifier]::new($identity)
  $rule=[Security.AccessControl.FileSystemAccessRule]::new($principal,'FullControl',$inherit,[Security.AccessControl.PropagationFlags]::None,'Allow')
  [void]$acl.AddAccessRule($rule)
}
$item.SetAccessControl($acl)
$check=$item.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
$rules=@($check.Access)
if(-not $check.AreAccessRulesProtected -or $rules.Count -ne 3){throw 'acl-count'}
$actual=@($rules|ForEach-Object{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}|Sort-Object)
$expected=@($sid,'S-1-5-18','S-1-5-32-544')|Sort-Object
if((Compare-Object $actual $expected).Count -ne 0){throw 'acl-identity'}
foreach($rule in $rules){if($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)){throw 'acl-rights'}}
`, path, 'PAIRING_REGISTRY_ACL_APPLY_FAILED'),
    verifyProtectedAcl: (path) => runPowerShell(`
$ErrorActionPreference='Stop'
$p=$env:PAIOS_PAIRING_REGISTRY_TARGET
$item=Get-Item -LiteralPath $p -Force
if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'reparse'}
if(-not $item.PSIsContainer){$streams=@(Get-Item -LiteralPath $p -Stream *);if($streams.Count -ne 1 -or $streams[0].Stream -ne ':$DATA'){throw 'ads'}}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$check=$item.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
$rules=@($check.Access)
if(-not $check.AreAccessRulesProtected -or $rules.Count -ne 3){throw 'acl-count'}
$actual=@($rules|ForEach-Object{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}|Sort-Object)
$expected=@($sid,'S-1-5-18','S-1-5-32-544')|Sort-Object
if((Compare-Object $actual $expected).Count -ne 0){throw 'acl-identity'}
foreach($rule in $rules){if($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)){throw 'acl-rights'}}
`, path, 'PAIRING_REGISTRY_ACL_VERIFY_FAILED'),
    replaceWriteThrough: (source, destination) => {
      const script = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PaiosMoveFile {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool MoveFileEx(string source, string destination, int flags);
}
'@
if(-not [PaiosMoveFile]::MoveFileEx($env:PAIOS_PAIRING_REGISTRY_SOURCE,$env:PAIOS_PAIRING_REGISTRY_TARGET,9)){throw ([ComponentModel.Win32Exception][Runtime.InteropServices.Marshal]::GetLastWin32Error())}
`;
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        encoding: 'utf8', windowsHide: true, timeout: 15_000,
        env: { ...process.env, PAIOS_PAIRING_REGISTRY_SOURCE: source, PAIOS_PAIRING_REGISTRY_TARGET: destination },
      });
      if (result.status !== 0) throw new Error('PAIRING_REGISTRY_REPLACE_FAILED');
    },
    remove: (path) => unlinkSync(path),
  };
  if (pairingPathApi(path) === posix) {
    io.ensureDirectory = (directory) => mkdirSync(directory, { recursive: true, mode: 0o700 });
    io.applyAndVerifyProtectedAcl = io.verifyProtectedAcl = (target) =>
      assertAppleEnrollmentOwnerProtectedPath(target, lstatSync(target).isDirectory() ? 'directory' : 'file');
    io.replaceWriteThrough = (source, destination) => {
      renameSync(source, destination);
      const directory = openSync(posix.dirname(destination), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    };
  }
  return io;
}

function assertSafeNode(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error('PAIRING_REGISTRY_NODE_INVALID');
  }
  if (!directory && stat.nlink !== 1) throw new Error('PAIRING_REGISTRY_LINK_INVALID');
  const paths = pairingPathApi(path);
  const expected = paths.resolve(path);
  const actual = realpathSync.native(path);
  if (paths === posix ? expected !== actual : expected.toLowerCase() !== actual.toLowerCase()) {
    throw new Error('PAIRING_REGISTRY_PATH_INVALID');
  }
}
