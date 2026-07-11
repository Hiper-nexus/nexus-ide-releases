#!/usr/bin/env python3
"""Validate a wake-word ONNX head before it can be promoted into Nexus."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort


def scores(session: ort.InferenceSession, windows: np.ndarray) -> np.ndarray:
    input_meta = session.get_inputs()[0]
    expected = tuple(dim for dim in input_meta.shape[-2:] if isinstance(dim, int))
    if windows.ndim != 3 or tuple(windows.shape[-2:]) != expected:
        raise ValueError(f"expected [N,{expected[0]},{expected[1]}], got {windows.shape}")
    name = input_meta.name
    values = []
    for window in windows.astype(np.float32, copy=False):
        output = session.run(None, {name: window[None, ...]})[0]
        values.append(float(np.asarray(output).reshape(-1)[0]))
    return np.asarray(values)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("model", type=Path)
    parser.add_argument("--positive", type=Path, required=True)
    parser.add_argument("--negative", type=Path, required=True)
    parser.add_argument("--threshold", type=float, default=0.65)
    parser.add_argument("--silence-limit", type=float, default=0.45)
    parser.add_argument("--max-frr", type=float, default=0.10)
    parser.add_argument("--max-negative-rate", type=float, default=0.001)
    args = parser.parse_args()

    session = ort.InferenceSession(str(args.model), providers=["CPUExecutionProvider"])
    positive = np.load(args.positive)
    negative = np.load(args.negative)
    pos_scores = scores(session, positive)
    neg_scores = scores(session, negative)
    input_shape = tuple(int(x) for x in positive.shape[-2:])
    silence = np.zeros((1, *input_shape), dtype=np.float32)
    silence_score = float(scores(session, silence)[0])
    rng = np.random.default_rng(20260711)
    probe_noise = rng.uniform(-0.05, 0.05, (1000, *input_shape)).astype(np.float32)
    noise_scores = scores(session, probe_noise)
    noise_max_score = float(np.max(noise_scores))
    frr = float(np.mean(pos_scores < args.threshold))
    negative_rate = float(np.mean(neg_scores >= args.threshold))
    passed = (
        silence_score < args.silence_limit
        and noise_max_score < args.silence_limit
        and frr <= args.max_frr
        and negative_rate <= args.max_negative_rate
    )
    report = {
        "passed": passed,
        "threshold": args.threshold,
        "silence_score": silence_score,
        "noise_probe_max_score": noise_max_score,
        "noise_probe_p99_score": float(np.quantile(noise_scores, 0.99)),
        "false_reject_rate": frr,
        "negative_window_trigger_rate": negative_rate,
        "positive_windows": int(len(pos_scores)),
        "negative_windows": int(len(neg_scores)),
        "positive_score_p05": float(np.quantile(pos_scores, 0.05)),
        "negative_score_p99": float(np.quantile(neg_scores, 0.99)),
        "note": "Window trigger rate is a preflight proxy; release FAR still requires hours of continuous audio.",
    }
    print(json.dumps(report, indent=2))
    return 0 if passed else 2


if __name__ == "__main__":
    raise SystemExit(main())
