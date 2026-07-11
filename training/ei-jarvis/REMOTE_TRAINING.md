# Treinamento remoto PT-BR

O Mac coleta e valida áudio; a GPU remota gera o head ONNX. Nunca promova um
modelo apenas porque a loss caiu: o gate local rejeita silêncio com score alto.

## 1. Coletar áudio real no Mac

Use Python 3.11+ e instale `numpy sounddevice` no ambiente de treinamento.

```bash
cd training/ei-jarvis
python record_dataset.py --kind positive --count 50
python record_dataset.py --kind negative --count 100
```

Inclua também 30–60 minutos de ambiente real sem a palavra Jarvis: TV, música,
reunião, teclado e a voz sintetizada da própria assistente.

## 2. Treinar em GPU

No Colab/RunPod (Python 3.11, GPU NVIDIA):

```bash
git clone <repo-do-nexus>
cd nexus-ide/training/ei-jarvis
pip install 'livekit-wakeword[train,eval,export,voxcpm]'
./train_livekit.sh --config configs/ei_jarvis_pt.yaml --no-user-override
```

Faça upload de `recordings/` para `livekit_run/data/` conforme o importador da
versão instalada do LiveKit WakeWord. Os dados reais devem participar do treino
e da validação, mas nenhuma gravação da mesma sessão pode aparecer nos dois.

## 3. Gate de promoção

O candidato precisa cumprir todos os itens:

- contrato ONNX `[1,16,96] -> score`;
- probe de silêncio abaixo de `0.45` (loader do Nexus);
- FAR medido em horas de negativos reais;
- FRR separado por volume, distância e frase;
- nenhum disparo na própria voz da Jarvis;
- meta inicial: FAR < 1/h e FRR < 10%;
- meta de release: FAR < 1/10 h e FRR < 5%.

Só depois:

```bash
python validate_candidate.py /caminho/ei_jarvis_pt.onnx \
  --positive work/pos_windows.npy --negative work/neg_windows.npy
python reembed_onnx.py /caminho/ei_jarvis_pt.onnx --also-user-override
npm run typecheck
npm test
```

O validador retorna código diferente de zero se o candidato falhar. A taxa por
janela é apenas um preflight; o gate de release continua exigindo horas de áudio
contínuo sem a palavra de ativação.

Reinicie o dev e confirme no log `modelo PT-BR ... carregado`, nunca
`overfit FP no silêncio`.
