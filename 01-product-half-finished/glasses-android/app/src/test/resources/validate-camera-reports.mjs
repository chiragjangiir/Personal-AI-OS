import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';

// Compile the same camera_status definition and options as formal-text ingress.
const [contractPath, payloadPath, servicePath, dependencyPath] = process.argv.slice(2);
const Ajv = createRequire(dependencyPath ?? import.meta.url)('ajv');
const wire = JSON.parse(readFileSync(contractPath, 'utf8'));
const validate = new Ajv({strict:true, coerceTypes:false, useDefaults:false, removeAdditional:false})
  .compile({$defs:wire.$defs, ...wire.inputs.camera_status.definition});
const reports = JSON.parse(readFileSync(payloadPath === '-' ? 0 : payloadPath, 'utf8'));
assert.equal(reports.length, 104);
assert.deepEqual([...new Set(reports.map(row => row.entry))].sort(), ['connection_ready', 'state_change']);
for (const row of reports) assert.ok(validate(row.payload), `${row.entry}/${row.phase}: ${JSON.stringify(validate.errors)}`);
for (const entry of ['connection_ready', 'state_change']) for (const phase of ['opening', 'live']) {
  const transition = reports.filter(row => row.entry === entry && row.call_phase === phase);
  assert.deepEqual(transition.map(row => row.phase), ['call', 'closing', 'closing', 'ready', 'capturing']);
  assert.deepEqual(transition.map(row => row.step), [0, 1, 2, 3, 4]);
  for (const row of transition) {
    assert.equal(row.payload.status, 'available');
    assert.equal(row.payload.error, null);
  }
}
const service = readFileSync(servicePath, 'utf8');
assert.match(service, /capture\.state\.map \{ cameraReport\(it\)\.toString\(\) \}/);
assert.match(service, /queue\(JSONObject\(it\)\.put\("control_id", UUID\.randomUUID\(\)\.toString\(\)\)\)/);
assert.match(service, /queue\(cameraReport\(capture\.state\.value\)\.put\("control_id", UUID\.randomUUID\(\)\.toString\(\)\)\)/);
assert.equal(validate({operation:'camera_status',control_id:'original-bug',status:'error',error:null}), false);
console.log(`Validated ${reports.length} actual Kotlin camera reports through the formal camera_status schema; both send sites verified.`);
