import {isAbsolute} from 'node:path';
import {check} from '../contracts.ts';
import type {StreamBudget} from '../stream-archive.ts';
import type {AlignConfig} from './align.ts';
import type {ProcessingConfig} from './processing.ts';
import {parseLocalSpeechConfig, type LocalSpeechConfig} from '../voiceprint/engine.ts';
import {WindowsVisionWorker, type WindowsVisionConfig} from './windows-vision-worker.ts';

export interface EvidenceFile {path: string; sha256: string}
export interface MediaReplayConfiguration {
    fixture_only: boolean;
    stream_budget: StreamBudget;
    alignment: AlignConfig;
    processing: ProcessingConfig;
    max_segments: number;
    max_window_ms: number;
    /** The one local audio authority: the in-process sherpa-onnx speech engine (VAD, ASR, speaker embeddings, KWS). */
    audio?: {provider: 'local_sherpa'; config: LocalSpeechConfig};
    windows_vision?: {config: WindowsVisionConfig; verified_record?: EvidenceFile};
}
type ObjectRecord = Record<string, unknown>;
function object(value: unknown, allowed: string[], required = allowed): ObjectRecord {
    check(value !== null && typeof value === 'object' && !Array.isArray(value), 'MEDIA_CONFIG_OBJECT_REQUIRED');
    const record = value as ObjectRecord;
    check(Object.keys(record).every(key => allowed.includes(key)) &&
        required.every(key => Object.hasOwn(record, key)), 'MEDIA_CONFIG_FIELDS');
    return record;
}
function positive(value: unknown): asserts value is number {
    check(Number.isSafeInteger(value) && Number(value) > 0, 'MEDIA_CONFIG_BUDGET');
}
function path(value: unknown): asserts value is string {
    check(typeof value === 'string' && isAbsolute(value) && value.length <= 4096, 'MEDIA_CONFIG_PATH');
}
function hash(value: unknown): asserts value is string {
    check(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value), 'MEDIA_CONFIG_HASH');
}
function evidenceFile(value: unknown): EvidenceFile {
    const file = object(value, ['path', 'sha256']);
    path(file.path); hash(file.sha256);
    return {path: file.path, sha256: file.sha256};
}

// Configuration is a source-owned topology and budget declaration, never a healthy boolean.
// Parse before keys/locks/resources; rejecting legacy prevents downstream recropping.
export function parseMediaReplayConfiguration(value: unknown, sourceOwned = false): MediaReplayConfiguration {
    check(value !== null && typeof value === 'object' && !Array.isArray(value), 'MEDIA_CONFIG_OBJECT_REQUIRED');
    const incoming = value as ObjectRecord;
    check(!['local_audio', 'verified_audio_record', 'verified_vision_record'].some(key => Object.hasOwn(incoming, key)),
        'LEGACY_MEDIA_REPLAY_CONFIG_UNSUPPORTED', 422);
    const config = object(value, ['fixture_only', 'stream_budget', 'alignment', 'processing',
        'max_segments', 'max_window_ms', 'audio', 'windows_vision'],
        ['fixture_only', 'stream_budget', 'alignment', 'processing', 'max_segments', 'max_window_ms']);
    check(typeof config.fixture_only === 'boolean' && (config.fixture_only || sourceOwned),
        'PRODUCTION_MEDIA_AUTHORITY_NOT_CONFIGURED', 503);
    const budget = object(config.stream_budget, ['max_chunk_bytes', 'max_total_bytes', 'max_chunks', 'max_revisions', 'max_seq']);
    Object.values(budget).forEach(positive);
    const alignment = object(config.alignment, ['max_chunks', 'max_visual_refs', 'max_frame_gap_ms', 'max_uncertainty_ms']);
    positive(alignment.max_chunks); positive(alignment.max_visual_refs);
    check([alignment.max_frame_gap_ms, alignment.max_uncertainty_ms].every(n => typeof n === 'number' &&
        Number.isFinite(n) && n > 0), 'MEDIA_CONFIG_BUDGET');
    const processing = object(config.processing, ['policy_version', 'max_inflight', 'max_input_bytes', 'timeout_ms',
        'allow_external', 'allow_replay', 'allow_partial']);
    check(typeof processing.policy_version === 'string' && processing.policy_version.length > 0,
        'MEDIA_CONFIG_POLICY');
    [processing.max_inflight, processing.max_input_bytes, processing.timeout_ms].forEach(positive);
    check([processing.allow_external, processing.allow_replay, processing.allow_partial].every(v => typeof v === 'boolean'),
        'MEDIA_CONFIG_POLICY');
    positive(config.max_segments); positive(config.max_window_ms);
    const parsed = structuredClone(config) as unknown as MediaReplayConfiguration;
    if (config.audio !== undefined) {
        const audio = object(config.audio, ['provider', 'config']);
        check(audio.provider === 'local_sherpa', 'MEDIA_AUDIO_PROVIDER_UNSUPPORTED');
        parsed.audio = {provider: 'local_sherpa', config: parseLocalSpeechConfig(audio.config)};
    }
    if (config.windows_vision !== undefined) {
        const vision = object(config.windows_vision, ['config', 'verified_record'], ['config']);
        const remote = object(vision.config, ['base_url', 'model', 'timeout_ms', 'max_frames', 'max_input_bytes', 'max_tokens']);
        // The existing external converter validates its HTTPS endpoint and budgets without IO.
        const worker = new WindowsVisionWorker(remote as unknown as WindowsVisionConfig);
        parsed.windows_vision = {config: {...worker.config},
            ...(vision.verified_record === undefined ? {} : {verified_record: evidenceFile(vision.verified_record)})};
    }
    check(parsed.audio !== undefined || parsed.windows_vision !== undefined, 'MEDIA_CONFIG_NO_PROVIDERS');
    return parsed;
}
