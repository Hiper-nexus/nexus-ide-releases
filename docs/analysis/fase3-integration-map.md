# Fase 3 - Jarvis Realtime integration map

Data: 2026-07-07
Branch: `nexus-jarvis-fase3-realtime` a partir de `origin/main`

## Regra de concorrencia

Antes de qualquer escrita foi executado:

```text
git fetch --all && git log --oneline -20 && git status --short
```

Estado observado:

- `origin/main`: `7927f10 chore(release): bump version to 0.10.5`
- branch anterior local: `docs/crashes-triage` em `1df0c5f`
- working tree preexistente: `docs/analysis/nexus-vs-voice-benchmark-bridge.md` modificado; nao faz parte desta task e nao sera stageado
- zona quente declarada pelo usuario: somente leitura; nenhum plano edita `wake-mic`, `wake-rearm`, `wake-health`, `pcm-processor` ou `voice-log*`

## UI existente: `Jarvis > Voice Control`

Arquivo principal: `src/renderer/components/VoiceSettings.tsx`.

O painel ja contem:

- cards de status `STT`, `TTS`, `BRAIN`, `MODE`
- seletores para STT, TTS e Jarvis brain
- credenciais por env var via `window.nexus.voice.setKey`
- toggles `Wake word`, `Jarvis Live` e `Audio realtime`
- botoes `Testar voz` e `Testar JARVIS`

Hoje o toggle `Audio realtime` fica desabilitado quando `Jarvis Live` esta ligado. O texto explica que o Live atual usa o loop Classic porque realtime ainda nao dirige ferramentas com seguranca. A Fase 3 deve reaproveitar esse bloco e trocar o status/controle para OpenAI realtime, sem redesign do painel.

## Renderer voice controller

Arquivo: `src/renderer/voice/voice-controller.ts`.

Pontos relevantes:

- `REALTIME_ACTION_BRIDGE_ENABLED = false` impede a rota realtime.
- `beginListening()` chama `window.nexus.voice.liveStart()` quando Jarvis Live esta ativo.
- `realtimeTurnActive = REALTIME_ACTION_BRIDGE_ENABLED && isRealtimeLive()`.
- `wakeMic.setUtteranceFrameTap()` ja envia frames PCM base64 para `window.nexus.voice.liveMicIn(...)` quando `realtimeTurnActive` esta ativo.
- `finishAndProcess()` ja tem a bifurcacao realtime: se ativo, fecha a utterance local, chama `liveEndTurn()` e nao roda STT/brain/TTS batch.
- Barge-in ja chama `stopAllPlayback()` no wake/toggle; o handler `onLiveInterrupted` para o `LiveAudioPlayer`.

Conclusao: a integracao deve tornar `isRealtimeLive()` verdadeiro para OpenAI quando o socket estiver pronto e trocar a flag hardcoded por uma feature flag/configuracao. Nao precisa tocar no AudioWorklet nem no wake mic.

## Main-process live transport

Arquivos:

- `src/main/voice/live-transport-controller.ts`
- `src/main/voice/gemini-live-transport.ts`
- `src/main/voice/jarvis-live.ts`

O controller atual:

- decide se realtime esta configurado
- resolve key via `resolveVoiceApiKey`
- conecta o transporte Gemini
- roteia audio out para `VOICE_CHANNELS.liveAudioOut`
- roteia transcript para `JarvisLiveSession.transcript(...)`
- roteia interruption para `JarvisLiveSession.interrupt('barge-in')`

A FSM `JarvisLiveSession` ja tem session id, state broadcast, transcript events, tool call/result e interrupt events. Ela e o lugar natural para manter a identidade da sessao e emitir live transcript para o renderer.

Conclusao: criar uma interface de provider e fazer o controller depender dela. `GeminiLiveProvider` pode ser stub/fallback para Fase 3.5, mantendo compatibilidade com o transporte Gemini existente quando necessario.

## Configuracao e secrets

Arquivos:

- `src/shared/voice-config.ts`
- `src/main/voice/voice-config-store.ts`
- `src/main/voice/voice-secrets.ts`
- `src/main/persistence/secrets-store.ts`

Persistencia:

- config de voz: `~/.nexus/plugins/voice/nexus-voice.json`
- secrets de voz: `voice-env:${ENV_VAR}` via `secrets-store`
- lookup de key: primeiro secure storage, depois `process.env`

O renderer recebe apenas `VoiceRuntimeInfo`, sem secrets. A lista de keys vem de `collectVoiceEnvVars(current.stt, current.tts, current.jarvisBrain)`.

Ponto de bloqueio atual: `stableJarvisLiveTransport()` forca `gemini-live` de volta para `classic`; isso foi correto para a mitigacao anterior, mas precisa virar uma politica por provider para permitir `openai-realtime`.

## IPC e preload

Arquivos:

- `src/shared/voice-channels.ts`
- `src/shared/voice-ipc.ts`
- `src/shared/types.ts`
- `src/preload/preload.ts`

Ja existem canais para:

- `voice:live.start`, `voice:live.stop`, `voice:live.endTurn`
- `voice:live.mic.in`
- `voice:live.audio.out`
- `voice:live.transcript`
- `voice:live.interrupted`

Para transcript persistente live no painel, a task pede canal novo `jarvis:transcript-append`. Como ja existe `voice:live.transcript`, a opcao de menor atrito e emitir ambos: manter o canal existente para HUD/live e adicionar o canal pedido para compatibilidade da Fase 3.

## OpenAI Realtime API atual

Fonte oficial consultada:

- `https://developers.openai.com/api/docs/guides/realtime`
- `https://developers.openai.com/api/docs/guides/realtime-websocket`
- `https://developers.openai.com/api/docs/guides/realtime-conversations`

Achados relevantes em 2026-07-07:

- WebSocket server-to-server: `wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1`
- auth no main: header `Authorization: Bearer ${OPENAI_API_KEY}`
- GA session shape usa `session.type = "realtime"`, `output_modalities`, `audio.input`, `audio.output`
- audio WebSocket exige eventos JSON com audio base64 no input buffer
- eventos atuais de output audio/transcript usam nomes `response.output_audio.delta` e `response.output_audio_transcript.delta`
- docs tambem citam `input_audio_buffer.speech_started` e `input_audio_buffer.speech_stopped` para VAD/interruption
- beta antigo usava nomes como `response.audio.delta`; a implementacao pode aceitar ambos para robustez, mas deve emitir GA por default

## Plano de integracao

1. Criar `src/main/jarvis/realtime/provider.ts` com a interface pedida e helpers de base64/PCM.
2. Criar `src/main/jarvis/realtime/openai-realtime.ts` com WebSocket injetavel/testavel.
3. Criar stub `GeminiLiveProvider` para Fase 3.5 ou adaptador fino sobre o transporte existente.
4. Criar factory que prioriza `NEXUS_REALTIME_PROVIDER`, depois config do painel (`jarvisLive.transport`), com OpenAI como default aprovado.
5. Criar `src/main/jarvis/transcript-store.ts` para JSONL em `~/Library/Application Support/NexusIDE/transcripts`.
6. Criar metric logger JSONL em `~/Library/Logs/NexusIDE/jarvis-metrics.log`.
7. Ajustar config shared para incluir `openai-realtime` como transporte live e preservar `classic`.
8. Ajustar `LiveTransportController` para usar provider abstraction e emitir transcript persistente + metricas.
9. Ajustar renderer para:
   - habilitar audio realtime quando provider for OpenAI
   - mostrar `Realtime ativo` quando `liveState.realtimeReady === true`
   - fazer `Testar JARVIS` passar por `liveStart` quando realtime estiver ativo
10. Adicionar testes unitarios para provider parsing, transcript JSONL, metric logger e config.

## Riscos

- A aceitacao menciona `gpt-4o-realtime-preview` e eventos beta. A documentacao atual recomenda `gpt-realtime-2.1` e eventos GA. Decisao: usar GA por default e aceitar aliases/eventos beta no parser.
- Meta `<500ms` depende de rede/modelo/audio device; o codigo pode medir, mas nao garantir no CI.
- E2E manual com voz depende de permissao de mic e app Electron rodando; automatizar totalmente ficaria fora do escopo sem Browser/Computer Use no app.
