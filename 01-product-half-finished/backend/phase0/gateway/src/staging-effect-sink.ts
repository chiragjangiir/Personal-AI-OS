import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Notify } from './bark-notifier.ts';

/** Staging has one outbound authority: persist attempted effects without contacting owner devices. */
export function createStagingEffectSink(file: string) {
  const record = async (kind: string, payload: object): Promise<void> => {
    await mkdir(dirname(file), {recursive: true, mode: 0o700});
    await appendFile(file, JSON.stringify({at: new Date().toISOString(), kind, ...payload}) + '\n', {mode: 0o600});
  };
  const notify: Notify = notice => record('notification', notice);
  return Object.freeze({notify,
    sms: (message: {id: string; to: string; text: string}) => record('sms', message),
    outreach: (message: {principal_id: string; device_id: string; id: string; text: string; suggestion: boolean; reminder_id?: string}) =>
      record('outreach', message)});
}
