import {readFileSync} from 'node:fs';
import {desktopPackageResult} from '../server/receipt.ts';

const {name, args, raw} = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(desktopPackageResult(name, args, raw)));
