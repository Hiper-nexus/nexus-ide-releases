# Senior Code Review - Fase 3 Jarvis Realtime OpenAI

## Sumario executivo

Verdict: **REQUEST_CHANGES**

BLOCKERs: 3
HIGHs: 4
MEDIUMs: 3
LOWs: 1

Overall risk: **alto**

Esta branch nao esta pronta para release v1.0.0. Os dois maiores problemas sao regressao direta de P0 contra `main` e a promessa funcional do modo realtime: com `REALTIME_ACTION_BRIDGE_ENABLED=true`, o caminho realtime nao executa acoes do Nexus, apenas conversa por audio.

## Escopo revisado

- Branch diff `main..HEAD`, incluindo `git log --stat`, `git diff --name-status`, diff TypeScript/TSX e diffs minimos de zona quente.
- Arquivos criticos lidos completos ou por secoes relevantes: `src/main/jarvis/realtime/openai-realtime.ts`, `src/main/jarvis/realtime/gemini-live-provider.ts`, `src/main/voice/live-transport-controller.ts`, `src/main/jarvis/transcript-store.ts`, `src/main/jarvis/realtime/metrics.ts`, `src/main/voice/jarvis-brain.ts`, `src/main/jarvis/realtime/factory.ts`, `src/main/voice/gemini-live-transport.ts`, `src/main/voice/voice-ipc.ts`, `src/renderer/voice/voice-controller.ts`, `src/renderer/components/VoiceSettings.tsx`.
- Testes revisados: realtime provider, controller fallback, transcript store, metrics, Gemini Live transport e Jarvis brain.
- Documentacao oficial consultada para OpenAI Realtime WebSocket, conversations, VAD e tools.

## P0 invariants

- Zona quente nao tocada: **FAIL**. `src/renderer/voice/wake-mic.ts` foi modificado.
- Novo/getUserMedia raw PCM: **FAIL**. O wake mic voltou para `echoCancellation:true`, `noiseSuppression:true` e omitiu `autoGainControl:false`.
- Prompts LLM em EN: **PASS** para `jarvis-brain.ts` e `system.en.md`.
- Transcript JSONL persistido em disco: **PARTIAL**. Existe persistencia JSONL, mas sem limite, rotacao ou consolidacao de deltas.
- `REALTIME_ACTION_BRIDGE_ENABLED=true`: **PARTIAL/FAIL funcional**. A flag esta true, mas o caminho realtime nao chama o executor de acoes nem configura tools no provider.
- Sem push/merge/main/version bump: **FAIL** em versionamento. A branch regride `0.10.6` para `0.10.5`/`0.10.0` contra `main`.

## [BLOCKER] Wake mic hot zone foi modificada e as constraints raw PCM regrediram

**Arquivo:** `src/renderer/voice/wake-mic.ts:214`

**Problema:** A branch toca a zona quente `wake-mic.ts` e reverte a captura do wake word para `echoCancellation: true` e `noiseSuppression: true`, removendo tambem `autoGainControl: false`. O diff tambem remove a instrumentacao de device/settings e RMS do primeiro frame.

**Impacto:** Reabre a causa raiz da "Jarvis surda": o Chromium pode aplicar APM/AGC no stream usado pelo openWakeWord, achatando ou alterando as features do PCM. Isso quebra wake word em microfones USB sensiveis e viola explicitamente o P0 de zona quente.

**Fix sugerido:** Restaurar exatamente as constraints raw no wake mic: `echoCancellation:false`, `noiseSuppression:false`, `autoGainControl:false`; restaurar a instrumentacao removida; adicionar um teste/snapshot de constraints para impedir regressao.

## [BLOCKER] Branch regride versao e release notes de `main`

**Arquivo:** `package.json:4`

**Problema:** O diff `main..HEAD` altera `package.json` e `package-lock.json` de `0.10.6` para `0.10.5`, e `src/shared/release-notes.ts:16` volta de `0.10.6` para `0.10.0`. `CHANGELOG.md` tambem perde a entrada `0.10.6`.

**Impacto:** Release montado desta branch sobrescreve metadata e notas da hotfix de wake mic. Isso tambem mascara a regressao do proprio wake mic e viola o P0 de nao mexer em versionamento/release.

**Fix sugerido:** Rebase/merge localmente contra o `main` correto preservando `0.10.6` e as notas da hotfix, ou remover integralmente essas alteracoes de metadata da Fase 3 antes do release.

## [BLOCKER] Modo realtime nao executa acoes do Nexus

**Arquivo:** `src/renderer/voice/voice-controller.ts:593`

**Problema:** Quando `realtimeTurnActive && isRealtimeLive()`, `finishAndProcess` apenas fecha o turno com `liveEndTurn()`, seta status `idle` e retorna. Esse caminho pula `runJarvisTurn`, portanto pula o Jarvis brain, o switch de acoes e `liveToolResult`. No provider OpenAI, `src/main/jarvis/realtime/openai-realtime.ts:52` cria a sessao sem `tools` e nao parseia eventos de function call. O proprio prompt `src/main/jarvis/prompts/system.en.md:11` diz que tools so serao populadas na Fase 4.

**Impacto:** Com a flag P0 ligada, comandos como "abre um terminal", "roda npm test" ou "pede para o agente corrigir X" podem gerar resposta falada do modelo, mas nao executam nada no Nexus. Isso e pior que fallback batch porque a UI aparenta estar em realtime action-capable.

**Fix sugerido:** Antes de release, escolher um caminho: implementar tools reais no Realtime (`session.tools`, parsing de function calls, execucao pelo mesmo guardrail/confirmacao do app, envio de `function_call_output`) ou manter a rota action-capable batch/classic para comandos ate a Fase 4. Nao shippar `REALTIME_ACTION_BRIDGE_ENABLED=true` sem ponte de acao.

## [HIGH] OpenAI server VAD pode criar resposta automaticamente enquanto o app tambem faz commit manual

**Arquivo:** `src/main/jarvis/realtime/openai-realtime.ts:74`

**Problema:** A sessao configura `turn_detection: { type: 'server_vad' }`, mas `endUserTurn()` em `src/main/jarvis/realtime/openai-realtime.ts:316` sempre envia `input_audio_buffer.commit` seguido de `response.create`. Pelas docs oficiais de Realtime VAD/conversations, se o cliente quer decidir manualmente quando criar a resposta, deve desabilitar resposta automatica (`create_response:false`, e usualmente `interrupt_response:false`) ou desabilitar VAD.

**Impacto:** Corrida de producao: o servidor pode detectar fim de fala e criar a resposta antes do keyup/PTT soltar. Depois o app envia commit/response manual sobre buffer ja consumido ou resposta ja criada, gerando erro, duplicidade de audio, turnos sobrepostos ou cancelamentos espurios.

**Fix sugerido:** Definir uma politica unica de turno. Para PTT/manual, usar `turn_detection:null` e manter `commit`/`response.create`; ou manter VAD apenas para eventos de speech e setar `create_response:false` antes de criar manualmente a resposta. Cobrir com teste simulando `speech_stopped`/auto-response antes de `endUserTurn`.

## [HIGH] Queda do WebSocket OpenAI apos setup deixa o live state mentindo

**Arquivo:** `src/main/jarvis/realtime/openai-realtime.ts:259`

**Problema:** O handler `close` apenas seta `ready=false` e chama `settle(...)`. Depois que `connect()` ja resolveu, isso nao notifica `LiveTransportController`, nao emite erro, nao tenta reconnect e nao aciona fallback para Gemini/Classic.

**Impacto:** Em uma queda real de rede ou idle close, `liveState.realtimeReady` pode permanecer true no renderer enquanto `provider.isReady` fica false. Os frames seguintes entram no buffer pendente ate o limite ou sao descartados silenciosamente; o usuario ve Jarvis "ativa" mas sem resposta.

**Fix sugerido:** Expor evento `onClose`/`onDisconnected` no provider, o controller deve marcar `realtimeReady:false`, limpar buffers, tentar reconnect com backoff e/ou trocar para o proximo provider. Adicionar teste de close depois de `session.updated`.

## [HIGH] Transcript JSONL nao tem limite, rotacao nem consolidacao de deltas

**Arquivo:** `src/main/jarvis/transcript-store.ts:50`

**Problema:** Cada callback de transcript e appendado diretamente em um arquivo por session id. Nao ha limite de tamanho, retencao, rotacao, truncamento de texto, nem consolidacao de deltas parciais em uma linha final. A `sessionFiles` map tambem cresce sem poda durante o processo.

**Impacto:** Sessao longa ou ruido de transcript parcial pode gerar crescimento indefinido em `Application Support`, misturar deltas duplicados com finais e dificultar recuperacao/auditoria. Como transcript contem fala do usuario, isso tambem aumenta superficie de privacidade.

**Fix sugerido:** Implementar politica de storage antes de release: tamanho maximo por arquivo/sessao, rotacao por data/tamanho, limite por linha, retencao configuravel e escrita preferencial de finais consolidados. Testar limite/rotacao e corrupcao de JSONL.

## [HIGH] Timer de reconnect do Gemini pode derrubar uma sessao nova

**Arquivo:** `src/main/voice/gemini-live-transport.ts:235`

**Problema:** Em close inesperado, o transporte agenda um reconnect com `setTimeout`, mas nao guarda o timer para cancelar em `teardown()` ou em um `connect()` manual posterior. Se o usuario reconectar antes do timer antigo disparar, `connect()` seta `closedByUs=false`; o timer velho pode disparar e chamar `connect(this.lastOptions)`, fechando a sessao nova.

**Impacto:** Race intermitente no fallback Gemini: sockets novos podem ser derrubados por timers antigos, gerando duas tentativas de setup, perda de audio e estado oscilando entre ready/closed.

**Fix sugerido:** Guardar `reconnectTimer`, cancelar em `teardown()` e antes de qualquer novo `connect()`. Usar um generation/session token no callback para ignorar timers obsoletos. Cobrir com teste de reconnect pendente + novo connect manual.

## [MEDIUM] Audio pendente do OpenAI e resampleado duas vezes

**Arquivo:** `src/main/jarvis/realtime/openai-realtime.ts:274`

**Problema:** `sendAudioChunk` resampleia de 16 kHz para 24 kHz antes de colocar o chunk em `pendingAudio`. Depois `flushPendingAudio()` chama `sendAudioChunk(chunk)` novamente em `src/main/jarvis/realtime/openai-realtime.ts:376`, tratando o chunk ja resampleado como se ainda fosse 16 kHz.

**Impacto:** Qualquer audio capturado antes de `session.updated` fica alongado/distorcido. Hoje o renderer tenta esperar `liveStart`, mas o buffer existe justamente para cobrir corrida de setup; quando ele for usado, o primeiro turno pode ficar inaudivel para o modelo.

**Fix sugerido:** Armazenar chunks no sample rate original e resamplear somente no envio, ou armazenar eventos ja preparados e flushar direto sem chamar `sendAudioChunk` de novo. Testar tamanho/duracao do base64 flushado.

## [MEDIUM] Metricas usam relogio de parede e nao modelam turnos independentes

**Arquivo:** `src/main/jarvis/realtime/metrics.ts:68`

**Problema:** O tracker usa `Date.now` por default e chaveia por `sessionId`. Mudancas de relogio do SO podem produzir latencias negativas que sao mascaradas para `0` em `JarvisMetricsLogger.log`. Interrupcoes/erros sem `response.done` deixam o turno no `Map` ate ser sobrescrito ou contaminarem o proximo evento da mesma sessao.

**Impacto:** Telemetria de release pode parecer melhor que a realidade, perder outliers e misturar turnos numa sessao live longa. Isso reduz utilidade das metricas para SLO de latencia.

**Fix sugerido:** Usar clock monotonic (`performance.now`/`process.hrtime.bigint`) para duracoes, criar um `turnId` por fala, e limpar/fechar metricas em erro, interrupt e stop.

## [MEDIUM] Testes realtime nao cobrem os modos de falha que bloqueiam release

**Arquivo:** `src/main/jarvis/realtime/openai-realtime.test.ts:109`

**Problema:** Os testes usam `fakeWs.readyState = 1` constante, nao simulam close depois de setup, VAD auto-response antes do commit manual, backpressure real, reconnect Gemini obsoleto, rotacao de transcript ou a execucao de acoes em realtime. O teste de pending audio so verifica que existe string base64, nao que duracao/sample rate foram preservados.

**Impacto:** A suite passa mesmo com bugs de ciclo de vida, race de VAD e ausencia de action bridge. Para release v1.0.0, os mocks nao representam os casos que quebram em rede real.

**Fix sugerido:** Adicionar testes de contrato por provider e controller: close post-ready, erro post-ready, fallback apos erro runtime, speech_stopped/auto-response, pending audio length, reconnect timer stale, transcript rotation e comando de voz realtime executando uma acao observavel.

## [LOW] Smoke test realtime da UI sugere apenas OPENAI_API_KEY mesmo com fallback Gemini

**Arquivo:** `src/renderer/components/VoiceSettings.tsx:349`

**Problema:** Quando `liveSmokeTest` retorna sem `realtimeReady`, a mensagem diz "verifique OPENAI_API_KEY". Mas a factory pode tentar OpenAI e Gemini, e tambem pode falhar por modelo, rede, permissao, close ou `GEMINI_API_KEY` ausente.

**Impacto:** Diagnostico ruim para usuario e suporte, especialmente quando a intencao declarada da Fase 3 e fallback OpenAI -> Gemini.

**Fix sugerido:** Retornar do main o provider tentado e erro sanitizado, e renderizar mensagem especifica sem vazar chaves.
