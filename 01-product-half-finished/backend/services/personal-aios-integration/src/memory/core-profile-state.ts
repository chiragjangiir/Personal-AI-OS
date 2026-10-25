import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {sha256} from '../contracts.ts';

export const CORE_PROFILE_FILES = ['MEMORY.md', 'USER.md'] as const;
export const CORE_PROFILE_SEPARATOR = '\n§\n';
export type CoreProfileFile = typeof CORE_PROFILE_FILES[number];
export type EntryDigests = Record<CoreProfileFile, string[]>;
export interface CoreProfileBaseline {
  id: string; principal_id: string;
  files: {file: CoreProfileFile; sha256: string; entries: number}[];
  known_entry_sha256: EntryDigests;
}
export const nativeEntries = (bytes: Uint8Array | string): string[] =>
  (typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', {fatal: true}).decode(bytes))
    .split(CORE_PROFILE_SEPARATOR).map(entry => entry.trim()).filter(Boolean);
export const entryDigests = (bytes: Uint8Array | string) => nativeEntries(bytes).map(text => sha256(text));
export const baselinePath = (home: string) => join(home, 'rollback-baseline.json');

export async function readCoreProfileBaseline(home: string): Promise<CoreProfileBaseline | undefined> {
  try {return JSON.parse(await fs.readFile(baselinePath(home), 'utf8')) as CoreProfileBaseline;}
  catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined;}
}
