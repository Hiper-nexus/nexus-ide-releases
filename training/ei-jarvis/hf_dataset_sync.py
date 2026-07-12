#!/usr/bin/env python3
"""Publish the local wake-word recordings to a private Hugging Face dataset.

The token is read with ``getpass`` unless ``HF_TOKEN`` is already present. It
is never written by this script. Only the reviewed recording classes and the
manifest are uploaded; caches, generated features and rejected clips stay
local.
"""

from __future__ import annotations

import argparse
import getpass
import os
from pathlib import Path

from huggingface_hub import CommitOperationAdd, HfApi


ALLOWED_SUFFIXES = {".wav", ".jsonl"}
ALLOWED_TOP_LEVEL = {"positive", "negative", "manifest.jsonl"}


def selected_files(source: Path) -> list[Path]:
    files = [
        path
        for path in source.rglob("*")
        if path.is_file()
        and path.suffix.lower() in ALLOWED_SUFFIXES
        and path.relative_to(source).parts[0] in ALLOWED_TOP_LEVEL
    ]
    if not any(path.parent.name == "positive" for path in files):
        raise SystemExit("dataset has no positive recordings")
    if not any(path.parent.name == "negative" for path in files):
        raise SystemExit("dataset has no negative recordings")
    return sorted(files)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True, help="owner/name dataset repo")
    parser.add_argument(
        "--source",
        type=Path,
        default=Path(__file__).parent / "recordings",
    )
    args = parser.parse_args()

    source = args.source.expanduser().resolve()
    files = selected_files(source)
    token = os.environ.get("HF_TOKEN") or getpass.getpass("HF token: ")
    if not token.strip():
        raise SystemExit("empty Hugging Face token")

    api = HfApi(token=token.strip())
    api.create_repo(
        repo_id=args.repo,
        repo_type="dataset",
        private=True,
        exist_ok=True,
    )
    api.create_commit(
        repo_id=args.repo,
        repo_type="dataset",
        operations=[
            CommitOperationAdd(
                path_in_repo=str(path.relative_to(source)),
                path_or_fileobj=path,
            )
            for path in files
        ],
        commit_message="Upload reviewed PT-BR wake-word recordings",
    )
    print(f"uploaded {len(files)} reviewed files to private dataset {args.repo}")


if __name__ == "__main__":
    main()
