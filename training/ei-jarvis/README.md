# Treinar o wake word "Ei Jarvis" (PT-BR)

O modelo embutido EN (`hey_jarvis`) pontua baixo em sotaque BR. Aqui treinamos
um head PT-BR e **shipamos no binário** (todos os PCs / macOS / Windows / Linux).

Loader do app (`wake-engine.ts`):

1. override `~/.nexus/models/wake/custom.onnx` (se existir)
2. senão head **embutido** `wake-models-ptbr.ts`
3. + head EN em paralelo (threshold custom = 0.65)

---

## Caminho A — LiveKit WakeWord (recomendado para qualidade)

Pipeline de produção: [livekit/livekit-wakeword](https://github.com/livekit/livekit-wakeword)
(head **conv_attention**, VoxCPM PT, eval DET/FPPH). Compatível com o front-end
openWakeWord do Nexus (input `[1,16,96]`).

### Configs

| Arquivo | Uso |
|---|---|
| `configs/ei_jarvis_pt.yaml` | Produção (25k samples, conv_attention, VoxCPM) |
| `configs/ei_jarvis_pt_smoke.yaml` | Smoke rápido do pipeline |

### Script único

```bash
cd training/ei-jarvis

# deps (uma vez)
pip install 'livekit-wakeword[train,eval,export,voxcpm]'
# macOS: brew install espeak-ng ffmpeg

# produção (GPU recomendada; horas)
./train_livekit.sh

# smoke (minutos)
./train_livekit.sh --config configs/ei_jarvis_pt_smoke.yaml

# só re-embutir um ONNX já exportado
./train_livekit.sh --export-only path/to/ei_jarvis.onnx
```

O script:

1. `livekit-wakeword setup` + `run` (generate → train → export → eval)
2. acha o `.onnx` em `livekit_run/output/…`
3. chama `reembed_onnx.py` →
   - `resources/wake/ei-jarvis-ptbr.onnx`
   - `src/main/voice/wake-models-ptbr.ts` (base64 global)
   - opcional `~/.nexus/models/wake/custom.onnx`

Depois: **reinicie o app** e faça commit dos dois artefatos no release.

---

## Caminho B — treino local rápido (macOS `say`)

```bash
cd training/ei-jarvis
python3 -m venv .venv
.venv/bin/pip install torch edge-tts openwakeword==0.6.0 onnxruntime==1.19.2 \
  audiomentations numpy scipy huggingface_hub onnx
.venv/bin/python train_local.py --tts macos --steps 6000 --positives 400
```

O script:

1. Gera ~400 positivos com `say` (vozes PT-BR do macOS: Luciana, Eddy, …)
2. Augmenta (ruído, pitch, gain) → ~1200 clips
3. Extrai embeddings openWakeWord (mel→emb oficiais)
4. Gera negativos locais (falas PT sem “Jarvis” + ruído/silêncio)
5. Treina a cabeça 16×96 → score e exporta `work/ei_jarvis.onnx`
6. Instala em `~/.nexus/models/wake/custom.onnx`

Reinicie o NexusIDE. No log main deve aparecer:

```
[wake] modelo PT-BR adicional carregado: …/custom.onnx
```

Nos scores: `"source":"custom"` com threshold 0.65.

### Re-treino a partir do cache

```bash
.venv/bin/python train_local.py --skip-generate --steps 8000
```

### Fallback Colab

Se preferir GPU cloud: abra `treino-colab.ipynb` (edge-tts; pode falhar com 403).
Depois:

```bash
mkdir -p ~/.nexus/models/wake
cp ~/Downloads/ei_jarvis.onnx ~/.nexus/models/wake/custom.onnx
```

## Notas de engenharia

- **Dados sintéticos** (`say`/TTS) separam bem no treino, mas a voz real do
  microfone pode pontuar mais baixo. Se `source=custom` ficar sempre &lt; 0.65
  na sua voz, grave 20–50 “Ei Jarvis” reais, misture em `work/positives/` e
  re-treine.
- O pipeline mel/embedding é o oficial openWakeWord; só a **cabeça** muda.
- Falsos positivos: aumente `CUSTOM_WAKE_SCORE_THRESHOLD` em
  `src/main/voice/wake-score-gate.ts` (default 0.65).
- Para remover o custom: `rm ~/.nexus/models/wake/custom.onnx` e reinicie.

## Distribuição global (multi-PC / Windows / Linux / macOS)

O treino **não** fica só neste Mac. O artefato é shipado no binário NexusIDE:

| Camada | Path | Quem recebe |
|---|---|---|
| **Embutido (default)** | `src/main/voice/wake-models-ptbr.ts` (base64) | **Todo install** do app (mac/win/linux) |
| Recurso empacotado | `resources/wake/ei-jarvis-ptbr.onnx` via Forge `extraResource` | Builds empacotados |
| Override local | `~/.nexus/models/wake/custom.onnx` | Só se você re-treinar e copiar |

Loader (`wake-engine.ts`): override local → senão embutido PT-BR → + head EN em paralelo.

Isso é o mesmo padrão do head EN (`wake-models.ts`): **vai no app**, não depende de
cada usuário treinar. Windows/Linux usam o mesmo ONNX (`onnxruntime-node`).

Após re-treinar para um release (se não usou `train_livekit.sh`):

```bash
python3 reembed_onnx.py path/to/model.onnx --also-user-override
```

## Status da última build de treino

| Item | Valor |
|---|---|
| Artefato embutido | `src/main/voice/wake-models-ptbr.ts` + `resources/wake/ei-jarvis-ptbr.onnx` (~771 KB) |
| Override local | `~/.nexus/models/wake/custom.onnx` (cópia do treino) |
| Positivos | 3414 janelas (16×96) de TTS PT macOS |
| Negativos | ~189 janelas (fala PT + ruído local) |
| Contrato | input `x.1` float32 `[1,16,96]` → score |
| Header | protobuf `0x08` (aceito pelo loader do app) |
| Escopo | **Global** no app (todo PC/OS no release) |
