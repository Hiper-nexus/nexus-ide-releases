#!/usr/bin/env python3
"""Build a synthetic PT-BR wake-word ONNX candidate without installing it."""

from __future__ import annotations

import argparse
import asyncio
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import itertools
import json
from pathlib import Path
import random
import shutil
import subprocess
import sys
from typing import Any, Callable, Sequence


SAMPLE_RATE = 16_000
FEATURE_FRAMES = 16
FEATURE_SIZE = 96
FEATURE_STEP_SECONDS = 0.08
CONTEXT_SECONDS = 1.0
TARGET_PHRASES = (
    'Hey Jarvis',
    'Hey, Jarvis',
    'Hey Jarvis!',
    'Ei Jarvis',
    'Ei, Jarvis',
    'Ei Jarvis!',
    'E aí Jarvis',
    'E aí, Jarvis',
    'E aí Jarvis!',
)
RATES = ('-20%', '-10%', '+0%', '+10%', '+20%')
PITCHES = ('-20Hz', '-10Hz', '+0Hz', '+10Hz', '+20Hz')
THRESHOLDS = (0.30, 0.35, 0.40, 0.42, 0.45, 0.50, 0.55, 0.60)
RUNTIME_CUSTOM_THRESHOLD = 0.65
DEFAULT_SOURCE_CLIPS = 600
NEGATIVE_REPOSITORY = 'davidscripka/openwakeword_features'
NEGATIVE_FILENAME = 'openwakeword_features_ACAV100M_2000_hrs_16bit.npy'
SCRIPT_DIR = Path(__file__).resolve().parent
LIVE_NEXUS_MODEL = Path.home() / '.nexus/models/wake/custom.onnx'
LIVE_NEXUS_WAKE_DIRECTORY = LIVE_NEXUS_MODEL.parent
NEXUS_HOME = Path.home() / '.nexus'


@dataclass(frozen=True)
class TtsSpec:
    text: str
    voice: str
    rate: str
    pitch: str


@dataclass(frozen=True)
class Dependencies:
    audio_features: Any
    edge_tts: Any
    hf_hub_download: Callable[..., str]
    np: Any
    onnx: Any
    ort: Any
    scipy_signal: Any
    scipy_wavfile: Any
    torch: Any
    torch_nn: Any


@dataclass(frozen=True)
class AugmentedClip:
    source_index: int
    path: Path
    target_start_seconds: float
    target_end_seconds: float


def default_candidate_output() -> Path:
    return SCRIPT_DIR / 'artifacts/hey_jarvis_ptbr_candidate.onnx'


def default_workspace() -> Path:
    return SCRIPT_DIR / 'workspace'


def resolve_candidate_output(value: Path | str) -> Path:
    output = Path(value).expanduser().resolve()
    if output.is_relative_to(LIVE_NEXUS_WAKE_DIRECTORY.resolve()):
        raise ValueError(
            'recusado: o treino só produz candidato; não pode escrever no diretório de modelos ativo do Nexus',
        )
    if output.suffix != '.onnx':
        raise ValueError('--output precisa terminar em .onnx')
    return output


def candidate_sidecars(candidate: Path) -> tuple[Path, Path]:
    return candidate.with_suffix('.metrics.json'), candidate.with_suffix('.manifest.json')


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError('precisa ser maior que zero')
    return parsed


def batch_size(value: str) -> int:
    parsed = int(value)
    if parsed < 4:
        raise argparse.ArgumentTypeError('precisa ser pelo menos 4')
    return parsed


def percentage(value: str) -> float:
    parsed = float(value)
    if not 0 < parsed < 0.5:
        raise argparse.ArgumentTypeError('precisa estar entre 0 e 0.5')
    return parsed


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Treina um candidato ONNX PT-BR; nunca instala no Nexus.',
    )
    parser.add_argument('--output', type=Path, default=default_candidate_output())
    parser.add_argument('--workspace', type=Path, default=default_workspace())
    parser.add_argument('--negative-features', type=Path)
    parser.add_argument('--seed', type=int, default=20_260_710)
    parser.add_argument('--source-clips', type=positive_int)
    parser.add_argument('--augmentations-per-source', type=positive_int, default=5)
    parser.add_argument('--max-voices', type=positive_int, default=8)
    parser.add_argument('--tts-concurrency', type=positive_int, default=2)
    parser.add_argument('--steps', type=positive_int, default=6_000)
    parser.add_argument('--batch-size', type=batch_size, default=512)
    parser.add_argument('--validation-fraction', type=percentage, default=0.20)
    parser.add_argument('--device', choices=('auto', 'cpu', 'mps', 'cuda'), default='auto')
    return parser.parse_args(argv)


def require_binary(name: str) -> None:
    if shutil.which(name) is None:
        raise RuntimeError(f'{name} não encontrado no PATH')


def load_dependencies() -> Dependencies:
    try:
        import edge_tts
        from huggingface_hub import hf_hub_download
        import numpy as np
        import onnx
        import onnxruntime as ort
        from openwakeword.utils import AudioFeatures
        from scipy import signal
        from scipy.io import wavfile
        import torch
        from torch import nn
    except ImportError as error:
        raise RuntimeError(
            'dependências ausentes. Crie o ambiente Python 3.11 e instale requirements.txt',
        ) from error
    return Dependencies(
        audio_features=AudioFeatures,
        edge_tts=edge_tts,
        hf_hub_download=hf_hub_download,
        np=np,
        onnx=onnx,
        ort=ort,
        scipy_signal=signal,
        scipy_wavfile=wavfile,
        torch=torch,
        torch_nn=nn,
    )


def select_device(torch: Any, requested: str) -> str:
    available = {
        'cpu': True,
        'mps': bool(getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available()),
        'cuda': bool(torch.cuda.is_available()),
    }
    if requested != 'auto':
        if not available[requested]:
            raise RuntimeError(f'dispositivo indisponível: {requested}')
        return requested
    return next(name for name in ('cuda', 'mps', 'cpu') if available[name])


def seed_everything(dependencies: Dependencies, seed: int) -> None:
    random.seed(seed)
    dependencies.np.random.seed(seed)
    dependencies.torch.manual_seed(seed)
    if dependencies.torch.cuda.is_available():
        dependencies.torch.cuda.manual_seed_all(seed)


async def select_ptbr_voices(edge_tts: Any, max_voices: int) -> list[str]:
    voices = await edge_tts.list_voices()
    selected = sorted(
        voice['ShortName']
        for voice in voices
        if voice.get('Locale') == 'pt-BR' and voice.get('ShortName')
    )
    if not selected:
        raise RuntimeError('edge-tts não retornou vozes pt-BR')
    return selected[:max_voices]


def build_tts_specs(voices: Sequence[str], source_clips: int, seed: int) -> list[TtsSpec]:
    candidates = [
        TtsSpec(text=text, voice=voice, rate=rate, pitch=pitch)
        for voice, text, rate, pitch in itertools.product(voices, TARGET_PHRASES, RATES, PITCHES)
    ]
    if source_clips > len(candidates):
        raise ValueError(
            f'--source-clips={source_clips} excede as {len(candidates)} combinações TTS únicas',
        )
    random.Random(seed).shuffle(candidates)
    return candidates[:source_clips]


def resolve_source_clip_count(voices: Sequence[str], requested: int | None) -> int:
    available = len(voices) * len(TARGET_PHRASES) * len(RATES) * len(PITCHES)
    if requested is not None and requested > available:
        raise ValueError(f'--source-clips={requested} excede as {available} combinações TTS únicas')
    return min(requested or DEFAULT_SOURCE_CLIPS, available)


async def generate_tts_sources(
    edge_tts: Any,
    specs: Sequence[TtsSpec],
    source_dir: Path,
    concurrency: int,
) -> list[Path]:
    semaphore = asyncio.Semaphore(concurrency)

    async def save_one(index: int, spec: TtsSpec) -> Path:
        target = source_dir / f'{index:05d}.mp3'
        async with semaphore:
            communication = edge_tts.Communicate(
                text=spec.text,
                voice=spec.voice,
                rate=spec.rate,
                pitch=spec.pitch,
            )
            await communication.save(str(target))
        return target

    return list(await asyncio.gather(*(save_one(index, spec) for index, spec in enumerate(specs))))


def run_command(command: Sequence[str]) -> None:
    result = subprocess.run(command, check=False, capture_output=True, text=True)
    if result.returncode == 0:
        return
    message = result.stderr.strip() or result.stdout.strip() or 'falha sem saída'
    raise RuntimeError(f'comando falhou: {command[0]} — {message}')


def convert_to_wav(source: Path, destination: Path) -> None:
    run_command(
        (
            'ffmpeg',
            '-nostdin',
            '-v',
            'error',
            '-y',
            '-i',
            str(source),
            '-ar',
            str(SAMPLE_RATE),
            '-ac',
            '1',
            '-c:a',
            'pcm_s16le',
            str(destination),
        ),
    )


def load_wav_as_float(dependencies: Dependencies, source: Path) -> Any:
    rate, samples = dependencies.scipy_wavfile.read(source)
    if rate != SAMPLE_RATE:
        raise RuntimeError(f'{source} não está em {SAMPLE_RATE} Hz')
    if samples.ndim != 1:
        samples = samples.mean(axis=1)
    return dependencies.np.asarray(samples, dtype=dependencies.np.float32) / 32768.0


def rms(np: Any, samples: Any) -> float:
    return float(np.sqrt(np.mean(np.square(samples), dtype=np.float64) + 1e-12))


def build_room_impulse(np: Any, rng: Any) -> Any:
    length = int(SAMPLE_RATE * rng.uniform(0.04, 0.16))
    decay = rng.uniform(0.015, 0.08)
    times = np.arange(length, dtype=np.float32) / SAMPLE_RATE
    tail = rng.standard_normal(length).astype(np.float32) * np.exp(-times / decay)
    impulse = tail * rng.uniform(0.03, 0.15)
    impulse[0] = 1.0
    return impulse


def augment_clip(dependencies: Dependencies, padded_audio: Any, rng: Any) -> Any:
    np = dependencies.np
    reverb = dependencies.scipy_signal.fftconvolve(
        padded_audio,
        build_room_impulse(np, rng),
        mode='full',
    )[: len(padded_audio)]
    gain = float(10 ** (rng.uniform(-9.0, 5.0) / 20.0))
    adjusted = reverb * gain
    snr_db = rng.uniform(6.0, 26.0)
    noise = rng.standard_normal(len(adjusted)).astype(np.float32)
    noise *= rms(np, adjusted) / rms(np, noise) / (10 ** (snr_db / 20.0))
    return np.clip(adjusted + noise, -1.0, 1.0).astype(np.float32)


def write_wav(dependencies: Dependencies, destination: Path, samples: Any) -> None:
    int16 = (dependencies.np.clip(samples, -1.0, 1.0) * 32767).astype(dependencies.np.int16)
    dependencies.scipy_wavfile.write(destination, SAMPLE_RATE, int16)


def create_augmented_clips(
    dependencies: Dependencies,
    sources: Sequence[Path],
    clips_dir: Path,
    augmentations_per_source: int,
    seed: int,
) -> list[AugmentedClip]:
    clips: list[AugmentedClip] = []
    context = dependencies.np.zeros(int(SAMPLE_RATE * CONTEXT_SECONDS), dtype=dependencies.np.float32)
    for source_index, source in enumerate(sources):
        speech = load_wav_as_float(dependencies, source)
        padded = dependencies.np.concatenate((context, speech, context))
        target_end = CONTEXT_SECONDS + len(speech) / SAMPLE_RATE
        for augmentation_index in range(augmentations_per_source):
            output = clips_dir / f'{source_index:05d}_{augmentation_index:02d}.wav'
            rng = dependencies.np.random.default_rng(seed + source_index * 10_000 + augmentation_index)
            write_wav(dependencies, output, augment_clip(dependencies, padded, rng))
            clips.append(AugmentedClip(source_index, output, CONTEXT_SECONDS, target_end))
    return clips


def select_target_windows(features: Any, target_start: float, target_end: float) -> Any:
    if len(features) < FEATURE_FRAMES:
        raise RuntimeError('clipe gerou poucos embeddings para uma janela de wake')
    center = round(((target_start + target_end) / 2) / FEATURE_STEP_SECONDS)
    starts = {
        max(0, min(len(features) - FEATURE_FRAMES, center - FEATURE_FRAMES // 2 + offset))
        for offset in (-2, 0, 2)
    }
    return [features[start : start + FEATURE_FRAMES] for start in sorted(starts)]


def build_positive_groups(dependencies: Dependencies, clips: Sequence[AugmentedClip]) -> list[Any]:
    extractor = dependencies.audio_features(inference_framework='onnx', ncpu=1)
    grouped_windows: dict[int, list[Any]] = {}
    for clip in clips:
        _, samples = dependencies.scipy_wavfile.read(clip.path)
        audio = dependencies.np.asarray(samples, dtype=dependencies.np.int16)
        features = extractor.embed_clips(audio[None, :], batch_size=1, ncpu=1)[0]
        windows = select_target_windows(features, clip.target_start_seconds, clip.target_end_seconds)
        grouped_windows.setdefault(clip.source_index, []).append(
            dependencies.np.asarray(windows, dtype=dependencies.np.float32),
        )
    return [
        dependencies.np.concatenate(grouped_windows[index])
        for index in sorted(grouped_windows)
    ]


def resolve_negative_features(dependencies: Dependencies, requested: Path | None, cache_dir: Path) -> Path:
    if requested:
        path = requested.expanduser().resolve()
        if not path.is_file():
            raise FileNotFoundError(f'negative features não encontrados: {path}')
        return path
    return Path(
        dependencies.hf_hub_download(
            repo_id=NEGATIVE_REPOSITORY,
            filename=NEGATIVE_FILENAME,
            repo_type='dataset',
            local_dir=str(cache_dir),
        ),
    )


def sample_negative_windows(np: Any, features: Any, count: int, rng: Any) -> Any:
    if features.shape[-1] != FEATURE_SIZE:
        raise RuntimeError(f'negative features incompatíveis: último eixo precisa ser {FEATURE_SIZE}')
    if features.ndim == 2:
        if len(features) <= FEATURE_FRAMES:
            raise RuntimeError('negative features insuficientes')
        starts = rng.integers(0, len(features) - FEATURE_FRAMES, size=count)
        return np.stack([features[start : start + FEATURE_FRAMES] for start in starts]).astype(np.float32)
    if features.ndim == 3 and features.shape[1] >= FEATURE_FRAMES:
        rows = rng.integers(0, features.shape[0], size=count)
        offsets = rng.integers(0, features.shape[1] - FEATURE_FRAMES + 1, size=count)
        return np.stack(
            [features[row, offset : offset + FEATURE_FRAMES] for row, offset in zip(rows, offsets)],
        ).astype(np.float32)
    raise RuntimeError('formato de negative features não suportado')


def split_positive_groups(np: Any, groups: Sequence[Any], fraction: float, seed: int) -> tuple[Any, Any]:
    if len(groups) < 2:
        raise RuntimeError('são necessários pelo menos dois grupos positivos')
    indices = np.random.default_rng(seed).permutation(len(groups))
    validation_count = max(1, round(len(groups) * fraction))
    validation_indexes = set(indices[:validation_count].tolist())
    training = [group for index, group in enumerate(groups) if index not in validation_indexes]
    validation = [group for index, group in enumerate(groups) if index in validation_indexes]
    return np.concatenate(training), np.concatenate(validation)


def create_wake_head(torch_nn: Any) -> Any:
    class WakeHead(torch_nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.network = torch_nn.Sequential(
                torch_nn.Flatten(),
                torch_nn.Linear(FEATURE_FRAMES * FEATURE_SIZE, 128),
                torch_nn.LayerNorm(128),
                torch_nn.ReLU(),
                torch_nn.Linear(128, 1),
                torch_nn.Sigmoid(),
            )

        def forward(self, features: Any) -> Any:
            return self.network(features)

    return WakeHead()


def predict_scores(dependencies: Dependencies, model: Any, samples: Any, device: str) -> Any:
    torch = dependencies.torch
    model.eval()
    batches = []
    with torch.no_grad():
        for offset in range(0, len(samples), 512):
            batch = torch.from_numpy(samples[offset : offset + 512]).to(device)
            batches.append(model(batch).detach().cpu().numpy().reshape(-1))
    return dependencies.np.concatenate(batches)


def threshold_report(np: Any, positives: Any, negatives: Any) -> list[dict[str, float]]:
    return [
        {
            'threshold': threshold,
            'falseRejectRate': float(np.mean(positives < threshold)),
            'falseAcceptRate': float(np.mean(negatives >= threshold)),
        }
        for threshold in (*THRESHOLDS, RUNTIME_CUSTOM_THRESHOLD)
    ]


def train_head(
    dependencies: Dependencies,
    positive_groups: Sequence[Any],
    negative_features: Any,
    args: argparse.Namespace,
) -> tuple[Any, dict[str, Any], str]:
    np = dependencies.np
    torch = dependencies.torch
    device = select_device(torch, args.device)
    train_positive, validation_positive = split_positive_groups(
        np,
        positive_groups,
        args.validation_fraction,
        args.seed,
    )
    rng = np.random.default_rng(args.seed)
    model = create_wake_head(dependencies.torch_nn).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3)
    loss_function = torch.nn.BCELoss()
    positive_count = max(1, args.batch_size // 4)
    negative_count = args.batch_size - positive_count
    for step in range(args.steps):
        positive_indexes = rng.integers(0, len(train_positive), size=positive_count)
        positives = train_positive[positive_indexes]
        negatives = sample_negative_windows(np, negative_features, negative_count, rng)
        inputs = np.concatenate((positives, negatives))
        labels = np.concatenate(
            (np.ones((positive_count, 1), dtype=np.float32), np.zeros((negative_count, 1), dtype=np.float32)),
        )
        order = rng.permutation(len(inputs))
        batch = torch.from_numpy(inputs[order]).to(device)
        expected = torch.from_numpy(labels[order]).to(device)
        optimizer.zero_grad()
        loss = loss_function(model(batch), expected)
        loss.backward()
        optimizer.step()
        if (step + 1) % 500 == 0 or step + 1 == args.steps:
            print(f'train step {step + 1}/{args.steps}: loss={loss.item():.5f}')
    validation_negatives = sample_negative_windows(np, negative_features, len(validation_positive), rng)
    positive_scores = predict_scores(dependencies, model, validation_positive, device)
    negative_scores = predict_scores(dependencies, model, validation_negatives, device)
    metrics = {
        'device': device,
        'trainPositiveWindows': int(len(train_positive)),
        'validationPositiveWindows': int(len(validation_positive)),
        'validationNegativeWindows': int(len(validation_negatives)),
        'positiveScoreMean': float(np.mean(positive_scores)),
        'negativeScoreMean': float(np.mean(negative_scores)),
        'runtimeCustomThreshold': RUNTIME_CUSTOM_THRESHOLD,
        'thresholds': threshold_report(np, positive_scores, negative_scores),
    }
    return model.to('cpu').eval(), metrics, device


def export_candidate(dependencies: Dependencies, model: Any, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    example = dependencies.torch.zeros((1, FEATURE_FRAMES, FEATURE_SIZE), dtype=dependencies.torch.float32)
    dependencies.torch.onnx.export(
        model,
        example,
        str(output),
        input_names=['features'],
        output_names=['score'],
        opset_version=17,
        dynamo=False,
    )


def validate_onnx(dependencies: Dependencies, model: Any, output: Path, seed: int) -> dict[str, float]:
    dependencies.onnx.checker.check_model(str(output))
    sample = dependencies.np.random.default_rng(seed).normal(
        size=(1, FEATURE_FRAMES, FEATURE_SIZE),
    ).astype(dependencies.np.float32)
    with dependencies.torch.no_grad():
        expected = float(model(dependencies.torch.from_numpy(sample)).numpy().reshape(-1)[0])
    session = dependencies.ort.InferenceSession(str(output), providers=['CPUExecutionProvider'])
    observed = float(session.run(None, {'features': sample})[0].reshape(-1)[0])
    if not 0.0 <= observed <= 1.0:
        raise RuntimeError(f'ONNX retornou score inválido: {observed}')
    difference = abs(expected - observed)
    if difference > 1e-4:
        raise RuntimeError(f'ONNX divergiu do PyTorch: {difference}')
    return {'pytorchScore': expected, 'onnxScore': observed, 'absoluteDifference': difference}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + '\n', encoding='utf-8')


def resolve_workspace(workspace: Path | str) -> Path:
    workspace = Path(workspace).expanduser().resolve()
    if workspace.is_relative_to(NEXUS_HOME.resolve()):
        raise ValueError('workspace não pode ficar dentro de ~/.nexus')
    return workspace


def prepare_workspace(workspace: Path | str) -> dict[str, Path]:
    workspace = resolve_workspace(workspace)
    if workspace.exists() and any(workspace.iterdir()):
        raise RuntimeError(f'workspace já contém arquivos: {workspace}; escolha outro --workspace')
    directories = {
        'root': workspace,
        'sources': workspace / 'sources',
        'wav': workspace / 'wav',
        'augmented': workspace / 'augmented',
        'negativeCache': workspace / 'negative-cache',
    }
    for directory in directories.values():
        directory.mkdir(parents=True, exist_ok=True)
    return directories


def package_versions(dependencies: Dependencies) -> dict[str, str]:
    modules = {
        'edge-tts': dependencies.edge_tts,
        'numpy': dependencies.np,
        'onnx': dependencies.onnx,
        'onnxruntime': dependencies.ort,
        'torch': dependencies.torch,
    }
    return {name: str(getattr(module, '__version__', 'unknown')) for name, module in modules.items()}


def execute(args: argparse.Namespace) -> None:
    output = resolve_candidate_output(args.output)
    workspace = resolve_workspace(args.workspace)
    metrics_path, manifest_path = candidate_sidecars(output)
    for path in (output, metrics_path, manifest_path):
        if path.exists():
            raise RuntimeError(f'saída já existe: {path}; preserve o candidato e escolha outro --output')
    require_binary('ffmpeg')
    dependencies = load_dependencies()
    seed_everything(dependencies, args.seed)
    directories = prepare_workspace(workspace)
    voices = asyncio.run(select_ptbr_voices(dependencies.edge_tts, args.max_voices))
    source_clips = resolve_source_clip_count(voices, args.source_clips)
    if source_clips < DEFAULT_SOURCE_CLIPS and args.source_clips is None:
        print(f'apenas {source_clips} combinações TTS pt-BR disponíveis; usando todas')
    specs = build_tts_specs(voices, source_clips, args.seed)
    print(f'gerando {len(specs)} fontes TTS com {len(voices)} vozes pt-BR')
    source_mp3 = asyncio.run(
        generate_tts_sources(
            dependencies.edge_tts,
            specs,
            directories['sources'],
            args.tts_concurrency,
        ),
    )
    write_json(
        directories['root'] / 'sources.json',
        [
            {'file': source.name, 'sha256': sha256(source), **asdict(spec)}
            for source, spec in zip(source_mp3, specs)
        ],
    )
    source_wav = [directories['wav'] / f'{index:05d}.wav' for index in range(len(source_mp3))]
    for source, destination in zip(source_mp3, source_wav):
        convert_to_wav(source, destination)
    clips = create_augmented_clips(
        dependencies,
        source_wav,
        directories['augmented'],
        args.augmentations_per_source,
        args.seed,
    )
    print(f'extraindo embeddings de {len(clips)} clips aumentados')
    positive_groups = build_positive_groups(dependencies, clips)
    negative_path = resolve_negative_features(
        dependencies,
        args.negative_features,
        directories['negativeCache'],
    )
    negative_features = dependencies.np.load(negative_path, mmap_mode='r')
    model, metrics, device = train_head(dependencies, positive_groups, negative_features, args)
    export_candidate(dependencies, model, output)
    validation = validate_onnx(dependencies, model, output, args.seed)
    metrics.update({'onnxValidation': validation, 'candidate': str(output), 'sha256': sha256(output)})
    manifest = {
        'createdAt': datetime.now(timezone.utc).isoformat(),
        'schemaVersion': 1,
        'candidateOnly': True,
        'activeNexusModelUntouched': str(LIVE_NEXUS_MODEL),
        'candidate': str(output),
        'workspace': str(directories['root']),
        'device': device,
        'phrases': list(TARGET_PHRASES),
        'voices': voices,
        'negativeFeatures': str(negative_path),
        'packageVersions': package_versions(dependencies),
        'arguments': {name: str(value) if isinstance(value, Path) else value for name, value in vars(args).items()},
    }
    write_json(metrics_path, metrics)
    write_json(manifest_path, manifest)
    print(f'candidato criado: {output}')
    print(f'métricas: {metrics_path}')
    print(f'manifesto: {manifest_path}')
    print('nenhum arquivo de ~/.nexus/models/wake foi alterado')


def main(argv: Sequence[str] | None = None) -> int:
    try:
        execute(parse_args(argv))
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        print(f'erro: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
