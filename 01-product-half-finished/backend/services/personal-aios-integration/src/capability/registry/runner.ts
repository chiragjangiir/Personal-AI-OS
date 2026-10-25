import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import type {ContractEvidence, PackageVersion, RegistrationRunner} from './interfaces.ts';
import {verifyEvidence} from './checks.ts';
const execute = promisify(execFile);

/** Runs in the data-free workshop image/namespace, never in a credentialed package process. */
export class OfflineRegistrationRunner implements RegistrationRunner {
  private python: string;
  private dependencies: string | undefined;
  constructor(python: string, dependencies?: string) {this.python = python; this.dependencies = dependencies;}
  async check(root: string): Promise<ContractEvidence> {
    try {
      const {stdout} = await execute(this.python, ['-B', fileURLToPath(new URL('./runner.py', import.meta.url)), root], {
        timeout: 300_000, maxBuffer: 4 << 20,
        env: {...process.env, ...(this.dependencies ? {PAIOS_CAPABILITY_TEST_DEPS: this.dependencies} : {})},
      });
      return JSON.parse(stdout);
    } catch (error: any) {
      if (error.stdout) return JSON.parse(error.stdout);
      return {success: false, cases: [], errors: ['registration_sandbox_unavailable']};
    }
  }
  async health(version: PackageVersion): Promise<boolean> {
    const evidence = await this.check(version.root);
    try {verifyEvidence(version.manifest.extensions['ai.yimi.capability'], evidence); return true;}
    catch {return false;}
  }
}
