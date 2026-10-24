import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { check, digest, sha256, type ArchivedEvent, type TimeRange } from '../contracts.ts';
import { LocalMediaExecution, type LocalMediaReservation } from './local-execution.ts';
import type { DecodedChunk, DecodedTrackSet, DemuxPort, DemuxAdmission } from './tracks.ts';
export interface DecoderBudget {
    timeout_ms: number;
    max_input_bytes: number;
    max_output_bytes: number;
    max_chunks: number;
    max_pixels: number;
    max_metadata_bytes: number;
    max_duration_ms: number;
}
// External CLI conversion only. RawArchive owns attempts, original identity and durable publication.
export class FfmpegDemux implements DemuxPort {
    readonly decoder_id: string;
    private readonly ffmpeg: string;
    private readonly ffprobe: string;
    private readonly workRoot: string;
    readonly budget: DecoderBudget;
    private readonly execution: LocalMediaExecution;
    private constructor(ffmpeg: string, ffprobe: string, workRoot: string, budget: DecoderBudget, identity: unknown, execution: LocalMediaExecution) {
        this.execution = execution;
        this.ffmpeg = ffmpeg;
        this.ffprobe = ffprobe;
        this.workRoot = workRoot;
        this.budget = budget;
        this.decoder_id = digest({ identity, budget, profile: 'aac-lc16000-mono-intrinsic/pcm16000-mono/png-native-packets-pipe.v4' });
    }
    static async create(ffmpeg: string, ffprobe: string, workRoot: string, budget: DecoderBudget, execution: LocalMediaExecution): Promise<FfmpegDemux> {
        check(Object.values(budget).every(v => Number.isSafeInteger(v) && v > 0), 'INVALID_DECODER_BUDGET');
        const binaries = await Promise.all([ffmpeg, ffprobe].map(async (path) => {
            const stat = await fs.lstat(path);
            check(stat.isFile() && !stat.isSymbolicLink(), 'DECODER_BINARY_REQUIRED');
            return { path, sha256: sha256(await fs.readFile(path)) };
        }));
        return new FfmpegDemux(ffmpeg, ffprobe, workRoot, budget, binaries, execution);
    }
    async prepare(signal: AbortSignal): Promise<DemuxAdmission> {
        const reservation = await this.execution.reserve('decode', signal, this.budget.timeout_ms);
        let used = false;
        return {
            assertReady: () => reservation.assertReady(),
            execute: (original, bytes) => {
                reservation.assertReady();
                check(!used, 'DEMUX_ADMISSION_USED', 409);
                used = true;
                return this.decode(original, bytes, signal, reservation);
            },
            release: () => reservation.release()
        };
    }
    private async run(binary: string, args: string[], cwd: string, reservation: LocalMediaReservation, outputLimit = this.budget.max_metadata_bytes): Promise<{
        stdout: Buffer;
        stderr: string;
    }> {
        const result = await reservation.run({ executable: binary, args, cwd, stdin_limit_bytes: 0,
            stdout_limit_bytes: outputLimit, stderr_limit_bytes: this.budget.max_metadata_bytes,
            stderr_mode: 'lossless' });
        return { stdout: result.stdout, stderr: result.stderr.toString() };
    }
    async demux(original: ArchivedEvent, bytes: Uint8Array, signal: AbortSignal): Promise<DecodedTrackSet> {
        const admission = await this.prepare(signal);
        try {
            return await admission.execute(original, bytes);
        }
        finally {
            await admission.release();
        }
    }
    private async decode(original: ArchivedEvent, bytes: Uint8Array, signal: AbortSignal, reservation: LocalMediaReservation): Promise<DecodedTrackSet> {
        check(bytes.length <= this.budget.max_input_bytes && bytes.length === original.bytes && sha256(bytes) === original.payload_sha256, 'DEMUX_INPUT_INTEGRITY', 413);
        const watchAudio = original.media_type === 'audio' && original.mime === 'audio/mp4';
        check((watchAudio || original.media_type === 'muxed_av' && original.mime === 'video/mp4') && original.representation === 'uploaded_original', 'DEMUX_FORMAT_UNSUPPORTED', 422);
        await fs.mkdir(this.workRoot, { recursive: true, mode: 0o700 });
        const directory = await fs.mkdtemp(join(this.workRoot, 'decode-'));
        try {
            const input = join(directory, 'original.mp4');
            await fs.writeFile(input, bytes, { mode: 0o600 });
            const probe = await this.run(this.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'stream=index,codec_type,codec_name,profile,sample_rate,channels,time_base,duration,start_time,width,height:format=duration,format_name', '-of', 'json', input], directory, reservation);
            const metadata = JSON.parse(probe.stdout.toString()) as {
                streams: Record<string, string | number>[];
                format: {
                    duration: string;
                    format_name: string;
                };
            };
            const duration = Number(metadata.format.duration);
            check(Number.isFinite(duration) && duration > 0, 'DEMUX_DURATION_INVALID', 422);
            check(duration * 1000 <= Math.min(this.budget.max_duration_ms, watchAudio ? 30000 : Infinity), 'DEMUX_DURATION_BUDGET', 413);
            if (watchAudio) {
                const stream = metadata.streams[0];
                check(metadata.format.format_name.split(',').includes('mp4') && metadata.streams.length === 1 && stream?.codec_type === 'audio' &&
                    stream.codec_name === 'aac' && stream.profile === 'LC' && Number(stream.sample_rate) === 16000 && Number(stream.channels) === 1, 'DEMUX_AUDIO_CODEC_UNSUPPORTED', 415);
                const streamDuration = Number(stream.duration);
                check(Number.isFinite(streamDuration) && streamDuration > 0, 'DEMUX_DURATION_INVALID', 422);
                check(streamDuration * 1000 <= Math.min(this.budget.max_duration_ms, 30000), 'DEMUX_DURATION_BUDGET', 413);
            }
            check(metadata.streams.length > 0 && metadata.streams.length <= 2 && metadata.streams.every(s => ['audio', 'video'].includes(String(s.codec_type)) && /^\d+\/\d+$/.test(String(s.time_base))), 'DEMUX_STREAM_UNSUPPORTED', 422);
            check(new Set(metadata.streams.map(s => s.codec_type)).size === metadata.streams.length, 'DEMUX_STREAM_UNSUPPORTED', 422);
            const epoch = `demux-${digest([original.raw_ref, original.archive_revision, this.decoder_id]).slice(0, 24)}`;
            const chunks: DecodedChunk[] = [];
            let total = 0;
            for (const stream of metadata.streams) {
                check(!signal.aborted, 'DEMUX_CANCELLED', 409);
                const track = `mp4-track-${stream.index}`, timebase = `mp4-pts-${stream.index}`;
                const common = ['-hide_banner', '-nostdin', '-y', '-copyts', '-protocol_whitelist', 'file,pipe', '-i', input, '-map', `0:${stream.index}`];
                const audio = stream.codec_type === 'audio';
                check(audio || Number(stream.width) * Number(stream.height) <= this.budget.max_pixels, 'DEMUX_PIXEL_BUDGET', 413);
                const codec = audio ? ['-af', 'aformat=channel_layouts=mono,aresample=16000', '-c:a', 'pcm_s16le', '-f', 's16le'] :
                    ['-fps_mode', 'passthrough', '-enc_time_base:v', 'demux', '-frames:v', String(this.budget.max_chunks + 1), '-c:v', 'png', '-f', 'image2', '-update', '1'];
                const trace = watchAudio ? [] : ['-stats_mux_pre', 'pipe:2', '-stats_mux_pre_fmt', 'DEMUX_PACKET:{n}:{pts}:{tb}:{size}'];
                const result = await this.run(this.ffmpeg, [...common, ...codec, ...trace, 'pipe:1'], directory, reservation, this.budget.max_output_bytes - total);
                // AAC-LC pads its last 1024-sample frame. Decode all samples before removing only that bounded tail.
                const sourceBytes = watchAudio ? Math.round(Number(stream.duration) * 16000) * 2 : result.stdout.length;
                if (watchAudio) {
                    check(result.stdout.length >= sourceBytes && result.stdout.length - sourceBytes < 2048, 'DEMUX_AUDIO_DURATION_MISMATCH', 422);
                    const data=result.stdout.subarray(0,sourceBytes);
                    chunks.push({track_id:track,stream_epoch:epoch,seq:0,modality:'audio',
                        source_range:{kind:'interval',timebase_id:timebase,stream_epoch:epoch,start_ms:0,end_ms:data.length/32},
                        format:'pcm_s16le:16000:1',mime:'audio/pcm',data,
                        pts:{source_time_base:String(stream.time_base),decoder_time_base:'1/16000',decoder_pts:'0',pts_time:0}});
                    total=data.length;continue;
                }
                const packets = [...result.stderr.matchAll(/DEMUX_PACKET:(\d+):(-?\d+):(\d+\/\d+):(\d+)/g)];
                let offset = 0;
                for (const packet of packets) {
                    const seq = Number(packet[1]), [num, den] = packet[3]!.split('/').map(Number), size = Number(packet[4]);
                    const pts = Number(packet[2]) * num! / den!, data = result.stdout.subarray(offset, offset + size);
                    check(seq === chunks.filter(c => c.track_id === track).length && Number.isFinite(pts) &&
                        Number.isSafeInteger(size) && size > 0 && data.length === size, 'DEMUX_PACKET_MISMATCH', 502);
                    check(audio ? size % 2 === 0 && packet[3] === '1/16000' :
                        data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'DEMUX_PACKET_FORMAT_MISMATCH', 502);
                    const range: TimeRange = audio ? { kind: 'interval', timebase_id: timebase, stream_epoch: epoch, start_ms: pts * 1000, end_ms: pts * 1000 + size / 32 } :
                        { kind: 'instant', timebase_id: timebase, stream_epoch: epoch, at_ms: pts * 1000 };
                    chunks.push({ track_id: track, stream_epoch: epoch, seq, modality: audio ? 'audio' : 'visual', source_range: range,
                        format: audio ? 'pcm_s16le:16000:1' : 'png', mime: audio ? 'audio/pcm' : 'image/png', data,
                        pts: { source_time_base: String(stream.time_base), decoder_time_base: packet[3]!, decoder_pts: packet[2]!, pts_time: pts } });
                    offset += size;
                    total += size;
                }
                check(offset === result.stdout.length && packets.length > 0, 'DEMUX_PACKET_MISMATCH', 502);
                check(chunks.length <= this.budget.max_chunks && total <= this.budget.max_output_bytes, 'DEMUX_OUTPUT_BUDGET', 413);
            }
            if (watchAudio) {
                const pcmDuration = total / 32, sourceDuration = Number(metadata.streams[0]!.duration) * 1000;
                check(pcmDuration > 0 && pcmDuration <= Math.min(this.budget.max_duration_ms, 30000), 'DEMUX_DURATION_BUDGET', 413);
                check(Math.abs(pcmDuration - sourceDuration) <= 1, 'DEMUX_AUDIO_DURATION_MISMATCH', 422);
            }
            check(!signal.aborted, 'DEMUX_CANCELLED', 409);
            return { event_id: original.event_id, device_id: original.device_id, stream_epoch: epoch, decoder_id: this.decoder_id, chunks };
        }
        finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    }
}
