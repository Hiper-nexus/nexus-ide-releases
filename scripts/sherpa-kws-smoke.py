#!/usr/bin/env python3
"""Local microphone smoke test for the optional sherpa-onnx Jarvis wake path."""

from __future__ import annotations

import argparse
import queue
import time
from pathlib import Path

import numpy as np
import sherpa_onnx
import sounddevice as sd


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--keywords", type=Path, required=True)
    parser.add_argument("--seconds", type=float, default=20)
    args = parser.parse_args()

    model = args.model_dir
    spotter = sherpa_onnx.KeywordSpotter(
        tokens=str(model / "tokens.txt"),
        encoder=str(model / "encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx"),
        decoder=str(model / "decoder-epoch-13-avg-2-chunk-8-left-64.onnx"),
        joiner=str(model / "joiner-epoch-13-avg-2-chunk-8-left-64.int8.onnx"),
        keywords_file=str(args.keywords),
        num_threads=2,
    )
    stream = spotter.create_stream()
    frames: queue.Queue[np.ndarray] = queue.Queue()

    def callback(indata: np.ndarray, _frames: int, _time: object, status: object) -> None:
        if status:
            print(f"audio-status: {status}", flush=True)
        frames.put(indata[:, 0].copy())

    deadline = time.monotonic() + args.seconds
    detections = 0
    max_rms = 0.0
    print(f"LISTENING seconds={args.seconds:g} sample_rate=16000", flush=True)
    with sd.InputStream(samplerate=16000, channels=1, dtype="float32", callback=callback):
        while time.monotonic() < deadline:
            try:
                samples = frames.get(timeout=0.25)
            except queue.Empty:
                continue
            max_rms = max(max_rms, float(np.sqrt(np.mean(np.square(samples)))))
            stream.accept_waveform(16000, samples)
            while spotter.is_ready(stream):
                spotter.decode_stream(stream)
            result = spotter.get_result(stream)
            if result:
                detections += 1
                print(f"DETECTED keyword={result} at={time.time():.3f}", flush=True)
                spotter.reset_stream(stream)

    print(f"DONE detections={detections} max_rms={max_rms:.5f}", flush=True)
    return 0 if detections else 2


if __name__ == "__main__":
    raise SystemExit(main())
