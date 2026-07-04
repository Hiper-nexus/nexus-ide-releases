# Treinar o wake word "Ei Jarvis" (PT-BR)

O modelo embutido (`hey_jarvis`, openWakeWord) é treinado com inglês nativo —
sotaque brasileiro pontua baixo. Este diretório treina um modelo **custom em
português** com dados 100% sintéticos (TTS), sem gravar sua voz.

## Como rodar (Colab, ~40 min, grátis)

1. Abra o notebook [`treino-colab.ipynb`](treino-colab.ipynb) no
   [Google Colab](https://colab.research.google.com) (Runtime → GPU T4).
2. Runtime → **Run all**. O notebook:
   - gera ~400 variações de **"ei jarvis"** com vozes neurais PT-BR
     (edge-tts: Antonio, Francisca, Thalita…) em velocidades/tons variados;
   - aplica augmentação (ruído, reverb) via `openwakeword[train]`;
   - baixa os *negative features* pré-computados oficiais;
   - treina a cabeça classificadora e **exporta `ei_jarvis.onnx`**.
3. Baixe o `ei_jarvis.onnx` gerado e instale no app:

```bash
mkdir -p ~/.nexus/models/wake
cp ~/Downloads/ei_jarvis.onnx ~/.nexus/models/wake/custom.onnx
```

4. Reinicie o NexusIDE (ou desligue/ligue o wake word nas configurações de
   voz). O log deve mostrar `[wake] modelo CUSTOM carregado`.

Pronto: **"Ei Jarvis"** falado naturalmente em português acorda a assistente.
Para voltar ao modelo embutido, apague o arquivo `custom.onnx`.

## Notas

- O app usa o mesmo pipeline do openWakeWord (mel → embedding → cabeça), então
  qualquer modelo treinado pelo pipeline oficial funciona — só o arquivo da
  cabeça muda; mel/embedding continuam os embutidos.
- Falsos positivos? Aumente `THRESHOLD` em `src/main/voice/wake-engine.ts`
  (0.35 padrão) ou re-treine com mais passos de augmentação.
- O notebook fixa `openwakeword==0.6.0` e `onnxruntime==1.19.2` (a 1.27 tem
  regressão de determinismo no modelo de embedding — ver wake-engine.ts).
