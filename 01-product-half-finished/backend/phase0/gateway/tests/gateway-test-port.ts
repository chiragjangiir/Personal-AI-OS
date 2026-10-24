// Import FIRST in tests that bind the gateway: moves it off 8787 (live gateway) to a free port before src/ loads.
// Synchronous on purpose: top-level await would not order sibling imports.
import { execFileSync } from 'node:child_process';
process.env.PAIOS_GATEWAY_TEST_PORT = execFileSync(process.execPath, ['-e',
  "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});"], { encoding: 'utf8' });
