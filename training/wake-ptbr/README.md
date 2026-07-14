# Candidato de wake word PT-BR

Este diretório produz um **candidato ONNX isolado** para as chamadas:

- `Hey Jarvis`
- `Ei Jarvis`
- `E aí Jarvis`

Ele não modifica o Nexus, não reinicia o app e se recusa a escrever no
diretório ativo `~/.nexus/models/wake/`. O workspace também não pode ficar em
`~/.nexus`. O objetivo é gerar um artefato que passe por avaliação antes de
qualquer integração no runtime.

## O que o script faz

`train_ptbr_wake.py` usa a mesma interface de cabeça do detector do Nexus:

```text
float32 [1, 16, 96] -> float32 score [1, 1]
```

O script consulta vozes `pt-BR` disponíveis no Edge TTS, gera frases em
velocidades e tons distintos, converte tudo para WAV mono de 16 kHz e cria
variações determinísticas de ganho, ruído e reverberação. Depois ele extrai
embeddings com openWakeWord em modo ONNX, treina uma pequena cabeça PyTorch e
exporta uma candidata ONNX.

Por padrão, o script pede até 600 fontes TTS e cinco variações para cada uma
(até 3.000 clips aumentados). Se a versão do Edge TTS disponibilizar menos
combinações únicas de vozes pt-BR, ele usa todas as combinações disponíveis e
avisa no console; um valor explícito de `--source-clips` acima do disponível
falha antes do treino. Isso é uma candidata sintética inicial — não é
validação de produção nem substitui gravações do usuário no Fifine.

## Pré-requisitos

- macOS ARM e CPython 3.11;
- `ffmpeg` no `PATH`;
- rede para Edge TTS e Hugging Face;
- aproximadamente 2 GB para os negative features públicos do openWakeWord,
  além do workspace de treino.

Não instale essas dependências dentro do Node/Electron do Nexus. Crie um
ambiente Python separado:

```bash
cd /Users/cleofasrocha/dev/nexus-ide
uv venv .venv-wake --python 3.11
source .venv-wake/bin/activate
uv pip install -r training/wake-ptbr/requirements.txt
```

`--device auto` prefere CUDA, depois MPS (Apple Silicon), e por fim CPU.
Se MPS apresentar alguma incompatibilidade de pacote, use `--device cpu`.

## Executar

Escolha um workspace vazio. O script não reaproveita nem apaga um workspace
com conteúdo para não misturar corridas diferentes.

```bash
python training/wake-ptbr/train_ptbr_wake.py \
  --workspace /tmp/nexus-wake-ptbr-20260710 \
  --output training/wake-ptbr/artifacts/hey_jarvis_ptbr_candidate.onnx \
  --seed 20260710
```

Para um ciclo menor de diagnóstico:

```bash
python training/wake-ptbr/train_ptbr_wake.py \
  --workspace /tmp/nexus-wake-ptbr-smoke \
  --output /tmp/hey_jarvis_ptbr_smoke.onnx \
  --source-clips 80 \
  --augmentations-per-source 2 \
  --steps 200 \
  --batch-size 64
```

O ciclo completo depende principalmente do download público e do Edge TTS.
Em uma boa conexão, espere dezenas de minutos; o ciclo curto existe apenas
para verificar ambiente e formato, não qualidade do detector.

## Saídas e validação

Para cada candidata `foo.onnx`, o script grava ao lado:

```text
foo.onnx
foo.metrics.json
foo.manifest.json
```

O script valida o arquivo com `onnx.checker`, abre-o no ONNX Runtime CPU,
executa uma entrada `[1, 16, 96]` e compara o score com PyTorch. O holdout é
separado por fonte TTS, para que aumentos da mesma voz/frase não apareçam nos
dois lados. O relatório inclui FAR/FRR em vários limiares, inclusive `0.65`,
que é o corte atual da cabeça PT-BR no runtime. Também registra hashes, seed,
frases, vozes e versões no manifest/relatório.

As métricas de holdout são apenas uma triagem do corpus sintético. Antes de
qualquer uso real, compare o FAR/FRR em `0.65` com áudio separado do usuário:
chamadas rápidas, normais e baixas, em distâncias diferentes, além de
fala/ruído sem a palavra-chave. O runtime atual mantém o modelo base inglês e
carrega o `custom.onnx` como cabeça adicional em ensemble paralelo, com
limiares independentes. Ainda assim, não promova a candidata sem essa
avaliação humana e teste vivo.

## Reprodutibilidade e limites

- `--seed` fixa a escolha de frases/vozes e cada aumento de áudio.
- `workspace/sources.json` preserva o manifesto de fontes TTS.
- `--negative-features /caminho/arquivo.npy` permite reutilizar um download
  público já existente.
- `--source-clips`, `--augmentations-per-source`, `--steps`, `--batch-size`,
  `--max-voices` e `--device` tornam o experimento explícito.
- O script não grava microfone nem coleta áudio em segundo plano. Um futuro
  coletor opt-in deve salvar áudio cru e pós-AGC separadamente para comparar
  clipping/ganho com o pipeline de wake real.

## Verificação do código

Sem instalar as dependências de ML, ainda é possível validar a estrutura e as
funções puras:

```bash
python3 -m unittest training/wake-ptbr/test_train_ptbr_wake.py
python3 -m py_compile training/wake-ptbr/train_ptbr_wake.py
```
