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
- `REALTIME_ACTION_BRIDGE_ENABLED = false` no renderer.
- STT: Groq Whisper batch.
- TTS: OpenAI `gpt-4o-mini-tts` voz `nova`.
- Wake: openWakeWord local, threshold baixo para sensibilidade.
- Fast-path ja cobre `open_terminal`, mas dependia do transcript limpo chegar.

Principais gaps:

| Area | Overclock | Nexus antes | Risco |
|---|---|---|---|
| Fala colada ao wake | buffer pendente/pre-roll | captura comecava pos-wake | perder comando |
| Ack/eco | filtro por spoken similarity | TTS echo existe, mas wake ack podia entrar | auto-conversa |
| Tools live | function declarations | bridge realtime desligado | realtime conversa, nao age |
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

1. `REALTIME_ACTION_BRIDGE_ENABLED = false`. A rota realtime ainda nao deve
   prometer execucao de acoes.
2. O MCP bridge de voz nao e o executor unico das actions. O Nexus ja tem tools
   MCP ricas, mas a Jarvis Classic ainda usa action schema pequeno.
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
