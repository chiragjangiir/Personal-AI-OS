import {promises as fs} from 'node:fs';
import {check, sha256} from '../contracts.ts';
import type {EvidenceFile} from './configuration.ts';

export async function readEvidenceFile(file: EvidenceFile): Promise<unknown> {
    const stat = await fs.stat(file.path);
    check(stat.isFile() && stat.size > 0 && stat.size <= 1048576, 'MEDIA_EVIDENCE_BUDGET');
    const bytes = await fs.readFile(file.path);
    check(sha256(bytes) === file.sha256, 'MEDIA_EVIDENCE_INTEGRITY');
    return JSON.parse(bytes.toString());
}
