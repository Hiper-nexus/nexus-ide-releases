#!/usr/bin/env python3
"""Record small real PT-BR wake datasets on the deployment microphone."""

from __future__ import annotations

import argparse
import json
import time
import wave
from pathlib import Path

import numpy as np
import sounddevice as sd

POSITIVE_PROMPTS = ["Jarvis", "Ei Jarvis", "Oi Jarvis", "Acorda Jarvis"]
NEGATIVE_PROMPTS = [
    "já vi", "Jair", "jardim", "Jarbas", "JavaScript", "Java", "javis",
    "jarros", "chaves", "serviço", "abre o terminal", "abre o projeto",
    "encontre a pasta", "mande para o agente", "leia o painel",
    "continue trabalhando", "execute os testes", "qual é o status",
    "mostre os arquivos", "crie um terminal", "feche a janela",
    "nova missão", "pode continuar", "vamos continuar", "isso está correto",
    "não precisa responder", "estou falando com outra pessoa", "bom dia",
    "obrigado por assistir", "ative as notificações",
]


def write_wav(path: Path, samples: np.ndarray, sample_rate: int) -> None:
    pcm = np.clip(samples, -1, 1)
    pcm = (pcm * 32767).astype("<i2")
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(sample_rate)
        out.writeframes(pcm.tobytes())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", choices=["positive", "negative"], required=True)
    parser.add_argument("--count", type=int, default=30)
    parser.add_argument("--seconds", type=float, default=2.5)
    parser.add_argument("--output", type=Path, default=Path("recordings"))
    args = parser.parse_args()

    sample_rate = 16000
    target = args.output / args.kind
    target.mkdir(parents=True, exist_ok=True)
    prompts = POSITIVE_PROMPTS if args.kind == "positive" else NEGATIVE_PROMPTS
    manifest = args.output / "manifest.jsonl"

    for index in range(args.count):
        prompt = prompts[index % len(prompts)]
        input(f"[{index + 1}/{args.count}] Diga: {prompt!r}. Enter para gravar…")
        print("gravando…", flush=True)
        audio = sd.rec(
            int(args.seconds * sample_rate),
            samplerate=sample_rate,
            channels=1,
            dtype="float32",
        )
        sd.wait()
        samples = audio[:, 0]
        stamp = int(time.time() * 1000)
        path = target / f"{args.kind}-{stamp}-{index:03d}.wav"
        write_wav(path, samples, sample_rate)
        row = {
            "path": str(path),
            "label": args.kind,
            "prompt": prompt,
            "sample_rate": sample_rate,
            "duration_sec": args.seconds,
            "rms": float(np.sqrt(np.mean(np.square(samples)))),
        }
        with manifest.open("a", encoding="utf-8") as out:
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(f"salvo {path} rms={row['rms']:.5f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
