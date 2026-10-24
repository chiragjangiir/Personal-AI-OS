import { randomUUID } from 'node:crypto';
import { canonical, check, digest, id, sha256, utc, validateRange, type ArchivedEvent } from './contracts.ts';
import type { StoragePort } from './storage.ts';
import type { DemuxPort, DerivedTrack, DecodedTrackSet } from './media/tracks.ts';
import {withRawPublication} from './stream-archive.ts';
export interface DerivedBudget {
    max_chunks: number;
    max_chunk_bytes: number;
    max_total_bytes: number;
}
export interface DerivedManifest {
    schema: 'paios.derived.v1';
    raw_ref: string;
    archive_revision: string;
    payload_sha256: string;
    event: ArchivedEvent;
    decoder_id: string;
    attempt_id: string;
    chunks: DerivedTrack[];
}
export interface VerifiedDerivedRecord {
    manifest: DerivedManifest;
    ref: string;
    settlement_coverage: 'complete' | 'missing';
}
interface Attempt {
    attempt_id: string;
    raw_ref: string;
    archive_revision: string;
    payload_sha256: string;
    decoder_id: string;
    started_at: string;
}
interface Settlement {
    attempt_id: string;
    outcome: 'completed' | 'failed';
    manifest_ref?: string;
    error_code?: string;
}
const parse = <T>(b: Uint8Array): T => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)) as T;
const encode = (v: unknown) => Buffer.from(canonical(v));
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
// L5 derivation authority. Finite original identity is never rewritten into a stream or another A.
export class DerivedArchive {
    private readonly storage: StoragePort;
    private readonly budget: DerivedBudget;
    private readonly active = new Map<string, Promise<VerifiedDerivedRecord>>();
    constructor(storage: StoragePort, budget: DerivedBudget) {
        this.storage = storage;
        this.budget = budget;
        check(Object.values(budget).every(n => Number.isSafeInteger(n) && n > 0), 'INVALID_DERIVATION_BUDGET');
    }
    private key(original: ArchivedEvent, decoderId: string): string {
        return digest({ raw_ref: original.raw_ref, archive_revision: original.archive_revision,
            payload_sha256: original.payload_sha256, decoder_id: decoderId });
    }
    private async optional<T>(namespace: string, key: string): Promise<T | undefined> {
        try {
            return parse<T>(await this.storage.read(namespace, key));
        }
        catch (error) {
            if (absent(error))
                return;
            throw error;
        }
    }
    private async exact<T>(namespace: string, key: string, value: T): Promise<T> {
        const saved = parse<T>(await this.storage.publish(namespace, key, encode(value)));
        check(canonical(saved) === canonical(value), 'DERIVATION_IMMUTABLE_CONFLICT', 409);
        return saved;
    }
    derive(original: ArchivedEvent, bytes: Uint8Array, port: DemuxPort, signal: AbortSignal): Promise<VerifiedDerivedRecord> {
        const key = this.key(original, port.decoder_id), previous = this.active.get(key);
        if (previous)
            return previous;
        const work = this.execute(original, bytes, port, signal, key);
        this.active.set(key, work);
        void work.then(() => this.active.delete(key), () => this.active.delete(key));
        return work;
    }
    private async execute(original: ArchivedEvent, bytes: Uint8Array, port: DemuxPort, signal: AbortSignal, key: string): Promise<VerifiedDerivedRecord> {
        check(!signal.aborted, 'DEMUX_CANCELLED', 409);
        check((original.media_type === 'muxed_av' || original.media_type === 'audio' && original.mime === 'audio/mp4') && original.representation === 'uploaded_original' &&
            original.origin === 'device_observation' && original.user_identity === 'unknown' &&
            bytes.length === original.bytes && sha256(bytes) === original.payload_sha256, 'DERIVATION_SOURCE_INVALID', 422);
        const completed = await this.optional<DerivedManifest>('derived-manifests', key);
        if (completed)
            return this.read(original, `l5-derived:${key}:${digest(completed)}`);
        const old = await this.optional<Attempt>('derivation-attempts', key);
        if (old) {
            this.checkAttempt(original, port.decoder_id, old);
            const ended = await this.optional<Settlement>('derivation-settlements', key);
            check(!ended || ended.attempt_id === old.attempt_id && ended.outcome === 'failed' &&
                typeof ended.error_code === 'string' && ended.error_code.length > 0, 'DERIVATION_SETTLEMENT_CONFLICT', 503);
            check(false, ended?.outcome === 'failed' ? 'DEMUX_PREVIOUS_FAILED' : 'DEMUX_ATTEMPT_UNKNOWN', 503);
        }
        const admission = await port.prepare(signal);
        try {
            admission.assertReady();
            const attempt: Attempt = { attempt_id: randomUUID(), raw_ref: original.raw_ref, archive_revision: original.archive_revision,
                payload_sha256: original.payload_sha256, decoder_id: port.decoder_id, started_at: new Date().toISOString() };
            const owner = await withRawPublication(this.storage,original.raw_ref,async()=>parse<Attempt>(await this.storage.publish('derivation-attempts', key, encode(attempt))));
            this.checkAttempt(original, port.decoder_id, owner);
            check(owner.attempt_id === attempt.attempt_id, 'DEMUX_ATTEMPT_UNKNOWN', 503);
            let decoded: DecodedTrackSet;
            try {
                check(!signal.aborted, 'DEMUX_CANCELLED', 409);
                decoded = await admission.execute(original, bytes);
            }
            catch (error) {
                // This owner observed an actual failed decoder exit. A crash with no settlement stays unknown.
                await withRawPublication(this.storage,original.raw_ref,()=>this.exact('derivation-settlements', key, { attempt_id: attempt.attempt_id, outcome: 'failed',
                    error_code: error instanceof Error ? error.message : 'DEMUX_DECODER_FAILED' } satisfies Settlement));
                throw error;
            }
            check(decoded.event_id === original.event_id && decoded.device_id === original.device_id &&
                decoded.decoder_id === port.decoder_id && decoded.chunks.length > 0 && decoded.chunks.length <= this.budget.max_chunks &&
                decoded.chunks.every(c => c.stream_epoch === decoded.stream_epoch), 'DEMUX_DERIVATION_CONTRACT_INVALID', 502);
            const chunks: DerivedTrack[] = [];
            let total = 0;
            for (const decodedChunk of decoded.chunks) {
                const { data, pts, ...descriptor } = decodedChunk;
                const detail = { ...descriptor, bytes: data.length, object_hash: sha256(data), representation: 'derived' as const,
                    derived_from: original.raw_ref, original_archive_revision: original.archive_revision,
                    original_payload_sha256: original.payload_sha256, pts };
                const chunk: DerivedTrack = { ...detail, received_at: attempt.started_at, fingerprint: digest(detail) };
                this.checkChunk(original, chunk);
                total += chunk.bytes;
                check(total <= this.budget.max_total_bytes, 'DERIVATION_BYTE_BUDGET', 413);
                chunks.push(chunk);
            }
            this.checkSlots(chunks);
            const manifest: DerivedManifest = { schema: 'paios.derived.v1', raw_ref: original.raw_ref,
                archive_revision: original.archive_revision, payload_sha256: original.payload_sha256, event: original,
                decoder_id: port.decoder_id, attempt_id: attempt.attempt_id, chunks };
            const ref = `l5-derived:${key}:${digest(manifest)}`;
            return withRawPublication(this.storage,original.raw_ref,async()=>{
                // Persist ownership before any chunk, so an interrupted write remains in the deletion graph.
                await this.exact('derived-manifests', key, manifest);
                for (let n = 0; n < chunks.length; n++) {
                    const stored = await this.storage.publish('objects', chunks[n]!.object_hash, decoded.chunks[n]!.data);
                    check(sha256(stored) === chunks[n]!.object_hash, 'DERIVATION_OBJECT_INTEGRITY', 500);
                }
                await this.exact('derivation-settlements', key, { attempt_id: attempt.attempt_id, outcome: 'completed', manifest_ref: ref } satisfies Settlement);
                return this.read(original, ref);
            });
        }
        finally {
            await admission.release();
        }
    }
    private checkAttempt(original: ArchivedEvent, decoderId: string, attempt: Attempt): void {
        check(attempt.raw_ref === original.raw_ref && attempt.archive_revision === original.archive_revision &&
            attempt.payload_sha256 === original.payload_sha256 && attempt.decoder_id === decoderId && typeof attempt.attempt_id === 'string', 'DERIVATION_ATTEMPT_CONFLICT', 503);
        utc(attempt.started_at);
    }
    private checkChunk(original: ArchivedEvent, chunk: DerivedTrack): void {
        id(chunk.track_id);
        id(chunk.stream_epoch);
        validateRange(chunk.source_range);
        utc(chunk.received_at);
        const { received_at: _received, fingerprint, ...detail } = chunk;
        check(digest(detail) === fingerprint && chunk.representation === 'derived' && chunk.derived_from === original.raw_ref &&
            chunk.original_archive_revision === original.archive_revision && chunk.original_payload_sha256 === original.payload_sha256 &&
            chunk.source_range.stream_epoch === chunk.stream_epoch && Number.isSafeInteger(chunk.seq) && chunk.seq >= 0 &&
            /^[a-f0-9]{64}$/.test(chunk.object_hash) && Number.isSafeInteger(chunk.bytes) && chunk.bytes > 0 &&
            chunk.bytes <= this.budget.max_chunk_bytes && Number.isFinite(chunk.pts.pts_time) && /^\d+\/\d+$/.test(chunk.pts.source_time_base), 'DERIVATION_CHUNK_INTEGRITY', 500);
        const sourceBase = /^(\d+)\/(\d+)$/.exec(chunk.pts.source_time_base);
        check(sourceBase && Number(sourceBase[2]) > 0, 'DERIVATION_PTS_MISMATCH', 500);
        const start = chunk.source_range.kind === 'instant' ? chunk.source_range.at_ms : chunk.source_range.start_ms;
        check(Math.abs(start - chunk.pts.pts_time * 1000) < 0.001, 'DERIVATION_PTS_MISMATCH', 500);
        const base = /^(\d+)\/(\d+)$/.exec(chunk.pts.decoder_time_base ?? '');
        check(base && Number(base[2]) > 0 && /^-?\d+$/.test(chunk.pts.decoder_pts ?? '') &&
            Math.abs(Number(chunk.pts.decoder_pts) * Number(base[1]) / Number(base[2]) - chunk.pts.pts_time) < 0.000001, 'DERIVATION_PTS_MISMATCH', 500);
        check(chunk.modality === 'audio' ? chunk.format === 'pcm_s16le:16000:1' && chunk.mime === 'audio/pcm' &&
            chunk.source_range.kind === 'interval' && Math.abs(chunk.source_range.end_ms - start - chunk.bytes / 32) < 0.001 :
            chunk.modality === 'visual' && chunk.format === 'png' && chunk.mime === 'image/png' && chunk.source_range.kind === 'instant', 'DERIVATION_FORMAT_TIME_MISMATCH', 500);
    }
    private checkSlots(chunks: DerivedTrack[]): void {
        const slots = new Set<string>(), prior = new Map<string, DerivedTrack>();
        for (const chunk of chunks) {
            const track = digest([chunk.track_id, chunk.stream_epoch]), slot = digest([track, chunk.seq]);
            check(!slots.has(slot), 'DERIVATION_SLOT_CONFLICT', 500);
            slots.add(slot);
            const previous = prior.get(track);
            check(!previous || chunk.seq === previous.seq + 1 && previous.modality === chunk.modality && previous.format === chunk.format &&
                previous.source_range.timebase_id === chunk.source_range.timebase_id && previous.pts.source_time_base === chunk.pts.source_time_base &&
                previous.pts.decoder_time_base === chunk.pts.decoder_time_base && chunk.pts.pts_time >= previous.pts.pts_time, 'DERIVATION_TRACK_CONFLICT', 500);
            check(previous || chunk.seq === 0, 'DERIVATION_TRACK_CONFLICT', 500);
            prior.set(track, chunk);
        }
    }
    async read(original: ArchivedEvent, ref: string): Promise<VerifiedDerivedRecord> {
        const match = /^l5-derived:([a-f0-9]{64}):([a-f0-9]{64})$/.exec(ref);
        check(match, 'INVALID_DERIVATION_REF');
        const manifest = parse<DerivedManifest>(await this.storage.read('derived-manifests', match[1]!));
        check(manifest.schema === 'paios.derived.v1' && digest(manifest) === match[2] &&
            match[1] === this.key(original, manifest.decoder_id) && canonical(manifest.event) === canonical(original) &&
            manifest.raw_ref === original.raw_ref && manifest.archive_revision === original.archive_revision &&
            manifest.payload_sha256 === original.payload_sha256, 'DERIVATION_SOURCE_MISMATCH', 500);
        const attempt = await this.optional<Attempt>('derivation-attempts', match[1]!);
        check(attempt && attempt.attempt_id === manifest.attempt_id, 'DERIVATION_ATTEMPT_CONFLICT', 500);
        this.checkAttempt(original, manifest.decoder_id, attempt);
        check(manifest.chunks.length > 0 && manifest.chunks.length <= this.budget.max_chunks, 'DERIVATION_CHUNK_BUDGET', 413);
        let total = 0;
        for (const chunk of manifest.chunks) {
            this.checkChunk(original, chunk);
            total += chunk.bytes;
            check(total <= this.budget.max_total_bytes, 'DERIVATION_BYTE_BUDGET', 413);
            const bytes = await this.storage.read('objects', chunk.object_hash);
            check(bytes.length === chunk.bytes && sha256(bytes) === chunk.object_hash, 'DERIVATION_OBJECT_INTEGRITY', 500);
        }
        this.checkSlots(manifest.chunks);
        const ended = await this.optional<Settlement>('derivation-settlements', match[1]!);
        check(!ended || ended.attempt_id === manifest.attempt_id && ended.outcome === 'completed' &&
            ended.manifest_ref === ref && ended.error_code === undefined, 'DERIVATION_SETTLEMENT_CONFLICT', 503);
        return { manifest, ref, settlement_coverage: ended ? 'complete' : 'missing' };
    }
}
