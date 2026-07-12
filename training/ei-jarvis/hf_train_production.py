#!/usr/bin/env python3
"""Run the reproducible remote PT-BR wake-word candidate training pipeline."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

from huggingface_hub import HfApi, snapshot_download


def run(*args: str) -> None:
    print("+", " ".join(args), flush=True)
    subprocess.run(args, check=True)


def stable_validation(path: Path) -> bool:
    """Keep approximately 20% in validation, stable across reruns/machines."""
    digest = hashlib.sha256(path.name.encode()).digest()
    return digest[0] < 51


def stage_reviewed(dataset: Path, model_dir: Path) -> dict[str, int]:
    counts: dict[str, int] = {}
    for kind in ("positive", "negative"):
        files = sorted((dataset / kind).glob("*.wav"))
        if not files:
            raise RuntimeError(f"private dataset has no {kind} wav files")
        for split, selected in (
            ("test", [p for p in files if stable_validation(p)]),
            ("train", [p for p in files if not stable_validation(p)]),
        ):
            if not selected:
                raise RuntimeError(f"empty {kind}_{split} split")
            destination = model_dir / f"{kind}_{split}"
            destination.mkdir(parents=True, exist_ok=True)
            for index, source in enumerate(selected, start=500000):
                shutil.copy2(source, destination / f"clip_{index:06d}.wav")
            counts[f"{kind}_{split}"] = len(selected)
    print("reviewed corpus staged:", json.dumps(counts, sort_keys=True), flush=True)
    return counts


def config_model_name(config: Path) -> str:
    for line in config.read_text().splitlines():
        if line.startswith("model_name:"):
            name = line.split(":", 1)[1].strip()
            if name and all(char.isalnum() or char in "_-" for char in name):
                return name
    raise RuntimeError(f"missing or invalid model_name in {config}")


def upload_artifacts(
    output_dir: Path,
    repo_id: str,
    token: str,
    config: Path,
    split_counts: dict[str, int],
) -> None:
    api = HfApi(token=token)
    api.create_repo(repo_id, repo_type="model", private=True, exist_ok=True)
    artifacts = output_dir / "publish"
    artifacts.mkdir(parents=True, exist_ok=True)
    for pattern in (
        "*.onnx",
        "*_eval.json",
        "*_metrics.json",
        "*_det.png",
        "*_features_test.npy",
        "*_features_train.npy",
    ):
        for source in output_dir.glob(pattern):
            shutil.copy2(source, artifacts / source.name)
    shutil.copy2(config, artifacts / "training-config.yaml")
    manifest = {
        "torch": __import__("torch").__version__,
        "source_dataset": "cleofasrocha/nexus-ei-jarvis-ptbr-data",
        "pipeline": "livekit-wakeword + reviewed real microphone + ElevenLabs",
        "reviewed_split_counts": split_counts,
    }
    (artifacts / "training-manifest.json").write_text(json.dumps(manifest, indent=2))
    if not list(artifacts.glob("*.onnx")):
        raise RuntimeError("training completed without ONNX artifact")
    api.upload_folder(
        repo_id=repo_id,
        repo_type="model",
        folder_path=artifacts,
        commit_message="Publish PT-BR Jarvis production candidate",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--dataset", default="cleofasrocha/nexus-ei-jarvis-ptbr-data")
    parser.add_argument("--model-repo", default="cleofasrocha/nexus-ei-jarvis-ptbr")
    parser.add_argument(
        "--skip-generate",
        action="store_true",
        help="Train only from the reviewed corpus instead of generating TTS samples.",
    )
    args = parser.parse_args()
    token = os.environ.get("HF_WRITE_TOKEN", "").strip()
    if not token:
        raise SystemExit("HF_WRITE_TOKEN is required")

    config = args.config.resolve()
    workspace = config.parent
    os.chdir(workspace)
    dataset = Path(
        snapshot_download(
            repo_id=args.dataset,
            repo_type="dataset",
            token=token,
            local_dir=workspace / "reviewed-data",
        )
    )

    run("livekit-wakeword", "setup", "--config", str(config))
    if not args.skip_generate:
        run("livekit-wakeword", "generate", str(config))

    model_dir = workspace / "output" / config_model_name(config)
    split_counts = stage_reviewed(dataset, model_dir)

    for stage in ("augment", "train", "export", "eval"):
        run("livekit-wakeword", stage, str(config))

    upload_artifacts(model_dir, args.model_repo, token, config, split_counts)
    print("PRODUCTION_CANDIDATE_PUBLISHED", args.model_repo, flush=True)


if __name__ == "__main__":
    main()
