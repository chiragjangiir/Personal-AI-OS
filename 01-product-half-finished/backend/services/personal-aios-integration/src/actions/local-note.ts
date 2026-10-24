import { PosixStorage } from '../storage.ts';
import { check, digest, sha256 } from '../contracts.ts';
import type { ActionCommand } from './contracts.ts';
export interface NoteArtifact {artifact_ref: string; artifact_sha256: string; bytes: number}
// Reuses the existing POSIX publication boundary, not a second filesystem transaction engine.
export class LocalNoteExecutor {
  private readonly storage: PosixStorage;
  constructor(root: string) {check(root.length > 0, 'ACTION_NOTE_ROOT_REQUIRED'); this.storage = new PosixStorage(root);}
  private key(principal: string, command: ActionCommand): string {return digest({principal_id: principal, action_id: command.action_id});}
  async execute(principal: string, command: ActionCommand): Promise<NoteArtifact> {
    const bytes = Buffer.from(command.parameters.text, 'utf8');
    const stored = await this.storage.publish('notes', this.key(principal, command), bytes);
    check(Buffer.from(stored).equals(bytes), 'ACTION_ARTIFACT_CONFLICT', 409);
    return {artifact_ref: `local-note:${this.key(principal, command)}`, artifact_sha256: sha256(stored), bytes: stored.length};
  }
  async inspect(principal: string, command: ActionCommand): Promise<NoteArtifact | undefined> {
    let stored: Uint8Array;
    try {stored = await this.storage.read('notes', this.key(principal, command));}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error;}
    check(Buffer.from(stored).equals(Buffer.from(command.parameters.text, 'utf8')), 'ACTION_ARTIFACT_CONFLICT', 409);
    return {artifact_ref: `local-note:${this.key(principal, command)}`, artifact_sha256: sha256(stored), bytes: stored.length};
  }
}
