# Jarvis (voz) do Overclock — arquitetura completa

> Documento de engenharia reversa **para estudo/paridade**. Descreve o *design* e o
> *comportamento* da camada de voz do Overclock a partir dos módulos empacotados no app
> instalado (`/Applications/Overclock.app`), dos tipos (`.d.ts`) e dos comentários de
> decisão que acompanham o código. **Não é uma cópia do código-fonte** — é a
> especificação de como o sistema funciona, no nível que serve para reimplementar de
> forma independente no nexus-ide.
>
> Fonte lida: `Overclock.app/Contents/Resources/sidecar/dist/` (versão do app de 08/07).
> Terminologia interna do próprio código: `F-xxx` = *finding* (bug/comportamento
> observado e corrigido), `C-xxx` = *change/capability* (fatia de feature). Cito esses
> códigos quando eles explicam **por que** uma decisão existe.

---

## 1. Empacotamento e topologia

O Overclock migrou de **Electron** para **Tauri**. O binário nativo (`Contents/MacOS/overclock`, Rust) é a casca; toda a lógica de produto roda num **sidecar Node** empacotado em `Contents/Resources/sidecar/`:

- `package.json` → `@overclock-app/sidecar`, *"WebSocket host serving Overclock core for Tauri migration"*, `type: module`, Node ≥ 22.12.
- Dependências que importam para a voz: `@anthropic-ai/claude-agent-sdk` (o "cérebro"), `ws` (WebSocket para o Gemini Live), `zod`, e os workspaces internos `@overclock-app/{bus,catalog,core,mcp,ipc-types,pty}`.
- O sidecar é um **host WebSocket**: o renderer (UI) conversa com ele por WS; ele detém o estado, faz spawn de PTYs (terminais dos CLIs) e orquestra os agentes.

A camada de voz vive em `sidecar/dist/` nestes 7 módulos (todos com `.d.ts` + `.js` + sourcemap):

| Módulo | Papel |
|---|---|
| `JarvisService` | Motor central: máquina de estados, dois cérebros, narração proativa, contexto de tela, memória. É o coração. |
| `GeminiLiveSession` | Transporte de voz full-duplex (WebSocket para o Gemini Live). Áudio in/out, reconexão, singleton, grace/reuso, dormência, eco. |
| `jarvisLivePrompt` | O *system prompt* da sessão de voz — a "constituição" do Jarvis (as 11 leis, o loop, o glossário). |
| `voiceSafeText` | Sanitizador puro: remove sintaxe (código, JSON, `mcp__*`) de qualquer texto antes de virar fala. |
| `JarvisMemory` | Memória persistida (fatos/preferências) sobre o `SharedMemory` (`~/.overclock-ssh/shared-memory.db`). |
| `JarvisWakeLock` | Lock de instância única em arquivo — só um Jarvis pode segurar o mic por vez. |
| `handoffWakeMessage` | Builder puro da mensagem de "acordar o orquestrador" quando um worker entrega — separa parte humana da técnica. |

---

## 2. A ideia central: **dois cérebros**

Este é o conceito arquitetural mais importante. O Jarvis de voz **não é um único LLM**. São dois modelos em papéis distintos, ligados por uma única função:

```
┌─────────────────────────────────────────────────────────────────┐
│  MIC ──▶ Gemini Live (gemini-3.1-flash-live-preview)             │
│         "voz + roteador fino" — full-duplex, baixa latência      │
│         expõe só 8 tools GROSSAS (verbos de voz)                 │
│                                                                   │
│         delegar ─────────────┐  (única que faz trabalho real)    │
│         consultar/ler/       │                                   │
│         navegar/comandar/    │  respondem DIRETO (runTool),      │
│         perguntar/restaurar/ │  sem passar por LLM — voz rápida  │
│         encerrar             │                                   │
│                              ▼                                    │
│  ┌──────────────────────────────────────────────────────┐       │
│  │  Claude Agent SDK (query() streaming, OAuth ~/.claude) │       │
│  │  "o cérebro" — 10 tools Overclock via MCP in-process   │       │
│  │  squad_open, mission_create, pane_spawn, pane_write,   │       │
│  │  navigate, memory_*, ...                                │       │
│  └──────────────────────────────────────────────────────┘       │
│                              │                                    │
│         resultado ───────────┘ vira [update] narrado pela Live   │
└─────────────────────────────────────────────────────────────────┘
```

**Por que dois?** Latência vs. capacidade. O Gemini Live é nativo de áudio (full-duplex, barge-in, prosódia), ótimo para conversar mas raso em ferramentas. O Claude Agent SDK é o executor competente (squads, panes, missões) mas lento demais para segurar um diálogo falado. A divisão:

- **Ler/navegar/consultar/comandar/restaurar** → respondidos **direto** pelo `runTool` do sidecar (sem LLM no meio), para a voz nunca travar esperando um turno de modelo.
- **delegar** → a **única** das voice tools que encaminha trabalho de verdade: chama `JarvisService.send()`, que roda um turno do **Claude Agent SDK**. O resultado volta como `[update]` e a Live **narra**.
- **perguntar** → repassa a dúvida a um pane já ativo (via `pane_write`) e narra a **resposta do pane** — o conhecimento vive no pane que executa, não no Jarvis.

O contrato do sidecar (`JarvisService.d.ts`, cabeçalho) diz explicitamente: *"`delegar` (a única das 4 voice tools que executa trabalho real) encaminha pro MESMO brain Agent SDK abaixo via send(); consultar/ler/navegar respondem direto via runTool."* (Hoje são 8 verbos, mas a doutrina é a mesma.)

Auth: **OAuth do Claude CLI apenas** (lê `~/.claude`). A versão Tauri **cortou** o `safeStorage` e o fallback por API key do `@anthropic-ai/sdk` que existiam na referência Electron; sem login CLI, o serviço emite `jarvis:event` de erro.

---

## 3. `GeminiLiveSession` — o transporte de voz

Portado 1:1 da referência Electron (`_refs/overclock-jarvis/.../GeminiLiveSession.ts`); só o logger e o import de tipo mudaram. É a parte mais densa em engenharia de robustez.

### 3.1 Conexão

- **Modelo:** `models/gemini-3.1-flash-live-preview`.
- **Endpoint:** `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent` (protocolo **BidiGenerateContent**, a API Live bidirecional do Gemini).
- **Chave:** Google AI Studio, guardada no `ServiceKeysStore` sob `'gemini-live'` (`getGoogleKey()`).

### 3.2 `setup` da sessão (primeiro frame enviado)

```
responseModalities: ['AUDIO']
speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName = 'Charon'  (default)
systemInstruction: { parts: [{ text: <getLivePrompt(...)> }] }
tools: [{ functionDeclarations: [ ...os 8 verbos de voz... ] }]
inputAudioTranscription:  {}   // transcreve a fala do usuário
outputAudioTranscription: {}   // transcreve a fala do próprio TTS
sessionResumption: <handle>    // retomar sessão após queda
contextWindowCompression: { slidingWindow: {} }   // janela deslizante p/ custo
```

- **Voz fixa (timbre):** `Charon`. `voiceName` é pinado para o timbre não mudar entre turnos (`/^[A-Za-z]+$/`).
- **Prosódia NÃO é fixa (F-090/F-107):** o modelo *native-audio* **re-sorteia** tom/ritmo/energia **a cada nova conexão** — o timbre é Charon sempre, mas a "atuação" varia. Essa observação é a causa raiz de metade da lógica de grace/reuso abaixo: reconectar = re-sortear prosódia; reusar a MESMA conexão = preservar a atuação. O prompt reforça "constância acima de expressividade".
- `languageCode` pt-BR é pinado nos modelos *half-cascade*; nos *native-audio* a fixação é via prompt (Lei do idioma).

### 3.3 Áudio

- **Mic → servidor:** `pushMic(chunk)` recebe PCM `Int16` **16 kHz mono** do renderer e envia via `realtimeInput`. `endMicTurn()` sinaliza `realtimeInput.audioStreamEnd`.
- **Buffer de pré-conexão (`pendingMic`, C-071.1c):** `startLive` cria a instância **sincronamente**; chunks que chegam antes do `setupComplete` entram no `pendingMic` (com teto `PENDING_MIC_MAX_BYTES`) e sofrem *flush* quando a sessão fica pronta — a 1ª frase nunca se perde.
- **Servidor → renderer:** chunks de áudio emitidos como `JarvisEvent { type: 'audio_chunk', data, done }`.

### 3.4 Cancelamento de eco (F-126)

O TTS do Jarvis volta pelo mic (o transcritor de input capta a própria fala). `normEcho()` normaliza (minúsculas, sem acento/pontuação, espaços colapsados) e `isEchoOf(recentSpokenNorm, input)` decide: é eco se o input é **substring contígua** da fala recente **ou** ≥ 80 % das palavras significativas (> 2 chars) estão nela. Janela deslizante `recentSpokenNorm` (cap `ECHO_WINDOW_CHARS`). Barge-in real (fala diferente do TTS) não casa → passa. Módulo testável puro.

### 3.5 Ciclo de vida da conexão — o mais elaborado

Três estados de "vida" convivem, e a distinção é deliberada:

1. **Singleton slot (F-133):** só pode existir **uma** `GeminiLiveSession` viva. `claimSingleton()` **mata qualquer sessão anterior** (inclusive a em grace) antes de conectar. Cada reconexão checa identidade: só a instância corrente reconecta; as demais se auto-encerram em `attemptReconnect`. Regra do repo: *"recurso compartilhado = isolar por identidade"*.

2. **Grace / reuso quente (F-107 r2):** ao desligar o orb, em vez de matar o WS, faz-se `softStop(graceMs)` — o socket fica **vivo e destacado** por `LIVE_GRACE_MS`. Se o usuário reativar rápido, promove o **mesmo** socket de volta → **prosódia preservada** (sem re-sorteio). Expirou sem reuso → hard `stop()`.
   - Sutileza importante: o socket em grace fica **fora** de `liveSession` (vira `graceSession` no `JarvisService`). Toda a lógica de produto lê `liveSession` como "voz ligada"; durante o grace ela vê "desligada" (correto: mic parado, nada narrado).

3. **Reuso só se REALMENTE fresco (F-138):** socket local `OPEN` **não** prova sessão viva do lado do Gemini (o "zumbi": socket aberto, servidor mudo, chunks jogados no vácuo). `isReusable()` exige: `softStopped` (grace real) **E** WS aberto **E** dono do slot **E** servidor falou há menos que `REUSE_FRESHNESS_MAX_MS` (âncora = **última msg do servidor**, `lastServerMsgAt`, não o momento do off — de propósito). Qualquer dúvida → conexão fresh (sempre segura; custo = re-sorteio de prosódia, aceito).

4. **Reconexão:** `attemptReconnect` com `maxReconnectAttempts` e `sessionResumption` (retoma o contexto). `stopped=true` é terminal (não reconecta).

### 3.6 Fila de turnos (F-113)

Nunca dois turnos "injetados" concorrentes na mesma sessão. `sendQueue` + `turnBusy`: `drainSendQueue()` só manda o próximo quando nenhum está em voo; `releaseTurn()` libera no `turnComplete`. `resetTurnQueue()` zera entre conexões (não carregar `turnBusy` stale). Tipos de injeção que entram nessa fila serializada:

- `injectContext(text)` — contexto **silencioso** (transcript de reconexão, restore de workspace) como turno Live.
- `injectNarration(payload)` — narração de evento (handoff, progresso) embrulhada num **envelope** que separa diretiva de dado, para o modelo **nunca ler a instrução crua em voz alta** (F-113: o native-audio às vezes ecoava a instrução).
- `injectScreenUpdate(text)` — estado de tela, **coalescido** com debounce curto (C-092.7 b): a rajada de navegação do wizard emitia N turnos de tela quase-idênticos, cada um rebilhando o contexto inteiro; só o **último** estado da janela vira turno.
- **Sessão em grace não recebe turno (F-138):** injetar tela num socket suave-parado fazia o Gemini **falar com o modo desligado** (zumbi falante) — buffera e o reuso/reconexão faz flush.

### 3.7 Instrumentação e guard-rail de custo (C-092.7)

Cada geração do Live **rebilha o system prompt + o histórico acumulado** — o custo da sessão cresce a cada turno mesmo com payloads pequenos. `instrumentInput()` contabiliza cada pedaço de input (turno injetado ou tool-response) por **fonte** (`classifySource`), emitindo o breadcrumb `[jarvis-tokens]` (ranking por fonte para "medir antes de cortar"). Há um `guardRailTripped` e `sessionEstInputTokens` acompanhando o teto.

---

## 4. `JarvisService` — o motor de orquestração

O arquivo mais pesado (o `.d.ts` tem ~660 linhas só de assinatura + comentários de decisão). Responsabilidades:

### 4.1 Máquina de estados e eventos

```ts
type JarvisState     = 'idle' | 'thinking' | 'speaking' | 'executing';
type JarvisLiveState = 'connecting' | 'listening' | 'speaking' | 'executing'
                     | 'closed' | 'ended' | 'error';
```

Emite um union `JarvisEvent` para o renderer: `state`, `text_delta`, `message_complete`, `tool_call` (com `requiresConfirmation`), `tool_result`, `error`, `audio_chunk`, `interrupted`, `live_state`, `live_transcript` (role + final), `activity`, `restore_panes` (com `ackId`).

### 4.2 Sessão Live sob demanda, com dormência (C-092.9 / F-139)

Além do grace (§3.5), há **dormência** por ociosidade:

- `armIdleTimer()` (re)arma a cada **turno real** (fala final / tool — mic contínuo **não** conta). Sem interação por `IDLE_TIMEOUT_MS` (**5 min**, recalibrado de 90 s originais) → `onIdleTimeout`.
- Na dormência a **sessão fecha de verdade** (WS morre, histórico morre, billing zera) **mas o MODO fica armado**: orb ligado, mic local ouvindo. **Não** emite `ended` (derrubaria o `jarvisMode`), **não** libera o wake lock (segue dona do mic local). A **próxima fala religa transparente** via `pushLiveMic` (o gate de VAD do renderer só manda chunk com fala real, então chunk = usuário falando). Trade-off aceito: ~1 s de latência na 1ª fala pós-dormência. `lastLiveArgs` guarda como reconectar (sem `greetOnConnect`: religa não cumprimenta).

Diferença grace × dormência: **grace** é para o re-toggle deliberado do orb (segundos, preserva prosódia); **dormência** é ociosidade longa (minutos, zera custo, religa no wake).

### 4.3 Retomada de contexto entre conexões (C-072)

`liveHistory` (cap curto `LIVE_HISTORY_MAX`) guarda os turnos falados recentes **fora** da `GeminiLiveSession` (que morre no stop). `liveDisconnectedAt` + `RESUME_WINDOW_MS` definem a janela em que o re-wake reinjeta o contexto de retomada. Histórico **persistido** de verdade é outra coisa (memória, §7).

### 4.4 Contrato de *screen-state* (a "consciência de tela")

O Jarvis sabe o que o usuário está **vendo**. O renderer reporta via `updateScreen(text, missionId?, visiblePaneIds?, focusedPaneId?, isHome?, workspaceNames?)`. O serviço mantém um retrato determinístico:

- `lastScreenMissionId` / `lastScreenMissionTitle` (F-130: o **título** viaja **dentro do texto** do reporter via regex `SCREEN_MISSION_TITLE_RE`, porque o transporte Tauri derruba campos novos). Toda linha falável cita o **título** ("Landing premium"), nunca o id nanoid (C-062: "a voz não soletra código").
- `lastScreenVisiblePaneIds` / `lastScreenFocusedPaneId` (F-102: ids reais dos panes na frente do usuário — fonte determinística, mais confiável que o escopo mission-only que pode estar stale).
- `isGlobalHomeScreen` + `homeWorkspaceNames` (F-118: distinguir home global de "workspace aberto sem missão"; na home só devolve a lista de workspaces).
- `lastScreenGridMissions` (C-090.2: missões reais da tela grid, cada uma com status **live** = tem pane vivo agora + quantos panes **salvos**).

**Read-back (C-090):** `awaitScreenChange(beforeScreen, timeout)` espera a tela **de fato** mudar depois de uma ação que deveria trocá-la (abrir workspace/missão/pane). Resolve `true` só quando o screen-state sai do estado anterior — se a tela nunca mudou, **não anuncia sucesso** (Lei 1, "nunca fingir"). É a primitiva genérica que generaliza o ack round-trip do wizard.

`buildMissionEntitiesLine` / `buildGridEntitiesLine` montam as linhas faláveis: entidades reais (panes ativos com papel + status, panes salvos) + ações disponíveis (delegar/perguntar/restaurar/voltar), sempre rotuladas.

### 4.5 Narração proativa (o Jarvis fala **sem ser perguntado**)

Quando o brain delega trabalho a um pane, o Jarvis **narra novidades por conta própria** — cumprindo a promessa "vou narrar quando houver novidades". Máquinas envolvidas:

- **Track de panes delegados (F-101):** `trackDelegatedPane` registra o pane alvo (o `paneId` vem no arg do `pane_write`; `squad_open`/`spawn` devolvem no resultado). `ensureHandoffNarration` liga (uma vez) a ponte **handoff→narração**: o mesmo sinal `submit` do `HandoffRegistry` que acorda o orquestrador aciona também a voz. `onDelegatedHandoff` narra a entrega; ignora panes que o Jarvis não delegou e mortes pedidas (`closed_by_caller`).
- **Papéis reais (C-085.2 / F-111):** `captureDelegatedPaneRole` consulta o bridge pelo `squadRole` (`orchestrator` = **piloto**, `builder` = **chefe**). Narrações citam "o chefe"/"o piloto", nunca "um pane" genérico (requisito verbatim do usuário: *"ele tem que reconhecer q é um chefe aquele cara"*).
- **Hops de cadeia (C-085.2):** `pollDelegatedPaneHops` acompanha os workers que um chefe/piloto repassou trabalho (`bridge.workersOfCaller`) e narra o **repasse** ("o chefe passou pro pesquisador, tá rodando"); `onHopWorkerHandoff` narra a entrega voltando pela cadeia ("o pesquisador terminou, o chefe tá revisando"). Dedup por `chefePaneId+workerPaneId`.
- **Progresso espontâneo (C-085):** `maybeNarrateProgress` lê o `tail` do pane e narra o avanço. **Anti-spam por construção:** só narra quando a assinatura do tail **estabiliza** entre dois polls (~16 s) — spinner/streaming muda a cada poll e nunca estabiliza; e há dedup do estado já narrado (`narratedProgressSig`).
- **Perguntas pendentes (F-110):** um pane bloqueado numa pergunta (`AskUserQuestion`) **não** gera handoff. `pollDelegatedPanesForQuestions` faz poll do tail (`QUESTION_POLL_MS`), detecta menu (`detectPendingQuestion`) e narra proativamente, com dedup por hash de conteúdo, TTL (`NARRATED_QUESTION_TTL_MS`) e estabilização em 2 polls (`pendingOpenQuestionHash`) para não narrar pergunta fantasma.
- **Resposta aguardada (C-050.4):** quando o usuário pergunta explicitamente, `watchForAnswer` liga um **poll curto dedicado** (`ANSWER_POLL_MS` = 1,5 s) só naquele pane até a resposta chegar (conteúdo novo ≠ baseline, estável por 2 ticks). O poll normal de 8 s segue intocado para o progresso espontâneo. Resolve o episódio *"o pane responde e o Jarvis leva horas pra se dar conta"*.

### 4.6 Fail-closed do gate de origem (F-135 / F-118.1)

Narração proativa só sai se a **missão de origem** do evento ainda é a interface na tela. `originMissionIdFor` resolve a origem (worker herda do chefe via `hopWorkerChefe`). Pane **não-rastreado** → `narrateIfPaneOnScreen` resolve a missão/workspace real via `bridge.listPanes()` e **só narra se a origem coincide com a tela atual**; pane fora da lista, de outro workspace, ou bridge indisponível ⇒ **silêncio** (o evento fica para o `consultar`, nunca vaza para a voz). Decisão anotada: pane rastreado que morre narra "caiu"; pane não-resolvível fica mudo (não há como provar a que interface pertencia). `injectNarration` é serializada por fila na chegada.

### 4.7 Roteamento determinístico de respostas (C-085 r3)

Com uma pergunta pendente narrada, a **próxima fala do usuário** que não for comando de UI é **por construção** a resposta àquele diálogo. `maybeRouteAnswerToPendingQuestion` faz `pane_write` **verbatim** (voz→pane, fidelidade técnica), **sem passar pela decisão do modelo Live** (que já respondia genérico da própria cabeça — reprovado ao vivo). Salvaguardas:

- `looksLikePendingAnswer` (heurística: fala curta típica de resposta, ou cita opção/número, ou compartilha palavra significativa com a pergunta).
- `UI_UTTERANCE_RE` / `isUiUtterance`: comandos de UI/estado escapam do roteamento (ficam com o Live).
- `STATUS_QUESTION_RE` / `isStatusQuestion`: "qual a situação?"/"como tá?" é detectado **em código** (doutrina "técnica > prompt") para travar o roteamento independente de o modelo Live escolher "perguntar" ou "consultar"; `sweepMissionStatus` varre **todos** os panes da missão ancorada.
- Dedup `wasAnswerJustRouted` / `routedAnswer{PaneId,Text,At}` (`ROUTED_ANSWER_DEDUP_MS`): a mesma fala chega 2× (interceptor de transcript roteia primeiro; o modelo Live ainda pode chamar perguntar/comandar/delegar com o mesmo conteúdo) — a 2ª vira ack, sem 2º write. `menuMatchesAnswered` evita renarrar um menu já respondido ressuscitado do scrollback.

### 4.8 Resolução de alvo de pane por voz (C-074 / F-102 / F-111)

`resolveLivePaneId`: vazio/"ativo"/"focado" = pane em foco na tela; senão o mais recente do escopo; senão bate literal como `paneId`, por **papel** (`ROLE_ALIASES`: "piloto"/"orquestrador" = `squadRole`, nunca chute), por **número** (`paneNumber`: "331" = "pane-331"), e por fim como trecho do agent ("codex"). C-088: "terminal N" = "pane N".

### 4.9 Compressão de fala (a voz é sempre curta)

Nada de tail bruto chegando ao TTS. `synthesizePaneTail` produz um estado falável (pergunta pendente > menu > última linha). `compressMenuForNarration` / `menuOptionLabel` / `menuNarrationWindow` comprimem menus (janela de 12 linhas, ampliada a 30 se cortar o menu no meio — para narrar todas as opções sem "jurar completude" com opções cortadas). `composeVoiceSummary` (C-092.8) faz um **one-shot no brain Claude** (mesma auth OAuth, custo marginal ~zero) para compor a frase de voz de um texto livre — sem tools, 1 turno, timeout curto, 1 em voo por vez (`voiceSummaryBusy`); `null` → o caller usa fallback determinístico. Isso substituiu mandar delta cru de 600 chars pro Gemini (que "pensava pago").

### 4.10 System prompt do brain (C-055)

`composeSystemPrompt` = prompt canônico (`buildJarvisSystemPrompt` do core) **+** camada de memória (instruções das tools `memory_*` + bloco de fatos persistidos). Montado no **sidecar** (não no core) porque o bloco é dinâmico por sessão.

### 4.11 MCP in-process e mapeamento de tools

`buildOverclockMcpServer` cria um MCP server **in-process** (`createSdkMcpServer`) expondo 10 tools Overclock ao Agent SDK, despachadas por `runTool` → registry existente (`findRegisteredTool`/`buildOverclockToolRegistry`). Mapeamento Jarvis → registry:

```
squad_list        → overclock_squad_list
squad_open        → compound: list + best-match + squad_spawn(createMission=true) + write briefing
mission_create    → overclock_mission_create
mission_list      → overclock_mission_list
mission_spawn_pane→ overclock_mission_spawn_pane
navigate          → overclock_navigate
pane_*            → pane_* (mesmos nomes)
```

`makeCanUseTool` / `queueCallId`/`dropCallId`/`takeCallId` + `waitForConfirmation` implementam o gate de confirmação (`confirmBeforeTools`, hoje **false** — a UI de confirmação foi removida, casando o comportamento da referência). `stripDelegationEnvelope` remove o envelope "manda pro pane X:" para entregar só a `<tarefa>` verbatim.

---

## 5. Os 8 verbos de voz (functionDeclarations do Gemini Live)

Declarados inline no `setup`. São o vocabulário **grosso** que o modelo de voz pode chamar (o trabalho fino é do brain). Descrições resumidas:

| Verbo | Args | O que faz | Caminho |
|---|---|---|---|
| **delegar** | `briefing` | Trabalho substancial (codar, pesquisar, criar/rodar). | → **brain** (Agent SDK). Única que executa trabalho real. |
| **perguntar** | `pergunta`, `paneId?` | Dúvida de **trabalho** sobre um pane ativo — repassa ao pane e narra a resposta **dele**. "Qual a situação?" = sweep de todos os panes da missão ancorada. | `pane_write` + poll de resposta. Nunca inventa resposta. |
| **comandar** | `paneId?`, `texto` | Digita/Enter um comando **literal** num pane já aberto ("/model opus"). | `pane_write` verbatim. Não inventa o texto. |
| **ler** | `paneId?` | Lê o output recente de um pane ("o que respondeu / qual resultado"). | `runTool` direto. |
| **consultar** | `pergunta` | Estado do Overclock (missões/panes/squads) → resumo textual. | `runTool` direto. Só LISTA (≠ ler, que traz conteúdo). |
| **navegar** | `target`, `query?` | Dirige a UI: workspace/mission/screen/pane **e** o wizard de Nova Missão (`mission-new`, `wizard-set key:value`, `wizard-fire`, `wizard-cancel`). | `overclock_navigate` + ack round-trip. |
| **restaurar** | `alvo?` | Reabre panes **salvos** da missão na tela (botão "Restaurar todos"). | `runTool`. Vazio = todos. |
| **encerrar** | — | Encerra a sessão de voz na despedida ("tchau", "pode desligar"). | Fecha a Live. |

O wizard por voz é notável: cada passo do modal Nova Missão é um `navegar("wizard-set", "key:value")` — `mode` (livre/squad/agentico), `count`, `clis`, `squad`, `goal`, `midia`, `style` (torre-de-controle → scout-dispatch; cadeia-de-comando → one-one-n), `model`, `account`. "Estado do wizard e estado da conversa são UM só" — o retorno de cada navegar diz "Tela agora: ..." e o Jarvis narra **isso**, nunca uma pergunta de outro passo. Valores **só** vêm de fala explícita — nunca inventa.

---

## 6. `jarvisLivePrompt` — a constituição do Jarvis

`getLivePrompt(workspace, persona)` monta o system instruction da Live. Persona (C-070/F-136): `userName`, `assistantName`, `customPrompt` são injetados. Regras notáveis do nome do usuário: pronúncia **idêntica** sempre, nunca apelido/variação, e usar o nome **só** na saudação e em momentos-chave (repetir a cada fala "é tique, não cortesia").

O núcleo são **as 11 leis** (o design de produto mais opinativo do sistema — muitas anotadas com citação verbatim do dono, "Laschuk"):

1. **Nunca fingir** — só confirma "feito" depois da função retornar.
2. **Nunca falhar mudo** — todo comando termina com uma frase falada.
3. **Nunca perder contexto** — age sempre no workspace ativo agora.
4. **Nunca chutar calado** — incerto → pergunta curto, não inventa.
5. **Nunca narrar código** — jamais soletra sintaxe (nomes com "mcp", JSON, ids). Missão citada pelo **título** da tela, nunca o id.
6. **Nunca narrar status por suposição (F-096)** — "deleguei" ≠ "está trabalhando". Perguntou como está → chama `ler`/`consultar` ANTES; narra o que o sinal diz (running/idle/bloqueado por erro no terminal).
7. **Nunca pensar pelo trabalho (C-085)** — é interface/roteador, não o cérebro. **Régua dura:** só responde direto perguntas de UI/estado do app; **tudo o mais** (até "quanto é 1+1") é pergunta de **trabalho** → função `perguntar` (o conhecimento vive no pane).
8. **Ack curto e natural (C-086)** — confirmar ação = 1 frase em 1ª pessoa ("deixa comigo"), nunca etiqueta de sistema ("Enviado."). Não ecoa o pedido de volta. Verbosidade só com informação **nova**.
9. **Narração sem costura meta** — narra o conteúdo direto: "o build passou", nunca "o pane respondeu que o build passou". Cobre também o maquinário interno: **não** diz "orquestrador"/"pane"/"vou mandar pro..." — *"você não fala COM panes, você É o pane"*. Vale para auto-referência: problema seu é "tive um problema aqui", nunca "o assistente teve um problema".
10. **Pessoa/endereçamento com piloto (C-085.1)** — com piloto na missão ativa, conversa direta em 2ª pessoa; texto vai verbatim; resposta narrada tal como veio (1ª pessoa). Sem piloto, narra em 3ª pessoa/relato.
11. **Âncora da missão (C-085 r2)** — "qual a situação?" com missão ativa é **sempre** sobre o trabalho dela (sweep dos panes), nunca "temos N missões". A âncora só muda com troca **explícita**.

Além das leis: o **loop** de cada pedido (normalizar pelo glossário → classificar em um dos verbos → gate → executar → narrar), o **gate** (tarefa clara delega já; confirma antes só se: modo de missão não dito, destrutivo, ou grande/caro), e o **glossário de STT** (o transcritor erra: "Riggs Field"→"higgsfield", "VST low"→"effort low", "ramotion"→"remotion", etc.).

---

## 7. Módulos de apoio

### `voiceSafeText` — sanitizador (C-062)

Defesa em profundidade: **todo** texto injetado na voz passa por aqui antes de virar fala. Módulo puro `string → string`. Remove, em ordem:

1. Blocos cercados ```` ``` ```` → somem inteiros.
2. Chamadas `mcp__nome(args)` e nomes `mcp__*` soltos (regex tolera 1 nível de aninhamento).
3. Ponteiros órfãos que sobram ("Mais detalhes:", "Responda via:" sem nada narrável na frente).
4. Blobs JSON de payload (`{"key": ...}`) — até 3 passadas para desmontar aninhamento raso.
5. Inline code: mantém palavra simples (`` `main` `` → main), remove se contém sintaxe (`{}()[];=\|<>$`, `::`, `__`, `mcp`).

Exemplo do próprio cabeçalho: um wake com `Mais detalhes: mcp__overclock__handoff_list({ids:["h-5t"]})` visível na tela chega ao TTS só como a parte humana.

### `JarvisMemory` — memória persistida (C-055)

Sobre o `SharedMemory` (`~/.overclock-ssh/shared-memory.db`, motor T-021.4). Modelo: **1 fato = 1 scope** (`jarvis::<key>`). O SharedMemory mantém uma entrada *current* por scope (cadeia de supersedes), então regravar a mesma key **atualiza** a preferência sem duplicar ("default 3 panes" → "default 2 panes" substitui). API:

- `remember(key, content)` — grava/atualiza (mesma key = supersede; mesma (key,content) = no-op).
- `recall(query?)` — lista fatos vivos; com query filtra por substring.
- `forget(target)` — soft-delete (`is_current=0`; a cadeia sobrevive para auditoria; redizer o fato o ressuscita).
- `contextBlock()` — bloco injetado no system prompt (brain **e** Live), memórias recentes primeiro, com cap de chars.

`slugifyMemoryKey` normaliza a key falada em slug estável (sem acento, kebab-case). As tools `memory_*` são **internas** (não re-expostas no MCP público).

### `JarvisWakeLock` — instância única

Lock em arquivo (`wakeLockFilePath()`). `acquireWakeLock(isDev, path?)` retorna `ok=true` (ganhou ou já era dono) ou `ok=false` + `ownerIsDev` quando outra instância **viva** já detém — aí `startLive()` recusa sem conectar. `releaseWakeLock` só libera se o **PID** é o dono (nunca derruba posse de outra instância). É o que impede dois Overclocks (ex. app instalado + build de dev) de brigar pelo mic.

### `handoffWakeMessage` — separação humano/técnico (C-062/F-012)

Builder puro da mensagem enfiada no PTY do orquestrador quando um worker entrega. `buildWakeMessageParts(entry, squadRole)` devolve `{ human, technical }` como **campos separados** (padrão `humanResult`): `human` = frase voice-safe (pane + item + resumo, sem sintaxe); `technical` = a chamada de tool que o CLI do orquestrador precisa (e que a voz **nunca** narra). `buildWakeMessage` junta os dois na linha do PTY; um consumidor de voz narra só o `human`. `extractItemRef` acha o 1º id que o resumo do worker cita (ex. "F-012") para referência humana, ou omite se o resumo é silencioso (não chuta).

---

## 8. Fluxos ponta a ponta (juntando tudo)

**"Cria uma landing page premium"** (delegar):
1. Mic → Gemini Live transcreve → classifica como `delegar` (trabalho) → gate: tarefa clara, delega já → ack em 1ª pessoa ("deixa comigo").
2. `runLiveFunction('delegar', {briefing})` → `JarvisService.send()` → turno do **Claude Agent SDK** com as 10 tools MCP.
3. O brain faz `squad_open`/`pane_spawn`/`pane_write`; `trackDelegatedPane` registra os panes; `ensureHandoffNarration`/`ensureQuestionPolling`/`pollDelegatedPaneHops` começam a vigiar.
4. Progresso do pane → `maybeNarrateProgress` (estabilizado ~16 s) → `voiceSafeText` → `injectNarration` (envelope) → Live **narra** "o build passou" (1ª pessoa, sem costura meta).
5. Pane pede algo (`AskUserQuestion`) → `pollDelegatedPanesForQuestions` narra a pergunta → próxima fala do usuário → `maybeRouteAnswerToPendingQuestion` → `pane_write` verbatim → `watchForAnswer` (poll 1,5 s) → narra a resposta.

**"Nova missão"** (navegar/wizard):
1. `navegar("mission-new")` abre o modal no passo do MODO → narra "Livre, Squad ou Agêntico?".
2. Cada resposta → `navegar("wizard-set", "mode:...")`, depois `count`, `clis`, ... → `navegar("wizard-fire")` = Iniciar.
3. Pós-início: pergunta o objetivo → a resposta vira o **primeiro prompt** via `delegar("envia como primeiro prompt pro pane orquestrador...")`.

**Desligar e religar rápido** (grace): orb off → `softStop(LIVE_GRACE_MS)` mantém o WS → orb on em segundos → `isReusable()` true → mesmo socket promovido → **prosódia preservada**.

**Ociosidade de 5 min** (dormência): sem turno real → `onIdleTimeout` fecha o WS (custo zera) mas mantém o modo/mic local → usuário fala → `pushLiveMic` religa transparente.

---

## 9. Notas para o nexus-ide (paridade)

O nexus-ide já tem uma pilha de voz paralela (`src/main/voice/gemini-live-*`, `src/renderer/voice/jarvis-action-executor*`, `src/shared/overclock-voice-nlu.ts`). Ao comparar/portar, os pontos que **carregam mais engenharia não-óbvia** (e que valem replicar como comportamento, reimplementados de forma independente) são:

1. **Dois cérebros** com `delegar` como única ponte para o executor lento — é o que mantém a voz responsiva.
2. **Grace × dormência × singleton × reuso-fresco** — quatro estados distintos de vida da conexão, cada um resolvendo um bug real (prosódia re-sorteada, zumbi server-side, duas instâncias, custo ocioso).
3. **Narração proativa com gate de origem fail-closed** — narrar só eventos cuja missão de origem ainda está na tela; o resto fica para o `consultar`.
4. **Roteamento determinístico de resposta em código, não em prompt** — pergunta pendente + próxima fala não-UI = resposta verbatim ao pane, com dedup contra o modelo Live que também tenta responder.
5. **Anti-spam por estabilização** (2 polls / ~16 s) em vez de throttle cego — spinner/streaming nunca estabiliza, então nunca vira ruído.
6. **`voiceSafeText` como defesa em profundidade** — sanitizar na fronteira do TTS, não confiar no prompt.
7. **Compressão de fala via one-shot no brain** (`composeVoiceSummary`) em vez de mandar texto cru pro modelo de voz caro.
8. **As 11 leis** como spec de produto da personalidade — a maior parte nasceu de reprovação ao vivo; são requisitos, não enfeite.

---

*Fim. Documento derivado por observação/engenharia reversa dos módulos empacotados, para fins de estudo e paridade de features. Descreve design e comportamento; não reproduz o código-fonte proprietário do Overclock.*
