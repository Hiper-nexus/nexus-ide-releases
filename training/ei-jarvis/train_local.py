#!/usr/bin/env python3
"""
Treino local do wake word PT-BR "Ei Jarvis" para NexusIDE.

Gera positivos com edge-tts (vozes PT), extrai embeddings openWakeWord,
treina a cabeça 16×96 → score, exporta ONNX e instala em:
  ~/.nexus/models/wake/custom.onnx

Uso:
  python3 train_local.py
  python3 train_local.py --steps 4000 --positives 300
"""

from __future__ import annotations

import argparse
import asyncio
import itertools
import os
import random
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WORK = ROOT / "work"
INSTALL_DIR = Path.home() / ".nexus" / "models" / "wake"
INSTALL_PATH = INSTALL_DIR / "custom.onnx"


def log(msg: str) -> None:
    print(msg, flush=True)


def run(cmd: list[str], **kwargs) -> None:
    log(f"$ {' '.join(cmd)}")
    subprocess.check_call(cmd, **kwargs)


def ensure_ffmpeg() -> None:
    if shutil.which("ffmpeg"):
        return
    raise SystemExit(
        "ffmpeg não encontrado no PATH. Instale com: brew install ffmpeg"
    )


def _macos_pt_voices() -> list[str]:
    """Vozes PT instaladas no macOS (`say -v ?`)."""
    try:
        out = subprocess.check_output(["say", "-v", "?"], text=True, stderr=subprocess.STDOUT)
    except Exception:  # noqa: BLE001
        return ["Luciana"]
    voices: list[str] = []
    for line in out.splitlines():
        # "Luciana             pt_BR    # …"
        # "Eddy (Português (Brasil)) pt_BR    # …"
        if "pt_BR" not in line and "pt_PT" not in line:
            continue
        # nome = tudo antes de " pt_BR"/" pt_PT"
        for tag in (" pt_BR", " pt_PT"):
            if tag in line:
                name = line.split(tag, 1)[0].strip()
                break
        else:
            name = line.split("#", 1)[0].strip()
        if name:
            voices.append(name)
    preferred = ["Luciana", "Felipe"]
    ordered = [v for v in preferred if v in voices] + [
        v for v in voices if v not in preferred
    ]
    return ordered or ["Luciana"]


def generate_positives_macos(n_target: int) -> int:
    """Gera positivos 16 kHz mono com `say` (offline, PT-BR/PT-PT)."""
    wav_dir = WORK / "positives"
    wav_dir.mkdir(parents=True, exist_ok=True)
    # limpa rodada anterior incompleta
    for old in wav_dir.glob("*.wav"):
        old.unlink()

    voices = _macos_pt_voices()
    log(f"vozes macOS PT: {voices}")
    texts = [
        "jarvis",
        "Jarvis",
        "ei jarvis",
        "Ei Jarvis",
        "ei, jarvis",
        "hey jarvis",
        "oi jarvis",
        "olá jarvis",
        "Jarvis.",
        "ei jarvis.",
    ]
    # words-per-minute style rates for `say -r`
    rates = [120, 150, 170, 190, 220, 250]

    combos = list(itertools.product(voices, texts, rates))
    random.shuffle(combos)
    combos = combos[:n_target]

    n = 0
    for voice, text, rate in combos:
        out = wav_dir / f"{n:04d}.wav"
        try:
            run(
                [
                    "say",
                    "-v",
                    voice,
                    "-r",
                    str(rate),
                    "-o",
                    str(out),
                    "--data-format=LEI16@16000",
                    text,
                ]
            )
            if out.stat().st_size > 500:
                n += 1
            else:
                out.unlink(missing_ok=True)
        except Exception as exc:  # noqa: BLE001
            log(f"  skip say ({voice}): {exc}")
            out.unlink(missing_ok=True)
    log(f"positivos wav (macOS say): {n}")
    if n < 30:
        raise SystemExit(f"poucos positivos gerados ({n}) — verifique vozes `say -v ?`")
    return n


async def generate_positives_edge(n_target: int) -> int:
    """Fallback edge-tts (pode falhar com 403 em algumas redes)."""
    import edge_tts

    raw = WORK / "positives_raw"
    wav_dir = WORK / "positives"
    raw.mkdir(parents=True, exist_ok=True)
    wav_dir.mkdir(parents=True, exist_ok=True)

    voices = [
        "pt-BR-AntonioNeural",
        "pt-BR-FranciscaNeural",
        "pt-BR-ThalitaNeural",
        "pt-PT-DuarteNeural",
        "pt-PT-RaquelNeural",
    ]
    texts = [
        "jarvis",
        "Jarvis",
        "ei jarvis",
        "Ei, Jarvis!",
        "ei járvis",
        "Ei Jarvis?",
        "hey jarvis",
        "oi jarvis",
        "Jarvis.",
        "ei jarvis.",
    ]
    rates = ["-20%", "-10%", "+0%", "+10%", "+25%"]
    pitches = ["-20Hz", "-10Hz", "+0Hz", "+10Hz"]

    combos = list(itertools.product(voices, texts, rates, pitches))
    random.shuffle(combos)
    combos = combos[:n_target]

    n = 0
    for voice, text, rate, pitch in combos:
        out = raw / f"{n:04d}.mp3"
        try:
            await edge_tts.Communicate(text, voice, rate=rate, pitch=pitch).save(
                str(out)
            )
            n += 1
        except Exception as exc:  # noqa: BLE001 — skip flaky TTS variants
            log(f"  skip tts: {exc}")
    log(f"positivos mp3: {n}")

    for mp3 in sorted(raw.glob("*.mp3")):
        wav = wav_dir / f"{mp3.stem}.wav"
        run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-i",
                str(mp3),
                "-ar",
                "16000",
                "-ac",
                "1",
                str(wav),
            ]
        )
    count = len(list(wav_dir.glob("*.wav")))
    log(f"positivos wav: {count}")
    return count


def generate_positives(n_target: int, source: str = "macos") -> int:
    if source == "edge":
        return asyncio.run(generate_positives_edge(n_target))
    return generate_positives_macos(n_target)


def augment_positives(copies: int = 3) -> int:
    import glob

    import numpy as np
    import scipy.io.wavfile as wavfile
    from audiomentations import AddColorNoise, Compose, Gain, PitchShift

    out_dir = WORK / "positives_aug"
    out_dir.mkdir(parents=True, exist_ok=True)
    aug = Compose(
        [
            AddColorNoise(p=0.7),
            Gain(min_gain_db=-8, max_gain_db=6, p=0.8),
            PitchShift(min_semitones=-2, max_semitones=2, p=0.4),
        ]
    )
    i = 0
    for f in glob.glob(str(WORK / "positives" / "*.wav")):
        sr, x = wavfile.read(f)
        x = x.astype(np.float32) / 32768.0
        for _ in range(copies):
            y = aug(samples=x, sample_rate=16000)
            pad = np.zeros(16000, dtype=np.float32)
            y2 = np.concatenate([pad, y, pad])
            wavfile.write(
                str(out_dir / f"{i:05d}.wav"),
                16000,
                (np.clip(y2, -1, 1) * 32767).astype(np.int16),
            )
            i += 1
    log(f"aumentados: {i}")
    return i


def build_positive_windows() -> "object":
    import glob

    import numpy as np
    import openwakeword
    import scipy.io.wavfile as wavfile
    from openwakeword.utils import AudioFeatures

    openwakeword.utils.download_models()
    features = AudioFeatures()
    pos = []
    files = sorted(glob.glob(str(WORK / "positives_aug" / "*.wav")))
    log(f"extraindo embeddings de {len(files)} wavs…")
    for idx, f in enumerate(files):
        _sr, x = wavfile.read(f)
        # mono int16; float → int16 se vier normalizado
        if x.dtype != np.int16:
            x = np.clip(x.astype(np.float32), -1, 1)
            x = (x * 32767).astype(np.int16)
        if x.ndim > 1:
            x = x[:, 0]
        # openWakeWord espera ndarray 2D (batch, samples)
        batch = np.ascontiguousarray(x.astype(np.int16)[None, :])
        try:
            clips = features.embed_clips(batch, batch_size=1)
        except Exception as exc:  # noqa: BLE001
            log(f"  skip embed {Path(f).name}: {exc}")
            continue
        feat = clips[0] if isinstance(clips, (list, tuple)) else clips
        feat = np.asarray(feat)
        if feat.ndim == 3:
            feat = feat[0]
        if feat.ndim != 2 or feat.shape[1] != 96:
            log(f"  skip shape {Path(f).name}: {feat.shape}")
            continue
        for s in range(0, max(1, feat.shape[0] - 16), 4):
            w = feat[s : s + 16]
            if w.shape[0] == 16:
                pos.append(np.asarray(w, dtype=np.float32))
        if (idx + 1) % 50 == 0:
            log(f"  …{idx + 1}/{len(files)} (janelas={len(pos)})")
    arr = np.array(pos, dtype=np.float32)
    log(f"janelas positivas: {arr.shape}")
    if arr.shape[0] < 50:
        raise SystemExit(f"poucas janelas positivas ({arr.shape[0]}) — abortando")
    np.save(WORK / "pos_windows.npy", arr)
    return arr


def build_negative_windows(n_clips: int = 200) -> "object":
    """
    Negativos locais (sem baixar 6GB do HF):
    - ruído / silêncio
    - falas PT-BR com `say` que NÃO contêm Jarvis
    """
    import numpy as np
    import openwakeword
    import scipy.io.wavfile as wavfile
    from openwakeword.utils import AudioFeatures

    neg_dir = WORK / "negatives"
    neg_dir.mkdir(parents=True, exist_ok=True)
    voices = _macos_pt_voices()[:4] or ["Luciana"]
    phrases = [
        "abrir o terminal",
        "bom dia",
        "como vai você",
        "roda os testes",
        "qual é a hora",
        "salva o arquivo",
        "nova missão",
        "fecha a janela",
        "mostrar os logs",
        "tudo bem",
        "obrigado",
        "por favor continua",
        "não entendi",
        "ok pode seguir",
        "verifica o git",
    ]
    rates = [150, 180, 220]
    n = 0
    # falas reais não-wake
    for voice, text, rate in itertools.product(voices, phrases, rates):
        if n >= n_clips // 2:
            break
        out = neg_dir / f"speech_{n:04d}.wav"
        try:
            run(
                [
                    "say",
                    "-v",
                    voice,
                    "-r",
                    str(rate),
                    "-o",
                    str(out),
                    "--data-format=LEI16@16000",
                    text,
                ]
            )
            if out.stat().st_size > 500:
                n += 1
            else:
                out.unlink(missing_ok=True)
        except Exception as exc:  # noqa: BLE001
            log(f"  skip neg say: {exc}")
            out.unlink(missing_ok=True)

    # ruído / silêncio sintético
    rng = np.random.default_rng(7)
    for i in range(n, n_clips):
        secs = float(rng.uniform(1.5, 3.5))
        samples = int(16000 * secs)
        kind = i % 3
        if kind == 0:
            audio = (rng.normal(0, 0.02, samples) * 32767).astype(np.int16)
        elif kind == 1:
            audio = np.zeros(samples, dtype=np.int16)
        else:
            t = np.arange(samples) / 16000.0
            tone = 0.05 * np.sin(2 * np.pi * 220 * t)
            audio = (tone * 32767).astype(np.int16)
        wavfile.write(str(neg_dir / f"noise_{i:04d}.wav"), 16000, audio)

    openwakeword.utils.download_models()
    features = AudioFeatures()
    neg_windows = []
    files = sorted(neg_dir.glob("*.wav"))
    log(f"extraindo embeddings negativos de {len(files)} wavs…")
    for f in files:
        _sr, x = wavfile.read(str(f))
        if x.dtype != np.int16:
            x = (np.clip(x.astype(np.float32), -1, 1) * 32767).astype(np.int16)
        if x.ndim > 1:
            x = x[:, 0]
        batch = np.ascontiguousarray(x.astype(np.int16)[None, :])
        try:
            clips = features.embed_clips(batch, batch_size=1)
        except Exception as exc:  # noqa: BLE001
            log(f"  skip neg embed {f.name}: {exc}")
            continue
        feat = clips[0] if isinstance(clips, (list, tuple)) else clips
        feat = np.asarray(feat)
        if feat.ndim == 3:
            feat = feat[0]
        if feat.ndim != 2 or feat.shape[1] != 96:
            continue
        for s in range(0, max(1, feat.shape[0] - 16), 4):
            w = feat[s : s + 16]
            if w.shape[0] == 16:
                neg_windows.append(np.asarray(w, dtype=np.float32))
    arr = np.array(neg_windows, dtype=np.float32)
    log(f"janelas negativas: {arr.shape}")
    if arr.shape[0] < 50:
        raise SystemExit(f"poucas janelas negativas ({arr.shape[0]})")
    np.save(WORK / "neg_windows.npy", arr)
    return arr


def train_and_export(pos, neg, steps: int, batch: int) -> Path:
    import numpy as np
    import torch
    import torch.nn as nn

    if torch.backends.mps.is_available():
        dev = torch.device("mps")
    elif torch.cuda.is_available():
        dev = torch.device("cuda")
    else:
        dev = torch.device("cpu")
    log(f"device treino: {dev}")

    class Head(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.net = nn.Sequential(
                nn.Flatten(),
                nn.Linear(16 * 96, 128),
                nn.LayerNorm(128),
                nn.ReLU(),
                nn.Linear(128, 1),
                nn.Sigmoid(),
            )

        def forward(self, x):  # type: ignore[no-untyped-def]
            return self.net(x)

    # Janelas já empilhadas [N, 16, 96]
    if len(neg.shape) != 3 or neg.shape[1:] != (16, 96):
        raise SystemExit(f"shape de negativos inesperado: {neg.shape}")
    if len(pos.shape) != 3 or pos.shape[1:] != (16, 96):
        raise SystemExit(f"shape de positivos inesperado: {pos.shape}")

    m = Head().to(dev)
    opt = torch.optim.AdamW(m.parameters(), lr=1e-3)
    lossf = nn.BCELoss()
    pos_t = torch.tensor(pos, device=dev)
    neg_t = torch.tensor(neg, device=dev)
    n_pos = pos_t.shape[0]
    n_neg = neg_t.shape[0]

    log(f"treino: steps={steps} batch={batch} pos={n_pos} neg={n_neg}")
    for step in range(steps):
        n_pos_b = max(1, batch // 4)
        n_neg_b = batch
        n_silence_b = max(8, batch // 2)
        pi = torch.randint(0, n_pos, (n_pos_b,), device=dev)
        ni = torch.randint(0, n_neg, (n_neg_b,), device=dev)
        # O loader faz um probe com embeddings zerados. Treinar essa região
        # explicitamente evita que o bias do head fique próximo de 0.5 e
        # transforme silêncio/baixo sinal em falso positivo.
        silence = torch.empty(n_silence_b, 16, 96, device=dev).uniform_(-0.08, 0.08)
        silence[: n_silence_b // 4].zero_()
        xb = torch.cat([pos_t[pi], neg_t[ni], silence])
        yb = torch.cat(
            [
                torch.ones(n_pos_b, 1, device=dev),
                torch.zeros(n_neg_b, 1, device=dev),
                torch.zeros(n_silence_b, 1, device=dev),
            ]
        )
        opt.zero_grad()
        loss = lossf(m(xb), yb)
        loss.backward()
        opt.step()
        if step % 500 == 0 or step == steps - 1:
            log(f"  step {step}/{steps} loss={float(loss):.4f}")

    m.eval()
    m.cpu()
    onnx_path = WORK / "ei_jarvis.onnx"
    torch.onnx.export(
        m,
        torch.zeros(1, 16, 96),
        str(onnx_path),
        input_names=["x.1"],
        output_names=["y"],
        opset_version=17,
    )
    log(f"exportado: {onnx_path} ({onnx_path.stat().st_size} bytes)")
    return onnx_path


def validate_onnx(onnx_path: Path, pos, neg=None) -> None:
    import numpy as np
    import onnxruntime as rt

    sess = rt.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    inp = sess.get_inputs()[0].name

    def score_one(window: np.ndarray) -> float:
        out = sess.run(None, {inp: window.astype(np.float32)[None, ...]})[0]
        return float(np.asarray(out).reshape(-1)[0])

    pos_scores = [score_one(pos[i]) for i in range(min(64, pos.shape[0]))]
    zero_score = score_one(np.zeros((16, 96), np.float32))
    mean_pos = float(np.mean(pos_scores))
    min_pos = float(np.min(pos_scores))
    log(
        f"validação ONNX: pos[0]={pos_scores[0]:.4f} mean_pos={mean_pos:.4f} "
        f"min_pos={min_pos:.4f} zero={zero_score:.4f}"
    )
    if neg is not None and neg.shape[0] > 0:
        neg_scores = [score_one(neg[i]) for i in range(min(64, neg.shape[0]))]
        mean_neg = float(np.mean(neg_scores))
        max_neg = float(np.max(neg_scores))
        log(f"validação ONNX: mean_neg={mean_neg:.4f} max_neg={max_neg:.4f}")
    if mean_pos <= zero_score + 0.05:
        raise SystemExit(
            f"modelo fraco: mean_pos ({mean_pos:.3f}) não separa de zero ({zero_score:.3f})"
        )
    if zero_score >= 0.45:
        raise SystemExit(
            f"modelo rejeitado: silêncio={zero_score:.3f} >= 0.45"
        )
    if mean_pos < 0.55:
        log(
            f"AVISO: mean_pos={mean_pos:.3f} < 0.55 — threshold custom do app é 0.65; "
            "pode precisar de mais steps ou dados reais."
        )
    # header protobuf
    head = onnx_path.read_bytes()[:1]
    if head != b"\x08":
        raise SystemExit("ONNX sem header protobuf esperado (0x08)")

    # contrato do app: input float32 [1,16,96]
    meta = sess.get_inputs()[0]
    log(f"contrato ONNX: name={meta.name} shape={meta.shape} type={meta.type}")


def install(onnx_path: Path) -> None:
    INSTALL_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(onnx_path, INSTALL_PATH)
    log(f"instalado: {INSTALL_PATH} ({INSTALL_PATH.stat().st_size} bytes)")


def main() -> None:
    parser = argparse.ArgumentParser(description="Treino wake PT-BR Ei Jarvis")
    parser.add_argument("--steps", type=int, default=6000)
    parser.add_argument("--batch", type=int, default=256)
    parser.add_argument("--positives", type=int, default=360)
    parser.add_argument("--aug-copies", type=int, default=3)
    parser.add_argument(
        "--skip-generate",
        action="store_true",
        help="reusa work/positives_aug e pos_windows se existirem",
    )
    parser.add_argument(
        "--tts",
        choices=("macos", "edge"),
        default="macos",
        help="fonte de áudio sintético (macos=say offline; edge=edge-tts online)",
    )
    args = parser.parse_args()

    if args.tts == "edge":
        ensure_ffmpeg()
    WORK.mkdir(parents=True, exist_ok=True)
    random.seed(42)

    import numpy as np

    pos_cache = WORK / "pos_windows.npy"
    neg_cache = WORK / "neg_windows.npy"
    if args.skip_generate and pos_cache.exists():
        pos = np.load(pos_cache)
        log(f"reusando cache positivo: {pos.shape}")
    else:
        if not args.skip_generate or not list((WORK / "positives").glob("*.wav")):
            generate_positives(args.positives, source=args.tts)
            if args.tts == "edge":
                ensure_ffmpeg()
            augment_positives(args.aug_copies)
        pos = build_positive_windows()

    if args.skip_generate and neg_cache.exists():
        neg = np.load(neg_cache)
        log(f"reusando cache negativo: {neg.shape}")
    else:
        neg = build_negative_windows(n_clips=220)

    onnx_path = train_and_export(pos, neg, steps=args.steps, batch=args.batch)
    validate_onnx(onnx_path, pos, neg)
    install(onnx_path)
    log("")
    log("OK — modelo PT-BR instalado.")
    log("Reinicie o NexusIDE e confira no log main:")
    log("  [wake] modelo PT-BR adicional carregado: .../custom.onnx")
    log("Nos scores: source=custom e threshold=0.65")


if __name__ == "__main__":
    main()
