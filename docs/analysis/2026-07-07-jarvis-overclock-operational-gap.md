# Jarvis Nexus vs Overclock - gap operacional

Data: 2026-07-07  
Escopo: inspeção local do Overclock instalado, comparação com Nexus IDE `main`
e implementação de hotfix operacional no pipeline Classic da Jarvis.

## Sumario executivo

O Overclock opera a Jarvis como uma sessão live full-duplex com ferramentas
declaradas no modelo. O Nexus ja tem wake word, STT, brain, TTS e acoes, mas a
rota confiavel em producao ainda e Classic: grava fala, transcreve em batch,
chama o brain e executa uma action local.

O gap mais importante encontrado nesta rodada nao foi "falta de LLM". Foi perda
de contexto no instante do wake:

- O usuario pode dizer "Hey Jarvis, abre terminal" em uma fala so.
- O Nexus começava a capturar somente depois do wake, entao parte do comando
  podia ficar fora do WAV enviado ao STT.
- A saudacao "Pois nao, patrao?" podia vazar pelo alto-falante/mic e virar
  transcript de entrada.
- Com isso a Jarvis parecia acordar, mas ficava inconsistente, lenta ou
  falava sozinha.

O hotfix implementado segue o padrao observado no Overclock: manter um buffer
curto de audio antes do wake, semear o utterance com esse pre-roll, e limpar
prefixos de wake/ack antes de mandar o texto ao fast-path/brain.

## Overclock observado localmente

Artefatos inspecionados:

- `/Applications/Overclock.app`
- `/Applications/Overclock.app/Contents/Resources/sidecar`
- `dist/GeminiLiveSession.js`
- `dist/JarvisService.js`
- `dist/core.js`
- `sidecar/package.json`
- `Info.plist`

Conclusoes de arquitetura:

1. O Overclock nao e Electron tradicional; ele aparenta ser nativo/Tauri-like
   com sidecar Node.
2. A Jarvis usa Gemini Live como canal principal de conversa.
3. O modelo recebe `functionDeclarations`, incluindo funcoes como `delegar`,
   `consultar`, `ler`, `navegar`, `encerrar`, `comandar`, `restaurar` e
   `perguntar`.
4. O microfone pode mandar chunks antes da sessao estar pronta; esses chunks
   ficam em `pendingMic` por uma janela curta, evitando perder fala inicial.
5. Ha supressao de eco por similaridade textual contra fala recente do
   assistente, via normalizacao e janela de spoken text.
6. A voz do Gemini e pinada em configuracao de sessao, com temperatura baixa,
   reduzindo variacao de prosodia.
7. O app declara permissoes de microfone e captura de audio no `Info.plist`,
   o que indica desenho mais cuidadoso para referencia de output/eco.

O ponto que mais explica a diferença de sensacao e que Overclock trata a voz
como sessao continua com tools; o Nexus, no modo Classic atual do usuario, trata
cada turno como uma captura batch curta.

## Nexus antes do hotfix

Estado local relevante:

- `jarvisLive.transport = "classic"` no config do usuario.
- `REALTIME_ACTION_BRIDGE_ENABLED` agora esta ativo no renderer como ponte
  hibrida: o realtime acelera audio/transcript, mas a execucao de actions volta
  ao executor Classic/MCP auditavel.
- STT: Groq Whisper batch.
- TTS: OpenAI `gpt-4o-mini-tts` voz `nova`.
- Wake: openWakeWord local, threshold baixo para sensibilidade.
- Fast-path ja cobre `open_terminal`, mas dependia do transcript limpo chegar.

Principais gaps:

| Area | Overclock | Nexus antes | Risco |
|---|---|---|---|
| Fala colada ao wake | buffer pendente/pre-roll | captura comecava pos-wake | perder comando |
| Ack/eco | filtro por spoken similarity | TTS echo existe, mas wake ack podia entrar | auto-conversa |
| Tools live | function declarations | bridge transcript -> Classic/MCP | ainda sem tool-calling nativo |
| Persona | voz/nome pinados | persona existe, mas fast-path seco | nem sempre chama "patrao" |
| Latencia | live streaming | STT batch + brain + TTS | turnos de segundos |

## Mudancas implementadas

1. `WakeMic` ganhou rolling pre-roll de ate 3s.
2. Quando o wake abre uma utterance, o controller semeia a captura com 2,5s
   recentes.
3. `stripWakeAckEcho()` remove prefixos como `Hey Jarvis`, `Jarvis`,
   `Pois nao, patrao`, `Sim, patrao`, `Diga, patrao` e `Estou ouvindo`.
4. Ack puro vazado pelo alto-falante vira transcript vazio e e descartado.
5. O `userName` configurado entra no contexto do brain e nos fast-paths.
6. Respostas diretas como `abrir terminal` e `que horas sao` agora tendem a
   sair com tratamento curto: `..., patrao.`

Arquivos principais:

- `src/renderer/voice/wake-mic.ts`
- `src/renderer/voice/voice-controller.ts`
- `src/renderer/voice/transcript-filter.ts`
- `src/main/voice/jarvis-action-fastpath.ts`
- `src/main/voice/jarvis-fastpath.ts`
- `src/main/voice/jarvis-brain.ts`
- `src/shared/voice-ipc.ts`

## Validacao automatizada

Testes focados rodados apos a mudanca:

```bash
npx vitest run src/renderer/voice/transcript-filter.test.ts \
  src/renderer/voice/wake-mic-constraints.test.ts \
  src/main/voice/jarvis-action-fastpath.test.ts \
  src/main/voice/jarvis-fastpath.test.ts \
  src/main/voice/jarvis-brain.test.ts
```

Resultado: 5 arquivos, 29 testes, todos passando.

Tambem passou:

```bash
npm run typecheck
```

## Gap remanescente para paridade real

Ainda nao esta fechado:

1. A rota realtime agora pode operar em modo hibrido: transcript live entra
   rapido, a resposta de audio live e suprimida no turno de action, e a action
   roda pelo executor Classic/MCP. Ainda nao e paridade total com Overclock,
   porque OpenAI/Gemini Live ainda nao chamam tools nativas diretamente.
2. O executor de voz ja centraliza actions em `jarvis-action-executor.ts` e usa
   MCP para `mcp_tool`, `run_command`, `send_to_pane` e fechamento de pane. UI
   local continua correta para abrir terminal, workspaces, wizards e squads.
3. Latencia sub-2s depende de evitar LLM nos comandos simples. O fast-path cobre
   `abrir terminal` e `que horas sao`, mas perguntas abertas continuam batch.
4. Notarizacao depende de credenciais Apple (`APPLE_TEAM_ID`, `APPLE_ID` e
   senha/perfil notary). Sem elas o Forge gera build local assinada ad-hoc,
   nao distribuivel via Gatekeeper.
5. Validacao de wake real ainda exige teste com o microfone fisico do usuario.

## Criterios de smoke recomendados

Usar o build local e observar `~/.nexus/logs/voice.log`:

1. Dizer em volume normal: "Hey Jarvis, abrir terminal".
   - Esperado: ack imediato, transcript limpo `abrir terminal`,
     action `open_terminal` e terminal aberto.
2. Dizer: "Hey Jarvis, que horas sao?"
   - Esperado: resposta curta via fast-path, sem LLM demorado.
3. Durante TTS, ficar em silencio.
   - Esperado: nenhum novo turno causado por `Pois nao, patrao?`.
4. Conferir voz.
   - Esperado: OpenAI `nova`; fallback para Piper/say deve aparecer no log se
     ocorrer, nunca mudar silenciosamente sem rastro.

## Proximo passo tecnico

Para chegar na Jarvis do Overclock, a proxima fase deve ligar uma ponte segura:

```text
Realtime transcript/tool call
  -> registry de acoes com schema
  -> executor main/MCP auditavel
  -> confirmacao por risco
  -> resultado volta ao live session
```

Enquanto isso nao for concluido, o modo recomendado para usuario final e o
Classic com fast-paths agressivos para comandos frequentes.

## Rodada 2 — sessao paralela (anti-surdez + MCP + Overclock pendingMic)

Apos o hotfix de pre-roll/ack, outra sessao atacou os sintomas que ainda
faziam a Jarvis parecer surda ou limitada:

| Sintoma | Causa | Fix |
|---|---|---|
| Loop "nao entendi" | `jarvisLive.enabled` reabria mic apos toda fala | `jarvis-reply-loop.ts`: so reabre com `expectReply` |
| Surda apos wake | Turno preso + `await liveStart` antes do mic | Barge-in no wake + mic antes de `liveStart` |
| Fala perdida no ack | Escuta so depois do TTS "Pois nao?" | `beginListening` antes do ack (paralelo) |
| So 10 acoes | Schema fechado no renderer | `mcp_tool` + `jarvis-action-executor.ts` via MCP bridge |
| Eco da propria voz | Transcript do TTS reentrando | `recordEcho`, filtro `JARVIS_SELF_ECHO`, anti-loop |

Padrao Overclock `pendingMic` portado para Classic:

- `beginUtterance()` dispara **antes** de `liveStart` (nao bloqueia mais a captura).
- Pre-roll 2,5s + `stripWakeAckEcho` da rodada 1 continuam valendo.
- `cancelUtterance()` no barge-in: novo "Hey Jarvis" sempre retoma.

Arquivos adicionais desta rodada:

- `src/renderer/voice/jarvis-reply-loop.ts`
- `src/renderer/voice/jarvis-action-executor.ts`
- `src/renderer/services/mcp-bridge.ts` (expandido)
- `src/main/voice/jarvis-tool-catalog.ts`
- `src/shared/voice-ipc.ts` (`mcp_tool`, `recordEcho`)

Gap remanescente atualizado:

1. Realtime ainda sem `functionDeclarations`/native tool calls no provider.
2. Classic/hibrido ja pode invocar qualquer tool `nexus_*` via `mcp_tool` no
   brain e passa por executor central.
3. Paridade total Overclock = live full-duplex **com** tools no provider
   OpenAI/Gemini.

## Rodada 3 — Jarvis app-aware, clicavel e prompt de agente em ingles

Esta rodada fecha parte importante da sensacao "ela domina o app":

- Clique na pill/HUD da JARVIS agora acorda a assistente usando o mesmo caminho
  do wake word: barge-in, ack e captura hands-free. Option/Command-click ou
  clique direito no botao de voz abre ajustes.
- A HUD fica visivel como pill pequena quando a voz esta pronta, sem ocupar o
  canvas inteiro.
- O contexto enviado ao brain agora inclui tipo do pane focado e URL quando o
  pane e browser.
- Fast-paths respondem sem LLM: "qual pane esta focado?", "qual pagina
  estamos?" e "onde estamos?".
- O prompt do brain reforca que `send_to_pane.action.text` deve ser um prompt
  de engenharia em ingles, mesmo quando o usuario dita em portugues.
- `open_terminal` ficou no caminho UI direto (`addShellPane()` + espera de
  sessao), porque `nexus_pane_spawn` e ferramenta de agente/worker, nao de
  shell simples. Isso evita "falou que abriu, mas nao abriu".

Validacao da rodada:

```bash
npm run typecheck
npx vitest run src/main/voice/jarvis-fastpath.test.ts \
  src/main/voice/jarvis-brain.test.ts \
  src/renderer/services/mcp-bridge.test.ts \
  src/renderer/lib/canvas-layout.test.ts \
  src/renderer/components/operator-sprite-data.test.ts \
  src/main/voice/jarvis-action-fastpath.test.ts \
  src/main/voice/jarvis-live.test.ts \
  src/main/voice/live-transport-controller.test.ts \
  src/renderer/voice/jarvis-reply-loop.test.ts \
  src/renderer/voice/transcript-filter.test.ts \
  src/main/jarvis/realtime/openai-realtime.test.ts \
  src/main/voice/gemini-live-transport.test.ts
```

Resultado: 12 arquivos, 85 testes, todos passando.
