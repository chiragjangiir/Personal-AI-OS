import { check, digest } from '../contracts.ts';
import type { ArchivedEvent, TimeRange } from '../contracts.ts';
import type { StoredChunk } from '../stream-archive.ts';
export interface TrackSet {
    event_id: string;
    device_id: string;
    stream_epoch: string;
    chunks: StoredChunk[];
}
export interface DerivedTrack extends Omit<StoredChunk, 'representation'> {
    representation: 'derived';
    derived_from: string;
    original_archive_revision: string;
    original_payload_sha256: string;
    pts: DecodedChunk['pts'];
}
export interface DemuxTrackSet extends Omit<TrackSet, 'chunks'> {
    chunks: DerivedTrack[];
}
export interface DecodedChunk {
    track_id: string;
    stream_epoch: string;
    seq: number;
    modality: 'audio' | 'visual';
    source_range: TimeRange;
    format: string;
    mime: string;
    data: Uint8Array;
    pts: {
        source_time_base: string;
        decoder_time_base?: string;
        decoder_pts?: string;
        pts_time: number;
    };
}
export interface DecodedTrackSet extends Omit<TrackSet, 'chunks'> {
    decoder_id: string;
    chunks: DecodedChunk[];
}
export interface DemuxAdmission {
    assertReady(): void;
    execute(original: ArchivedEvent, bytes: Uint8Array): Promise<DecodedTrackSet>;
    release(): Promise<void>;
}
export interface DemuxPort {
    readonly decoder_id: string;
    prepare(signal: AbortSignal): Promise<DemuxAdmission>;
    // A service-specific implementation must preserve PTS and link every derived track
    // to the exact original. No implementation is inferred from a model/service name.
    demux(original: ArchivedEvent, bytes: Uint8Array, signal: AbortSignal): Promise<DecodedTrackSet>;
}
export function pairIndependentTracks(archive: ArchivedEvent, tracks: TrackSet[]): StoredChunk[] {
    check(archive.media_type === 'livekit_tracks' && tracks.length > 0, 'PAIR_REQUIRES_INDEPENDENT_TRACKS');
    check(tracks.every(t => t.event_id === archive.event_id && t.device_id === archive.device_id &&
        t.stream_epoch === tracks[0]!.stream_epoch && t.chunks.every(c => c.stream_epoch === t.stream_epoch)), 'PAIR_SOURCE_MISMATCH');
    const chunks = tracks.flatMap(t => t.chunks);
    check(new Set(chunks.map(c => digest([c.track_id, c.stream_epoch, c.seq]))).size === chunks.length, 'PAIR_DUPLICATE_CHUNK');
    return chunks; // Original separate tracks remain separate, no temporary AV container.
}
export async function demuxContainer(archive: ArchivedEvent, port: DemuxPort | null, signal: AbortSignal, bytes: Uint8Array = new Uint8Array()): Promise<DecodedTrackSet> {
    check(archive.media_type === 'muxed_av' || archive.media_type === 'audio' && archive.mime === 'audio/mp4', 'DEMUX_REQUIRES_CONTAINER');
    check(port, 'DEMUX_SERVICE_UNAVAILABLE', 503);
    const result = await port.demux(archive, bytes, signal);
    check(result.event_id === archive.event_id && result.device_id === archive.device_id && result.chunks.length > 0 &&
        result.chunks.every(c => c.source_range.stream_epoch === result.stream_epoch && result.decoder_id === port.decoder_id), 'DEMUX_DERIVATION_CONTRACT_INVALID', 502);
    return result;
}
