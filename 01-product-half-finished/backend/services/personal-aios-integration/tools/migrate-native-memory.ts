import {releaseCoreProfile, coreProfileReleaseFailure} from '../../../phase0/gateway/src/core-profile-release.ts';

const [configPath] = process.argv.slice(2);
if (!configPath || process.argv.length !== 3) throw new Error('Usage: migrate-native-memory.ts <rendered-gateway.json>');
try {process.stdout.write(JSON.stringify(await releaseCoreProfile(configPath, 'migrate')) + '\n');}
catch (error) {
  process.stdout.write(JSON.stringify(coreProfileReleaseFailure(error)) + '\n');
  process.exitCode = 1;
}
