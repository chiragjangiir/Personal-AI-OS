#!/usr/bin/env python3
"""Synthetic H.264 receive benchmark. Requires PyAV and NumPy; never connects to Vidu.

Run: python avatar_decode_fixture.py OUTPUT_DIRECTORY
Measures host software decoding and CPU preview scaling, not Android power or GPU readback.
"""
import json
import platform
import resource
import statistics
import subprocess
import sys
import time
from pathlib import Path

import av


def generate(path, width, height, fps, seconds):
    import numpy as np

    yy, xx = np.indices((height, width))
    noise = np.random.default_rng(18).integers(0, 24, (height, width), dtype=np.uint8)
    with av.open(str(path), "w") as container:
        stream = container.add_stream("libx264", rate=fps)
        stream.width, stream.height, stream.pix_fmt = width, height, "yuv420p"
        stream.codec_context.thread_count = 1
        stream.options = {"preset": "veryfast", "tune": "zerolatency", "crf": "23",
                          "x264-params": f"keyint={fps}:bframes=0:threads=1"}
        for index in range(fps * seconds):
            image = np.empty((height, width, 3), dtype=np.uint8)
            image[:, :, 0] = ((xx + index * 3 + noise) % 256).astype(np.uint8)
            image[:, :, 1] = ((yy + noise) % 256).astype(np.uint8)
            image[:, :, 2] = ((xx // 4 + yy // 4 + noise) % 256).astype(np.uint8)
            x = index * 3 % (width - width // 4)
            image[height // 3:height * 2 // 3, x:x + width // 4] = (200, 130, 100)
            for packet in stream.encode(av.VideoFrame.from_ndarray(image, format="rgb24")):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


def decode(path):
    decode_ms, scale_ms, counts = [], [], []
    cpu_start = time.process_time()
    for _ in range(3):
        count = 0
        with av.open(str(path)) as container:
            stream = container.streams.video[0]
            stream.codec_context.thread_count = 1
            width, height = stream.width, stream.height
            fps = float(stream.average_rate)
            expected = stream.frames
            for packet in container.demux(stream):
                start = time.perf_counter_ns()
                frames = stream.codec_context.decode(packet)
                elapsed = (time.perf_counter_ns() - start) / 1e6
                for frame in frames:
                    assert (frame.width, frame.height) == (width, height)
                    decode_ms.append(elapsed / len(frames))
                    start = time.perf_counter_ns()
                    preview = frame.reformat(width=160, height=160, format="rgba")
                    assert preview.width == preview.height == 160
                    scale_ms.append((time.perf_counter_ns() - start) / 1e6)
                    count += 1
            assert count == expected, (count, expected)
            counts.append(count)
    cpu_ms = (time.process_time() - cpu_start) * 1000 / sum(counts)
    p95 = sorted(decode_ms)[int(len(decode_ms) * .95)]
    return dict(width=width, height=height, fps=fps, decoded_frames=counts,
                decode_mean_ms=statistics.mean(decode_ms), decode_p95_ms=p95,
                preview_scale_mean_ms=statistics.mean(scale_ms), cpu_ms_per_frame=cpu_ms,
                realtime_single_core_percent=cpu_ms * fps / 10,
                peak_process_rss_mib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024**2,
                encoded_kbps=path.stat().st_size * 8 / (counts[0] / fps) / 1000)


if __name__ == "__main__":
    if sys.argv[1] == "--decode":
        print(json.dumps(decode(Path(sys.argv[2]))))
    else:
        output = Path(sys.argv[1]); output.mkdir(parents=True, exist_ok=True)
        results = []
        for width, height, fps in [(320, 180, 15), (640, 360, 15), (1280, 720, 30)]:
            fixture = output / f"fixture-{width}x{height}-{fps}.mp4"
            generate(fixture, width, height, fps, 12)
            result = subprocess.check_output([sys.executable, __file__, "--decode", str(fixture)], text=True)
            results.append(json.loads(result))
        report = dict(platform=platform.platform(), machine=platform.machine(), pyav=av.__version__,
                      codec="H.264, CRF23, no B frames, one software decoder thread",
                      scope="Host fixture decode and CPU scaling only; no Android, ARTC, GPU, battery or heat measurement",
                      results=results)
        (output / "decode-results.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2))
