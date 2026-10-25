import {releaseCoreProfile, coreProfileReleaseFailure} from '../src/core-profile-release.ts';

const [operation, config] = process.argv.slice(2);
if (operation !== 'rollback' || !config || process.argv.length !== 4) throw new Error('CORE_PROFILE_RELEASE_ARGUMENTS_INVALID');
try {process.stdout.write(JSON.stringify(await releaseCoreProfile(config, operation)) + '\n');}
catch (error) {
  process.stdout.write(JSON.stringify(coreProfileReleaseFailure(error)) + '\n');
  process.exitCode = 1;
}
