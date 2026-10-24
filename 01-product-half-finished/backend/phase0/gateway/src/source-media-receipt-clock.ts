import { check, digest } from '../../../services/personal-aios-integration/src/contracts.ts';
import type { ClockMap } from '../../../services/personal-aios-integration/src/media/align.ts';
import type { SourceClockProvider } from './source-media-clock.ts';

/** Server-receipt clock for decoded LiveKit PCM. The SDK exposes no capture timestamp, so each
 * (continuity, track, stream epoch) is anchored once at its first received chunk:
 * capture ≈ receipt − (chunk end on the source sample axis). The class is 'receipt_estimated' with an
 * explicit uncertainty bound; it is never presented as calibrated hardware time. The anchor stays fixed for
 * the epoch so every archived chunk of one capture span shares one sealed clock basis. */
export function createReceiptClockProvider(options: {uncertainty_ms: number; now?: () => number; max_anchors?: number}): SourceClockProvider {
  check(Number.isSafeInteger(options.uncertainty_ms) && options.uncertainty_ms > 0 && options.uncertainty_ms <= 10000,
    'RECEIPT_CLOCK_UNCERTAINTY_INVALID');
  const now = options.now ?? Date.now, max = options.max_anchors ?? 4096;
  const anchors = new Map<string, ClockMap>();
  const resolve: SourceClockProvider['resolve'] = async (binding, chunk) => {
    const range = chunk.source_range;
    if (!(range.kind==='interval'&&(chunk.modality==='audio'||chunk.modality==='visual')||range.kind==='instant'&&chunk.modality==='visual')) return undefined;
    const key = digest([binding.continuityId, chunk.track_id, chunk.stream_epoch, range.timebase_id]);
    let map = anchors.get(key);
    if (!map) {
      map = {modality: chunk.modality, track_id: chunk.track_id, stream_epoch: chunk.stream_epoch,
        source_timebase_id: range.timebase_id, target_timebase_id: 'utc_epoch_ms', offset_ms: Math.round(chunk.source_video&&range.kind==='interval'
          ?chunk.source_video.frames[0]!.received_at_ms-range.start_ms
          :now()-(range.kind==='instant'?range.at_ms:range.end_ms)),
        drift_ppm: 0, uncertainty_ms: options.uncertainty_ms, basis_ref: 'clock:server-receipt-v1'};
      if (anchors.size >= max) anchors.delete(anchors.keys().next().value!);
      anchors.set(key, map);
    }
    return structuredClone(map);
  };
  return Object.freeze({evidence: 'receipt_estimated' as const, resolve});
}
