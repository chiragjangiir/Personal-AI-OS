import {readFileSync} from 'node:fs';
import {validateModelSnapshot,type ModelSnapshot} from './model-settings-contract.ts';

/** An operator supplies a complete snapshot. Templates and environment never fill missing routes. */
export function loadModelSettingsImport(path:string|URL):ModelSnapshot {
  const snapshot=JSON.parse(readFileSync(path,'utf8')) as ModelSnapshot;
  validateModelSnapshot(snapshot);
  return snapshot;
}
