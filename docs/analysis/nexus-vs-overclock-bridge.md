# Nexus IDE vs Overclock / Bridge - Analise Profunda e Plano de Melhorias

Data da analise: 2026-07-07  
Escopo: leitura, inspecao, execucao leve de comandos de diagnostico e documentacao. Nenhum codigo de produto foi alterado.

## 1. Sumario executivo

O Nexus ja tem uma base solida de IDE Electron multi-processo, PTY isolado em `utilityProcess`, MCP local para agentes e um modulo Jarvis com STT, TTS, wake word, configuracao de provedores e catalogo inicial de acoes. O problema central nao e ausencia total de Jarvis: e desalinhamento entre a promessa de "voice agent realtime que opera todo o Nexus" e a arquitetura efetiva em producao.

Hoje, no codigo-fonte atual, a rota confiavel da Jarvis ainda e Classic:

```text
audio gravado por PTT/wake
  -> STT batch
  -> Jarvis brain via chat completion
  -> uma acao JSON limitada
  -> switch de acoes no renderer
  -> TTS
```

A rota de audio full-duplex existe como opcao `gemini-live`, mas o proprio renderer marca que "Gemini Live is not action-capable yet" e mantem `REALTIME_ACTION_BRIDGE_ENABLED = false` em `src/renderer/voice/voice-controller.ts:41`. Isso explica diretamente o sintoma do usuario: a Jarvis pode parecer "live" em partes do audio, mas nao opera o Nexus como agente realtime.

A segunda lacuna critica e leitura de tela. O Nexus nao tem, para Jarvis, captura visual da janela, arvore de acessibilidade, OCR ou modelo de visao. O que existe e um resumo textual deterministico montado pelo renderer (`currentScreenSnapshot`) e enviado ao brain em `context.screen`, com limite de 500 caracteres no schema IPC. Isso permite alguma nocao de workspace/panes/board, mas nao "ler a tela" no sentido que o usuario espera.

Overclock, por comparacao, tem uma arquitetura mais proxima do objetivo: app nativo/Tauri-like com sidecar Node, `JarvisService`, `GeminiLiveSession`, streaming de microfone para Live, atualizacao de screen context, funcoes de voz e delegacao para Claude Agent SDK com ferramentas MCP reais. BridgeSpace/BridgeVoice tem outro foco: BridgeSpace e um command center nativo com terminal/agents/MCP; BridgeVoice e principalmente ditado/PTT robusto com Whisper local/cloud e injecao universal de texto via clipboard/acessibilidade, nao um agente completo de IDE.

Ha ainda um ponto operacional importante: o repo local esta em `0.10.2`, mas `/Applications/NexusIDE.app` reporta `0.10.1`. Os crash reports locais incluem uma falha do NexusIDE `0.10.1` em 2026-07-06. Antes de implementar novas features, P0 deve alinhar app instalado vs fonte, reproduzir os crashes e validar que as correcoes recentes de wake/live diagnostics realmente chegaram ao binario usado.

## 1.1 Metodologia e niveis de confianca

Este relatorio mistura tres niveis de certeza. Eles nao tem o mesmo peso e devem ser lidos de forma diferente:

| Fonte | Como foi analisada | Confianca |
|---|---|---|
| Nexus | codigo-fonte local completo (leitura direta dos arquivos) | Alta |
| Overclock | app instalado, sidecar JS (`dist/*.js`), `package.json`, `otool -L`, strings e logs locais | Media/Alta |
| BridgeSpace/BridgeVoice | app instalado, strings do binario, recursos locais e docs oficiais | Media |
| Docs externas (overclock.sh, bridgemind.ai) | contexto de produto, nao prova de runtime | Baixa/Media |

Regras de leitura:

- Afirmacoes sobre o Nexus vem do codigo e podem ser tratadas como fato verificavel.
- Afirmacoes sobre Overclock/Bridge sao inferencias a partir de artefato instalado (bundle/strings/sidecar), nao do codigo-fonte deles. Sao plausiveis, mas nao certezas.
- Recomendacoes (secoes 8 e 9) sao opiniao tecnica, nao fato observado.

Limites desta fase (repetidos no apendice): nao houve teste interativo de voz, benchmark real de latencia com cronometro, nem captura de tela. A latencia da secao 3.8 e estimada a partir do desenho e dos timeouts, nao medida.

## 2. Arquitetura atual do Nexus

### 2.1 Visao em 4 processos

Evidencia principal:

- `forge.config.ts`: define entradas Vite para `main`, `preload`, `pty-host` e renderer.
- `src/main/main.ts`: registra IPCs e servicos do app.
- `src/main/pty/pty-host-client.ts` e `src/main/pty/pty-host-entry.ts`: isolam PTY em `utilityProcess`.
- `docs/ARCHITECTURE.md`: documenta os processos e o desenho geral.

```text
NexusIDE.app (Electron)
|
|-- Main process
|   |-- lifecycle do app / BrowserWindow
|   |-- IPC seguro para renderer
|   |-- servidor MCP local 127.0.0.1
|   |-- gerenciador de PTY
|   |-- servicos de voz: STT, TTS, Jarvis brain, wake, live transport
|   |-- persistencia local / workspaces / billing / media / orchestration
|
|-- Renderer process
|   |-- React UI
|   |-- stores de workspace, panes, board, voz
|   |-- captura de mic via Web Audio/getUserMedia
|   |-- controller da Jarvis e executor de acoes de UI
|
|-- Preload
|   |-- ponte `window.nexus.*`
|   |-- valida superficie exposta ao renderer
|
|-- PTY host utilityProcess
    |-- carrega `@lydell/node-pty`
    |-- cria shells reais
    |-- devolve data/exit/status para main
```

O isolamento de PTY e um ponto forte: o renderer nao precisa carregar Node nem `node-pty`. O main aplica politica, autorizacao e roteamento; o host lida com a dependencia nativa.

### 2.2 Orquestracao e MCP

O Nexus tem um servidor MCP local em `src/main/orch/mcp-server.ts`, com URL/token injetados para agentes. Ele expoe ferramentas de panes, browser, workspace, media e dominio. Ha tambem autorizacao por pane em `src/main/orch/pane-authz.ts`, reduzindo risco de um worker manipular sessoes que nao deveria.

```text
Agent CLI pane
  -> recebe NEXUS_MCP_URL / token
  -> chama ferramentas MCP locais
  -> main valida permissao
  -> opera panes/browser/workspace
```

Isso e uma boa base para o futuro Jarvis Agente. O problema e que Jarvis ainda nao usa esse mesmo catalogo robusto de ferramentas; ela usa um schema pequeno e um `switch` no renderer.

Ponto que merece enfase (e a tese central do P2): o gap NAO e falta de ferramenta. O `mcp-server.ts` do Nexus ja expoe um catalogo rico, verificado em `src/main/orch/tools-domain.ts`, incluindo entre outros:

- `nexus_agent_invoke`, `nexus_agent_list`, `nexus_agent_get`;
- `nexus_task`, `nexus_route_task`, `nexus_todo_manager`;
- `nexus_mission_create/get/list/set_status/spawn_pane`;
- `nexus_browser_open/navigate/screenshot`;
- `nexus_preview_start/stop`;
- `nexus_remote_bridge_status/cli_detect/tmux_list/spawn`;
- `nexus_squad_save`, `nexus_catalog_install/overlay`, `nexus_recipe_propose`, `nexus_agent_spec_write`.

Ou seja: as ferramentas existem, tem autorizacao por pane e ja sao usadas por agentes CLI. O que falta e a Jarvis CONSUMIR esse mesmo catalogo em vez de manter um `switch` paralelo de 9 acoes no renderer.

### 2.3 Voz/Jarvis - fluxo atual

```text
PTT / wake word
  -> renderer: wake mic / command capture
  -> main: `voice:transcribe`
  -> STT batch: Groq Whisper -> OpenAI Whisper -> local whisper
  -> main: `voice:jarvis`
  -> Jarvis brain: Gemini -> OpenAI -> Groq
  -> renderer: `runJarvisTurn`
  -> executor local de acoes
  -> main/renderer: TTS OpenAI -> Piper -> macOS say
```

Fluxo Live opcional:

```text
renderer frame tap
  -> main: live transport controller
  -> Gemini Live WSS
  -> audio/transcricoes/eventos
  -> fallback Classic em erro

Mas: action bridge realtime esta desligado no renderer.
```

## 3. Estado atual da Jarvis

### 3.1 Captura de audio

O renderer captura audio por `getUserMedia` e Web Audio. O wake mic usa stream mono 16 kHz e frames de 80 ms, com watchdog/rearm:

- `src/renderer/voice/wake-mic.ts`: captura sempre ativa quando wake esta ligado, frame tap para Live e rearm em morte de stream.
- `src/renderer/voice/wake-rearm.ts`: backoff rapido e depois rearm lento infinito.
- `src/main/voice/wake-engine.ts`: wake local via modelo ONNX/openWakeWord.

O default de configuracao ainda deixa wake word desativado:

- `src/shared/voice-config.ts:264`: `wakeWord: { enabled: false }`.

### 3.2 STT

O STT Classic e batch, nao streaming:

- `src/shared/voice-config.ts:296-328`: default `groq` com `whisper-large-v3-turbo`, fallback `openai` `whisper-1`, depois `local-whisper`.
- `src/shared/voice-config.ts:305`: `streaming: false`.
- `src/main/voice/stt-service.ts`: envia arquivo de audio multipart para `/audio/transcriptions` ou `/audio/translations`.
- `src/main/voice/stt-service.ts`: fallback local escreve WAV temporario e chama `whisper-cli`.

Consequencia: a Jarvis so entende a fala depois que a gravacao termina. Isso impede uma experiencia "real-time agent" na rota Classic.

### 3.3 Brain/modelos

O brain padrao usa chat completions, com fallback:

- `src/shared/voice-config.ts:275-295`: Gemini `gemini-3.5-flash`, fallback OpenAI `gpt-4o-mini`, fallback Groq `llama-3.3-70b-versatile`.
- `src/main/voice/jarvis-brain.ts:295`: timeout interno do brain em 15 s.
- `src/main/voice/jarvis-brain.ts`: prompt exige JSON estrito com `say`, `expectReply` e `action`.

O modelo nao recebe imagem, screenshot, DOM real ou arvore de acessibilidade. Recebe texto contextual.

### 3.4 Acoes

O catalogo atual da Jarvis e pequeno e vive em `src/shared/voice-ipc.ts:209-219`:

```ts
type JarvisAction =
  | { type: 'none' }
  | { type: 'open_squad'; squadName: string }
  | { type: 'open_workspace'; workspaceName: string }
  | { type: 'design_squad' }
  | { type: 'new_mission' }
  | { type: 'open_terminal' }
  | { type: 'close_pane' }
  | { type: 'open_board' }
  | { type: 'send_to_pane'; text: string }
  | { type: 'run_command'; command: string };
```

O executor fica no renderer:

- `src/renderer/voice/voice-controller.ts:733-915`: `switch` de acoes.
- `src/renderer/voice/voice-controller.ts:870-914`: `run_command` abre/foca shell e pede confirmacao nativa antes de escrever comando.

Isso e bom para seguranca inicial, mas ainda nao e um framework de tool-use. Falta:

- registry centralizado de acoes com schemas Zod;
- capacidades/permissoes por acao;
- confirmacao por risco;
- observabilidade por action id;
- reaproveitamento das ferramentas MCP ja existentes;
- execucao multi-step com estado.

Reforcando: o item "reaproveitamento das ferramentas MCP ja existentes" e o mais importante. O Nexus ja tem o catalogo `nexus_*` (secao 2.2). O problema nao e ausencia de tools; e a Jarvis ainda nao ser cliente desse catalogo. A afirmacao correta do gap e: "a Jarvis ainda nao consome o sistema de ferramentas que o Nexus ja tem", nao "o Nexus nao tem ferramentas".

### 3.5 Realtime

Evidencia principal:

- `src/renderer/voice/voice-controller.ts:41`: `REALTIME_ACTION_BRIDGE_ENABLED = false`.
- `src/renderer/voice/voice-controller.ts:86-88`: comentario diz que Gemini Live ainda nao e action-capable e que a rota de producao fica Classic.
- `src/renderer/voice/voice-controller.ts:517`: `realtimeTurnActive = REALTIME_ACTION_BRIDGE_ENABLED && isRealtimeLive()`.
- `src/renderer/voice/voice-controller.ts:538-596`: quando realtime nao esta ativo, finaliza captura e chama `window.nexus.voice.transcribe`.

Conclusao: mesmo com `jarvisLive.transport = gemini-live`, a ponte realtime que permitiria transformar fala em acoes do Nexus esta desligada. O usuario pode perceber recursos Live, mas a operacao real do app ainda passa por batch/action posterior.

### 3.6 Leitura de tela

O que existe:

- `src/renderer/voice/voice-controller.ts:153`: `currentScreenSnapshot()` monta texto com workspace, panes, arquivos recentes, board e settings.
- `src/renderer/voice/voice-controller.ts:686-690`: esse texto entra no contexto da Jarvis.
- `src/shared/voice-ipc.ts:234`: `screen` limitado a 500 caracteres.

O que nao encontrei para Jarvis:

- `desktopCapturer`;
- `getDisplayMedia` para screen share;
- captura da BrowserWindow principal;
- arvore de acessibilidade do Electron/macOS AX;
- OCR;
- chamada a modelo de visao;
- leitura visual de terminal/editor/canvas.

Ha screenshot para browser panes:

- `src/main/browser/browser-manager.ts:227`: `wc.capturePage()`.
- `src/main/orch/tools-domain.ts:785`: ferramenta `nexus_browser_screenshot`.

Mas isso e ferramenta de browser pane para agentes, nao leitura da tela do Nexus pela Jarvis.

### 3.7 Interrupcao / barge-in

Ha suporte parcial:

- `src/main/voice/tts-service.ts`: `stopSystemSpeech()` interrompe o fallback macOS `say`.
- Existe IPC de speak stop no modulo de voz.
- O renderer tem fila/player para audio realtime.

O que falta para uma experiencia Jarvis realtime:

- barge-in consistente durante TTS cloud/audio element;
- cancelamento de turn em andamento;
- VAD que detecta fala do usuario enquanto a Jarvis fala;
- AEC/echo control robusto;
- politica clara: interromper fala, cancelar tool call, ou continuar execucao.

### 3.8 Latencia estimada

Nao medi audio com cronometro nesta fase; a estimativa vem do desenho e dos timeouts:

- STT cloud: ate 12 s em `src/main/voice/stt-service.ts`.
- brain: ate 15 s em `src/main/voice/jarvis-brain.ts:295`.
- deadlines do renderer: transcribe 60 s, brain 35 s, speak 40 s em `src/renderer/voice/voice-controller.ts`.
- TTS cloud: ate 15 s em `src/main/voice/tts-service.ts`.

Na rota Classic, a primeira resposta real normalmente so pode vir depois de fim da fala + upload/transcricao + brain + inicio do TTS. Latencia percebida provavel: 2,5 s a 6 s em rede boa; pior caso de codigo: dezenas de segundos. Isso nao atende a meta P1 de `<500 ms` sem audio-to-audio streaming.

Ressalva de metodologia: os numeros acima sao estimativa de desenho, nao medicao. Antes de tratar "Jarvis esta lenta" como fato, instrumentar o pipeline com marcos e um trace por turno:

```text
mic_start
speech_start
speech_end
partial_transcript
final_transcript
brain_start
tool_call
tool_done
first_audio
tts_done
turn_done
```

Metricas derivadas a medir por cenario (rede boa / rede ruim / local):

| Metrica | Como calcular | Alvo |
|---|---|---|
| tempo ate transcript final | speech_end -> final_transcript | depende do provider |
| tempo ate primeiro feedback | speech_end -> first_audio ou ack visivel | `<500 ms` (ack, ver P1) |
| duracao da acao | tool_call -> tool_done | por tipo de acao |
| turno completo | speech_start -> turn_done | por cenario |

Sem esses marcos, qualquer meta de latencia (inclusive a `<500 ms`) e inauditavel.

## 4. Analise Overclock

### 4.1 Bundle e arquitetura inferida

App instalado:

- `/Applications/Overclock.app`
- Bundle id: `sh.overclock.app`
- Versao instalada: `1.0.4`
- Executavel: `overclock`
- Permissao de microfone: "ClockVoice - ditado por voz que vira comandos e prompts."

Nao ha `app.asar` nem Electron Framework. O bundle contem executavel nativo e um sidecar Node em:

- `/Applications/Overclock.app/Contents/Resources/sidecar/`

Dependencias observadas no sidecar:

- `@anthropic-ai/claude-agent-sdk`
- `@modelcontextprotocol/*`
- `@lydell/node-pty`
- `express`
- `ws`
- `zod`
- `@tauri-apps/*`

`otool -L` mostra frameworks macOS como AppKit, WebKit, OSAKit, Security, AudioToolbox, CoreAudio, ApplicationServices e CoreGraphics. A inferencia mais segura: app nativo/Tauri-like com sidecar Node para agentes/PTY/MCP.

### 4.2 Voice agent

Arquivos-chave no sidecar:

- `JarvisService.js`
- `GeminiLiveSession.js`
- `core.js`

Achados:

- `JarvisService.js`: motor agentico para o sidecar, com streaming via Claude Agent SDK e ferramentas MCP do Overclock.
- `GeminiLiveSession.js`: transporte full-duplex via Gemini Live WSS.
- `core.js`: handlers IPC `jarvis:send`, `jarvis:screen`, `jarvis:live:start/stop/mic/endTurn`.

Overclock separa melhor dois planos:

```text
voz realtime
  -> Gemini Live
  -> funcoes grossas de voz
  -> delegar trabalho real
  -> Claude Agent SDK + MCP tools
  -> opera cockpit/panes/missoes
```

Evidencia especifica:

- `GeminiLiveSession.js`: envia mic chunks por `realtimeInput.audio`.
- `GeminiLiveSession.js`: setup declara funcoes de voz como `delegar`, `consultar`, `ler`, `navegar`, `encerrar`, `comandar`, `restaurar`, `perguntar`.
- `JarvisService.js`: `runLiveFunction` trata funcoes live; `delegar` enfileira trabalho no Agent SDK e retorna ack rapido.
- `JarvisService.js`: screen context inclui estado deterministico da tela, panes visiveis, pane focado, home/workspace/mission.

Isso e mais perto do objetivo desejado que o Nexus atual: a voz nao precisa executar tudo sozinha; ela delega para o mesmo framework agentico que ja opera o app.

### 4.3 Features observadas por codigo/log/docs

- Cockpit multi-agent para Claude/Codex/Gemini/MIMO.
- Multi-pane terminal/agents.
- ClockVoice push-to-talk em PT-BR.
- Transcricao realtime/multilingue no plano Boost Pro.
- MCP local para operacao do cockpit.
- Navegacao de UI por ferramentas (`mission-new`, workspace open/create, tab close/next/prev/switch, pane focus).
- Logs locais mostram MCP server iniciado em `127.0.0.1`, deteccao de provedores (`claude`, `codex`, `gemini`, `kimi`, `antigravity`) e update para `1.0.4`.

Docs oficiais consultadas:

- `https://overclock.sh`
- `https://overclock.sh/clockvoice`

Limite desta fase: nao capturei screenshot nem fiz teste manual de comando de voz no Overclock para nao interferir em permissoes/sessoes do usuario. A evidencia acima veio de bundle, logs e docs oficiais.

## 5. Analise BridgeSpace + BridgeVoice

### 5.1 BridgeSpace

App instalado:

- `/Applications/BridgeSpace.app`
- Bundle id: `io.bridgemind.bridgespace`
- Versao instalada: `3.4.9`
- Executavel: `bridgespace-tauri`

Nao ha `app.asar`. `strings` e `otool` indicam app nativo/Tauri/Wry com WebKit, AppKit, OSAKit, AudioUnit/CoreAudio, ApplicationServices e componentes de terminal/agent.

Achados por strings:

- `portable-pty`, terminal create/destroy, shell integration.
- `mcp.json`, MCP SDK, `bridgememory-mcp`, deteccao de tools MCP.
- suporte a `claude`, `codex`, perfis de conta e token usage.
- mobile bridge em `0.0.0.0`, endpoint `/commands`.
- comandos `bridge_agent_voice_start/stop/cancel`.
- integracao com BridgeVoice por arquivo/token (`bridgevoice-inject.json`, `BRIDGEVOICE_INJECT_TOKEN`).

Docs oficiais:

- `https://docs.bridgemind.ai/docs/bridgespace`
- `https://www.bridgemind.ai/products/bridgespace`

Interpretacao: BridgeSpace e o IDE/command center. Ele tem terminal, editor/file browser, agents, prompts e MCP. A voz parece existir como integracao, mas a parte forte de voz esta em BridgeVoice.

### 5.2 BridgeVoice

App instalado:

- `/Applications/BridgeVoice.app`
- Bundle id: `com.bridgemind.bridgevoice`
- Versao instalada: `2.8.1`
- Executavel: `bridgevoice`
- Recursos locais: pasta `models`

Achados:

- `src/commands/transcription.rs`, `src/transcription/groq.rs`, `src/transcription/whisper.rs`, `src/audio/capture.rs`.
- Modos local/cloud: Whisper local, Groq, Together Whisper, Fireworks, Parakeet.
- Arquivo local em Application Support: `models/ggml-base.en.bin` (~148 MB).
- Config local observada: `mode: local`, hotkey `Cmd+Shift+Space`, push-to-talk `Function`.
- Injecao universal: `transcribe_and_inject`, clipboard, `AXFocusedPaste`, `AXFocusedApplication`, `AXFocusedWindow`, `AXFocusedUIElement`.
- Diagnosticos robustos de permissao: `ptt_diagnostics.txt` registra Accessibility/Input Monitoring, tap instalado, watchdog e recriacao.
- Recuperacao de microfone: strings indicam silent-death recovery, failover microphone e ring buffer.

Docs oficiais:

- `https://docs.bridgemind.ai/docs/bridgevoice`
- `https://www.bridgemind.ai/products/bridgevoice`

Interpretacao: BridgeVoice nao parece ser um "Jarvis agent" de IDE. Ele e um ditado/PTT robusto com injecao no app focado. O valor para o Nexus esta em copiar os padroes de confiabilidade: diagnostico de hotkey/permissoes, fallback local, recuperacao de microfone e injecao/acessibilidade.

### 5.3 Diferenca BridgeSpace vs BridgeVoice

| Produto | Papel principal | Voz | Agente |
|---|---|---|---|
| BridgeSpace | command center/IDE nativo | integracao com voice | agents/terminal/MCP |
| BridgeVoice | dictation/PTT universal | forte: STT local/cloud + injecao | nao evidenciado como agente multi-step |
| Combo | voz para operar apps por texto/injecao | robusta | depende do app alvo/BridgeSpace |

## 6. Inventario de bugs e riscos observados

| Severidade | Item | Evidencia | Impacto | Proximo passo |
|---|---|---|---|---|
| Alto/Critico | App instalado esta atras do repo | `package.json` = `0.10.2`; `/Applications/NexusIDE.app` = `0.10.1` | usuario testa uma versao diferente da fonte analisada; isolado e Alto, mas Critico/P0 AQUI porque contamina a triagem do crash e invalida teste manual | gerar/instalar build assinado de `0.10.2` depois de aprovacao; nao nesta task |
| Critico | Crash report recente no app instalado | `~/Library/Logs/DiagnosticReports/NexusIDE-2026-07-06-181134.ips`, versao `0.10.1`, `EXC_BREAKPOINT/SIGTRAP` | quebra de confiabilidade basica | simbolizar/triangular crash; reproduzir no app instalado |
| Alto | Jarvis nao executa acoes em realtime | `REALTIME_ACTION_BRIDGE_ENABLED = false`; comentario diz Live nao action-capable | sintoma principal do usuario | P1/P2: conectar Live a action/tool framework |
| Alto | Jarvis nao le tela visualmente | so `currentScreenSnapshot()` textual; sem screen capture/AX/OCR/vision | comandos dependentes do que esta na tela falham | P3: capturar tela + AX tree + vision/OCR |
| Alto | Action framework limitado | schema com 9 acoes e switch no renderer | nao opera "todo Nexus" | P2: registry de tools/actions e reuse MCP |
| Alto | Wake/live historicamente instavel | commits recentes `47b1e23` e `db94187` focam live diagnostics e wake mic | melhorias recentes ainda precisam validar no app instalado | validar `0.10.2` no app real |
| Medio | Latencia Classic alta | STT/TTS batch e timeouts longos | experiencia parece lenta, nao conversacional | P1: streaming ASR/audio-to-audio/VAD |
| Medio | Screen context curto | `screen` max 500 chars no IPC | contexto perde detalhes de pane/editor/terminal | ampliar com snapshots estruturados |
| Medio | Confirmacao de `run_command` pode parecer falha | comando exige dialog nativo antes de escrever no shell | usuario pode achar que Jarvis nao fez nada | UX de confirmacao visivel no HUD + historico |
| Medio | Observabilidade de voz ainda recente | modulo de logs existe, mas precisa validar com sessao real | dificil diagnosticar "nao ouviu", "nao entendeu", "nao agiu" | painel de diagnostico de voz |
| Baixo | TODO real em cost store | `src/renderer/state/cost-store.ts:9` fala que `window.nexus.cost` nao existe | custo/telemetria pode estar incompleto | tratar fora do caminho Jarvis |

Observacao: `npm run typecheck` passou no repo atual `0.10.2`. A prioridade nao e mais corrigir TypeScript; e alinhar artefato instalado, reproduzir crash e validar regressao.

## 7. Gap analysis

A coluna Confianca segue a secao 1.1: Alta = observado no codigo/artefato de forma direta; Media = inferido de bundle/strings/sidecar; Baixa = so de docs/produto.

| Feature | Nexus atual | Overclock | BridgeSpace/Voice | Gap | Confianca |
|---|---|---|---|---|---|
| IDE multi-agent | Sim, Electron + MCP + panes | Sim, cockpit multi-agent | Sim, command center/agents | Nexus tem base competitiva | Alta (Nexus) / Media (outros) |
| PTY isolado | Sim, utilityProcess | Sim, sidecar/node-pty | Sim, portable-pty | Paridade boa | Alta (Nexus) / Media (outros) |
| MCP local | Sim | Sim | Sim | Paridade, mas Jarvis nao reutiliza bem | Alta (Nexus) / Media (outros) |
| Voice PTT | Sim | Sim, ClockVoice | Sim, BridgeVoice | Nexus existe, precisa robustez/UX | Alta (Nexus) / Media (outros) |
| Wake word | Sim, default off | Evidencia de wake/live warm reuse | BridgeVoice e mais hotkey/PTT | Nexus precisa validar rearm/permissoes | Alta (Nexus) / Media (outros) |
| STT realtime | Nao na rota Classic; Live opcional | Sim via Gemini Live/ClockVoice | Principalmente local/cloud batch robusto | Nexus P1 | Alta (Nexus) / Media (outros) |
| Audio full-duplex | Opcional `gemini-live` | Sim, `GeminiLiveSession` | Nao evidenciado como agente full-duplex | Nexus P1 | Alta (Nexus) / Media (Overclock) |
| Acoes por voz | Pequeno switch no renderer | Funcoes Live + delegacao Agent SDK + MCP | Injecao de texto/BridgeSpace integration | Nexus P2 | Alta (Nexus) / Media (outros) |
| Leitura de tela | Texto deterministico curto | Screen context estruturado e atualizado | Accessibility para injecao/foco | Nexus P2.5 (semantico) e P3 (vision) | Alta (Nexus) / Media (outros) |
| Visao/OCR | Nao encontrado | Nao comprovado como vision, mas screen context melhor | Nao foco principal | Nexus P3 | Alta (Nexus) / Media (outros) |
| Confirmacao de comandos | Sim para `run_command` | Ferramentas sensiveis mapeadas; UI atual parece sem confirmBeforeTools | BridgeVoice injeta texto | Nexus deve manter confirmacao por risco | Alta (Nexus) / Media (outros) |
| Diagnosticos de voz | Em evolucao | Logs sidecar/MCP | Forte em PTT/permissoes/watchdog | Nexus deve copiar BridgeVoice | Alta (Nexus) / Media (outros) |
| App instalado vs fonte | Divergente: 0.10.1 vs 0.10.2 | Instalado 1.0.4 | Instalados recentes | Nexus P0 | Alta |

## 8. Plano priorizado P0 -> P4

### P0 - Estabilidade que bloqueia uso

Objetivo: garantir que o usuario testa o mesmo Nexus que estamos analisando e eliminar crashes basicos.

Subtarefas:

1. Alinhar artefato instalado com repo.
   - Fonte atual: `0.10.2`.
   - App instalado: `0.10.1`.
   - Acao: gerar instalavel/DMG somente apos aprovacao do usuario; nesta fase nao rodamos build.

2. Triangular crash reports.
   - Arquivos: `~/Library/Logs/DiagnosticReports/NexusIDE-2026-07-06-181134.ips` e anteriores.
   - Sintoma: `EXC_BREAKPOINT/SIGTRAP`, faulting thread 4.
   - Acao: simbolizar com mapa de artefato, correlacionar com logs Electron/main.

3. Validar wake/live fixes no app real.
   - Commits recentes: `47b1e23 fix(voice): harden Jarvis live diagnostics`, `db94187 fix(voice): wake mic nunca mais morre sozinho + observabilidade`.
   - Acao: sessao hands-on com wake/PTT por 20-30 min, fechar/abrir app, trocar microfone, sleep/wake.

4. Criar painel minimo de diagnostico de voz se ainda nao estiver exposto.
   - Eventos: mic permission, input monitoring, accessibility, wake lock holder, live transport state, STT provider active, TTS provider active, last action.

Arquivos/modulos afetados depois de aprovada implementacao:

- `src/main/window.ts`
- `src/main/voice/*`
- `src/renderer/voice/*`
- `src/renderer/components/VoiceSettings.tsx`
- packaging/release docs

Riscos:

- crash pode vir de Electron/native module e exigir simbolizacao/build local;
- diferenca app/fonte pode mascarar bug ja corrigido.

Aceite:

- app instalado reporta mesma versao do repo;
- sem crash em 1h de uso basico;
- wake/PTT sobrevive a idle/sleep/mic disconnect;
- diagnostico mostra causa clara quando mic/permission/provider falha.

### P1 - Jarvis Realtime

Objetivo: transformar a conversa de voz em baixa latencia real, com streaming e interrupcao.

Subtarefas:

1. Escolher transporte realtime principal via spike comparativo (nao decidir no papel).
   - Opcao A: OpenAI Realtime API para audio-to-audio, tool calls e barge-in.
   - Opcao B: Gemini Live, aproveitando codigo existente.
   - Nota: o Overclock demonstra Gemini Live funcionando com function declarations (`delegar/consultar/ler/navegar/comandar/perguntar`) e delegacao para o brain. Isso indica que o `REALTIME_ACTION_BRIDGE_ENABLED = false` do Nexus pode ser so a ponte de actions ainda nao implementada, nao uma limitacao do Gemini Live. Por isso NAO escolher provider antes de medir.
   - Fazer um spike curto das duas opcoes e decidir com base em: latencia (marcos da secao 3.8), qualidade do barge-in, estabilidade/reconexao, custo por turno, facilidade de tool-use, streaming de transcript e modelo de confirmacao de acoes. So depois eleger rota principal + fallback.

2. Substituir turn Classic por streaming quando Live esta ativo.
   - Remover dependencia de `REALTIME_ACTION_BRIDGE_ENABLED = false`.
   - Conectar eventos de transcript partial/final e response audio ao estado da UI.

3. VAD e end-of-turn.
   - Implementar WebRTC VAD/Silero no renderer ou main.
   - Definir tempos: start speech, endpointing, silence max, cancel.

4. TTS interruptivel.
   - Unificar stop para macOS `say`, audio element/cloud e audio realtime.
   - Barge-in deve pausar fala e iniciar novo turn.

5. Echo/AEC.
   - Usar constraints de `getUserMedia` (`echoCancellation`, `noiseSuppression`) e janela de echo suppression existente.
   - Medir vazamento da propria voz no STT.

Arquivos/modulos afetados:

- `src/renderer/voice/voice-controller.ts`
- `src/renderer/voice/wake-mic.ts`
- `src/main/voice/live-transport-controller.ts`
- `src/main/voice/gemini-live-transport.ts`
- novo `src/main/voice/openai-realtime-transport.ts` se aprovado
- `src/shared/voice-config.ts`
- `src/shared/voice-ipc.ts`

Riscos:

- custo e estabilidade de provider realtime;
- permissoes de microfone no macOS;
- barge-in pode cancelar acoes sensiveis no meio;
- meta `<500 ms` so e realista com audio-to-audio/realtime, nao com Whisper batch.

Aceite:

- meta `<500 ms` = PRIMEIRO feedback (ack audivel ou visual) apos endpointing, NAO conclusao da acao. Completar tool-use/comando de terminal/navegacao/execucao de agente em `<500 ms` nao e realista; acoes longas recebem ack imediato e follow-up ao terminar;
- primeiro feedback (ack) em `<500 ms` apos fim da fala em rede normal; acoes simples iniciadas em ate ~1 s;
- partial transcript visivel em tempo real;
- usuario interrompe a Jarvis durante TTS e novo turn inicia;
- fallback Classic automatico quando provider realtime falha.

### P2 - Jarvis Agente (acoes)

Objetivo: fazer a Jarvis operar o Nexus como agente, nao como switch pequeno de comandos.

Subtarefas:

1. Criar registry de actions.
   - Cada acao com nome, descricao, schema Zod, risco, permissao, executor e criterio de sucesso.
   - Separar acoes idempotentes, navegacao, escrita, shell, git, destrutivas.

2. Reutilizar MCP/tools existentes.
   - A Jarvis deve poder chamar ferramentas internas equivalentes a `nexus_pane_*`, browser, workspace e board.
   - Evitar duplicar logica no renderer quando o main/MCP ja tem autorizacao.

3. Tool-use no provider realtime.
   - Declarar tools no OpenAI Realtime ou Gemini Live.
   - Roteador converte tool calls em actions Nexus.
   - Resposta deve incluir ack rapido + follow-up apos execucao.

4. Catalogo inicial de acoes Nexus.
   - abrir/fechar/focar pane;
   - abrir arquivo;
   - buscar arquivo;
   - criar workspace;
   - abrir board;
   - iniciar squad/missao;
   - enviar texto ao orchestrator;
   - rodar comando no terminal com confirmacao;
   - git status/diff/commit assistido;
   - abrir browser pane e screenshot;
   - ler logs/diagnostico.

5. Confirmacao por risco.
   - Low: navegar/focar/ler.
   - Medium: escrever em pane, criar arquivo, rodar comando read-only.
   - High: comandos destrutivos, git push, delete, install, network auth.

Arquivos/modulos afetados:

- novo `src/main/voice/actions/*`
- `src/main/orch/tools-*.ts`
- `src/main/orch/pane-authz.ts`
- `src/shared/voice-ipc.ts`
- `src/renderer/voice/voice-controller.ts`
- `src/renderer/components/*` para confirmacoes/HUD

Riscos:

- escalada de permissao por voz;
- comando ambíguo executando acao errada;
- tool calls duplicando logica MCP;
- UX de confirmacao lenta.

Aceite:

- Jarvis executa pelo menos 20 acoes reais com logs estruturados;
- cada action tem teste unitario de schema/executor;
- acoes high-risk exigem confirmacao visivel;
- erro de action vira mensagem clara e nao quebra a sessao de voz.

### P2.5 - Semantic screen context (contexto estruturado antes de pixels)

Objetivo: dar a Jarvis um contexto de tela CONFIAVEL sem depender de screenshot/OCR/vision. Para um IDE proprio, a Jarvis nao precisa "ver pixels" primeiro; ela precisa saber estruturalmente o que esta na tela. Isso e mais barato, mais rapido e mais seguro que OCR, e por isso vem antes do P3.

Motivacao: hoje o `currentScreenSnapshot()` gera texto e o IPC corta `context.screen` em 500 caracteres (`src/shared/voice-ipc.ts:234`). E suficiente para uma nocao grossa, mas perde detalhe de pane/editor/terminal.

Subtarefas:

1. Substituir o snapshot textual curto por um contexto estruturado do renderer:
   - workspace atual;
   - pane focado e seu tipo (shell/editor/browser/board);
   - arquivo aberto no editor;
   - modal/drawer/wizard ativo;
   - terminal ativo e selecao;
   - lista de panes visiveis com ids (padrao Overclock: `PANES VISIVEIS`, ver `JarvisService.updateScreen`);
   - acoes possiveis no estado atual;
   - confirmacoes pendentes.

2. Elevar/estruturar o campo `screen` no IPC: alem do texto de 500 chars, passar um objeto estruturado (ou aumentar o limite de forma controlada) para o brain/live.

3. Alimentar tanto a rota Classic quanto o transporte realtime com o mesmo contexto estruturado (`getJarvisContext()` da secao P3 pode nascer aqui, primeiro so com o nivel semantico).

Arquivos/modulos afetados:

- `src/renderer/voice/voice-controller.ts` (`currentScreenSnapshot`)
- `src/shared/voice-ipc.ts` (schema de `context.screen`)
- stores do renderer (layout/panes/files/editor)

Aceite:

- Jarvis responde "o que esta aberto/focado?" a partir de estado real do renderer, sem screenshot;
- Jarvis resolve um pane por id/numero dito pelo usuario (ex. "331");
- contexto estruturado aparece no diagnostico de voz.

### P3 - Jarvis Vision (le tela)

Objetivo: dar a Jarvis contexto VISUAL (pixels) do Nexus quando o contexto semantico (P2.5) nao basta. P3 pressupoe P2.5 pronto: screenshot/OCR/vision sao o nivel caro, sob demanda, nao o padrao.

Subtarefas:

1. Captura visual da janela Nexus.
   - Para propria BrowserWindow: avaliar `webContents.capturePage()`.
   - Para tela/app: avaliar `desktopCapturer`/`getDisplayMedia`.
   - Em macOS nativo: avaliar ScreenCaptureKit quando Electron nao for suficiente.

2. Arvore semantica/acessibilidade.
   - Expor estado estruturado do renderer: tela atual, foco, tabs, panes, terminal selection, editor file, modals.
   - Investigar APIs AX macOS para foco/janela, principalmente se quiser operar fora do Nexus.

3. Vision model.
   - Enviar screenshot comprimido para modelo multimodal quando necessario.
   - Usar OCR fallback para texto pequeno em terminal/editor.
   - Cache/diff para reduzir custo.

4. Politica de privacidade.
   - Indicador visual quando screen capture esta ativo.
   - Lista de janelas permitidas.
   - Redacao de segredos em terminal/editor quando possivel.

5. API de contexto unificada.
   - `getJarvisContext()` retorna:
     - snapshot textual estruturado;
     - screenshot opcional;
     - accessibility/semantic tree;
     - foco atual;
     - timestamp e hashes.

Arquivos/modulos afetados:

- novo `src/main/voice/screen-context/*`
- `src/main/window.ts`
- `src/preload/preload.ts`
- `src/renderer/voice/voice-controller.ts`
- stores do renderer para contexto semantico
- possivel modulo nativo se usar ScreenCaptureKit

Riscos:

- permissoes macOS de Screen Recording/Accessibility;
- vazamento de dados sensiveis para provider externo;
- custo/latencia de vision;
- screenshots podem ficar obsoletos rapidamente.

Aceite:

- Jarvis responde corretamente "o que esta aberto/focado?" com base em tela real;
- Jarvis consegue clicar/navegar/focar elemento visivel por comando;
- screenshot/AX context aparece em diagnostico;
- usuario pode desligar vision e apagar snapshots.

### P4 - Paridade com Overclock/Bridge

Objetivo: copiar o que realmente melhora o Nexus, nao clonar tudo.

Subtarefas:

1. Do Overclock:
   - padrao Live voice -> funcoes grossas -> delegar para Agent SDK/MCP;
   - screen context atualizado/debounced;
   - warm/dormant Live session;
   - navegacao de cockpit via tools;
   - ack rapido para `delegar`.

2. Do BridgeVoice:
   - diagnostics de PTT/Input Monitoring/Accessibility;
   - fallback local Whisper confiavel;
   - recuperacao de microfone silenciosamente morto;
   - historico de transcricao;
   - injecao universal opcional se Nexus quiser ditado fora do app.

3. Do BridgeSpace:
   - templates/workflows de workspace;
   - integracao mais forte entre prompts, agents e terminal;
   - mobile bridge, se ainda for prioridade de produto.

Arquivos/modulos afetados:

- `src/main/voice/*`
- `src/renderer/voice/*`
- `src/main/orch/*`
- `src/renderer/components/VoiceSettings.tsx`
- possivel novo painel `VoiceDiagnostics`

Riscos:

- copiar features que nao resolvem o problema central;
- aumentar complexidade sem estabilidade;
- dependencias/provider lock-in.

Aceite:

- tabela de paridade revisada com usuario;
- pelo menos 3 fluxos end-to-end: "abrir workspace", "rodar comando confirmado", "ler tela e agir";
- diagnosticos comparaveis ao BridgeVoice para permissoes/mic/hotkey.

### 8.1 Backlog ticketavel (ordem de execucao)

O P0->P4 acima e direcao estrategica. Para virar trabalho de engenharia, quebrar em tickets pequenos, cada um com feature flag, teste minimo e criterio de aceite. Ordem sugerida:

```text
P0.1 alinhar app instalado com o repo (build assinado 0.10.2, apos aprovacao)
P0.2 simbolizar e reproduzir o crash EXC_BREAKPOINT/SIGTRAP do 0.10.1
P0.3 painel minimo de diagnostico de voz (mic/wake/live/STT/TTS/action/permissao)
P1.1 spike Gemini Live vs OpenAI Realtime (medir latencia/barge-in/custo/tool-use)
P1.2 instrumentar marcos de latencia (secao 3.8) e trace por turno
P1.3 ligar transporte realtime escolhido + remover dependencia de REALTIME_ACTION_BRIDGE_ENABLED
P1.4 VAD/end-of-turn + TTS interruptivel (barge-in) + AEC
P2.1 voice action registry (nome, schema Zod, risco, executor, criterio de sucesso)
P2.2 integrar Jarvis ao catalogo MCP existente (nexus_*) em vez do switch do renderer
P2.3 tool-use no provider realtime + confirmacao por risco (low/medium/high)
P2.5 semantic screen context (estado estruturado do renderer, sem pixels)
P3.1 screenshot/OCR/vision sob demanda, com indicador de captura e permissao explicita
P4.x paridade seletiva (Overclock: warm/dormant live, ack rapido; BridgeVoice: mic recovery/diagnostics)
```

Modelo de ticket (usar para cada item acima):

```md
Titulo: <ex. P2.1 Voice Action Registry>
Entregaveis: <arquivos exatos criados/alterados>
Feature flag: <nome do flag; default off>
Testes minimos: <casos AAA, incluindo edge cases>
Telemetria: <eventos/marcos emitidos>
Aceite: <condicoes verificaveis>
Rollback: <como desligar sem quebrar a sessao>
```

## 9. Recomendacoes tecnicas

1. Nao tentar fazer "realtime" com Whisper batch.
   - Whisper batch continua como fallback.
   - Realtime deve ser transporte separado: OpenAI Realtime API ou Gemini Live.

2. Transformar Jarvis em consumidora do mesmo sistema de tools dos agentes.
   - O Nexus ja tem MCP local e autorizacao de panes.
   - A Jarvis deve chamar actions/tools com schemas, nao manter um switch paralelo crescente.

3. Usar dois niveis de contexto de tela.
   - Nivel barato: snapshot semantico estruturado do renderer.
   - Nivel caro: screenshot + vision/OCR sob demanda.

4. Separar dictation de agent mode.
   - BridgeVoice mostra que ditado precisa ser extremamente robusto.
   - Jarvis agent precisa de tool-use, confirmacao e memoria de turn.
   - Misturar os dois sem modo explicito aumenta comandos acidentais.

5. Manter confirmacao para comandos de terminal.
   - `run_command` com confirmacao e correto.
   - Melhorar o HUD para mostrar que a Jarvis esta aguardando confirmacao.

6. Adotar diagnostico permanente de voz.
   - Status de mic, wake, live, STT, TTS, action, provider e permissao.
   - Exportar bundle de diagnostico para debug.

7. Criar metricas de latencia.
   - `mic_start`, `speech_start`, `speech_end`, `partial_transcript`, `final_transcript`, `tool_call`, `tool_done`, `first_audio`, `tts_done`.
   - Sem isso, "Jarvis esta lenta" vira opiniao.

## 10. Riscos e questoes abertas

Questoes para decisao do usuario:

1. Provider realtime principal: OpenAI Realtime, Gemini Live, ou hibrido?
2. Jarvis deve operar apenas dentro do Nexus ou tambem apps externos?
3. A leitura de tela pode enviar screenshots para provider cloud?
4. Quais acoes precisam confirmacao sempre? Terminal, git, delete, install, billing?
5. Qual idioma principal da Jarvis: PT-BR sempre, ou PT-BR/EN automatico?
6. Queremos wake word sempre ativo por default ou so PTT por seguranca?
7. BridgeVoice-style dictation deve ser embutido no Nexus ou ficar fora do escopo?

Riscos tecnicos:

- permissoes macOS de Microphone, Accessibility, Input Monitoring e Screen Recording podem bloquear experiencias "magicas";
- audio realtime aumenta custo e dependencia de rede;
- vision pode vazar dados sensiveis se nao houver redacao/consentimento;
- agente de voz com terminal pode causar dano se confirmacao/risk policy falhar;
- manter Gemini Live e OpenAI Realtime ao mesmo tempo duplica complexidade.

## Apendice - Evidencias principais

### Comandos locais relevantes

- `npm run typecheck`: passou em `nexus-ide@0.10.2`.
- `node -p "require('./package.json').version"`: `0.10.2`.
- `PlistBuddy` em `/Applications/NexusIDE.app/Contents/Info.plist`: `0.10.1`.
- Crash reports NexusIDE:
  - `NexusIDE-2026-07-03-170438.ips`: `0.1.0`, `EXC_BREAKPOINT/SIGTRAP`.
  - `NexusIDE-2026-07-06-111322.ips`: `0.7.0`, `EXC_BREAKPOINT/SIGTRAP`.
  - `NexusIDE-2026-07-06-181134.ips`: `0.10.1`, `EXC_BREAKPOINT/SIGTRAP`.
- `git log --oneline -n 5`:
  - `5b46a94 chore(release): bump version to 0.10.2`
  - `db94187 fix(voice): wake mic nunca mais morre sozinho + observabilidade`
  - `655d880 chore(release): bump version to 0.10.1`
  - `47b1e23 fix(voice): harden Jarvis live diagnostics`
  - `1afdf5f chore(release): v0.10.0`

### Arquivos Nexus mais importantes

- `PRODUCT.md`
- `README.md`
- `CHANGELOG.md`
- `docs/ARCHITECTURE.md`
- `docs/voice.md`
- `training/ei-jarvis/README.md`
- `forge.config.ts`
- `src/main/main.ts`
- `src/main/window.ts`
- `src/main/pty/pty-host-client.ts`
- `src/main/pty/pty-host-entry.ts`
- `src/main/orch/mcp-server.ts`
- `src/main/orch/tools-domain.ts`
- `src/main/browser/browser-manager.ts`
- `src/shared/voice-config.ts`
- `src/shared/voice-ipc.ts`
- `src/main/voice/stt-service.ts`
- `src/main/voice/tts-service.ts`
- `src/main/voice/jarvis-brain.ts`
- `src/main/voice/live-transport-controller.ts`
- `src/main/voice/gemini-live-transport.ts`
- `src/main/voice/wake-engine.ts`
- `src/renderer/voice/voice-controller.ts`
- `src/renderer/voice/wake-mic.ts`
- `src/renderer/voice/wake-rearm.ts`

### Referencias externas consultadas

- Overclock:
  - `https://overclock.sh`
  - `https://overclock.sh/clockvoice`
- Bridge:
  - `https://www.bridgemind.ai/products/bridgevoice`
  - `https://www.bridgemind.ai/products/bridgespace`
  - `https://docs.bridgemind.ai/docs/bridgevoice`
  - `https://docs.bridgemind.ai/docs/bridgespace`

### Limitacoes desta fase

- Nao alterei codigo do Nexus.
- Nao rodei build.
- Nao fiz teste interativo de comandos de voz nos apps de referencia.
- Nao capturei screenshots da GUI.
- A analise de Overclock/Bridge foi por bundle, strings, sidecar JS, logs locais e docs oficiais.
- O proximo passo recomendado e uma sessao hands-on controlada com permissao explicita para operar microfone, screen recording e comandos de voz.

## Apendice B - Rastreabilidade Jarvis sob edicao paralela

Aviso operacional: em 2026-07-07, apos o aviso de que outra LLM estava alterando Jarvis em paralelo, esta analise passou a operar em modo leitura. A unica escrita permitida a partir desse ponto foi este documento. Os comandos abaixo foram read-only (`git rev-parse`, `git status`, `git diff --stat`, `git log`, `git blame`, `stat`, `nl`, `sed`). Nao rodei build, testes, install, checkout, stash, pull ou reset depois desse aviso.

Hash do snapshot usado para os trechos abaixo:

```text
220089412d6c6413e012b870aa7ff6024dfe57ae
```

### B.1 Estado do repo no momento da analise

`git rev-parse HEAD`:

```text
220089412d6c6413e012b870aa7ff6024dfe57ae
```

`git status --short`:

```text
 M docs/analysis/nexus-vs-overclock-bridge.md
 M package.json
 M src/main/main.ts
 M src/main/smoke-core.test.ts
 M src/main/smoke-core.ts
```

`git diff --stat`:

```text
 docs/analysis/nexus-vs-overclock-bridge.md | 170 +++++++++++++++++++++++++----
 package.json                               |  10 +-
 src/main/main.ts                           |  12 +-
 src/main/smoke-core.test.ts                |  30 ++++-
 src/main/smoke-core.ts                     |   9 ++
 5 files changed, 203 insertions(+), 28 deletions(-)
```

Observacao: os arquivos de codigo listados acima ja estavam modificados no working tree quando este apendice de leitura foi criado. Eles nao fazem parte da analise Jarvis abaixo, exceto como baseline do repo.

### B.2 Arquivos Jarvis monitorados por mtime

Comparei mtime antes e depois da leitura dos trechos Jarvis. Nenhum dos arquivos abaixo mudou durante esta coleta; portanto, nao marquei nenhum como "arquivo em modificacao ativa por outra LLM" nesta rodada.

| Arquivo | mtime observado |
|---|---:|
| `src/renderer/voice/voice-controller.ts` | `2026-07-07T10:17:12-0300` |
| `src/shared/voice-config.ts` | `2026-07-06T14:40:34-0300` |
| `src/shared/voice-ipc.ts` | `2026-07-07T10:18:15-0300` |
| `src/main/voice/stt-service.ts` | `2026-07-06T15:59:08-0300` |
| `src/main/voice/tts-service.ts` | `2026-07-06T16:01:35-0300` |
| `src/main/voice/jarvis-brain.ts` | `2026-07-06T16:01:45-0300` |
| `src/main/voice/live-transport-controller.ts` | `2026-07-06T14:40:34-0300` |
| `src/main/voice/gemini-live-transport.ts` | `2026-07-06T09:05:14-0300` |
| `src/main/voice/wake-engine.ts` | `2026-07-06T07:35:17-0300` |
| `src/renderer/voice/wake-mic.ts` | `2026-07-07T10:16:32-0300` |
| `src/renderer/voice/wake-rearm.ts` | `2026-07-07T10:10:31-0300` |
| `src/main/voice/voice-ipc.ts` | `2026-07-07T10:14:09-0300` |
| `src/main/voice/voice-log.ts` | `2026-07-07T10:09:02-0300` |
| `src/shared/voice-channels.ts` | `2026-07-07T10:12:46-0300` |

### B.3 Ultimo commit por arquivo Jarvis lido

| Arquivo | Ultimo commit tocando o arquivo |
|---|---|
| `src/renderer/voice/voice-controller.ts` | `db94187ebbb44b812d77ebb5a5d3aa9e3804e180` - `fix(voice): wake mic nunca mais morre sozinho + observabilidade` |
| `src/shared/voice-config.ts` | `3b603fa26c2b3e380aa88b83387c8379c2a6808b` - `fix: harden Jarvis voice and provider readiness` |
| `src/shared/voice-ipc.ts` | `db94187ebbb44b812d77ebb5a5d3aa9e3804e180` - `fix(voice): wake mic nunca mais morre sozinho + observabilidade` |
| `src/main/voice/stt-service.ts` | `1c9f42c9b4958c88a42eb128b0f4005b0bf4a102` - `fix(voice): JARVIS operacional — confiabilidade, comandos e HUD arrastável` |
| `src/main/voice/tts-service.ts` | `1c9f42c9b4958c88a42eb128b0f4005b0bf4a102` - `fix(voice): JARVIS operacional — confiabilidade, comandos e HUD arrastável` |
| `src/main/voice/jarvis-brain.ts` | `1c9f42c9b4958c88a42eb128b0f4005b0bf4a102` - `fix(voice): JARVIS operacional — confiabilidade, comandos e HUD arrastável` |
| `src/main/voice/live-transport-controller.ts` | `3b603fa26c2b3e380aa88b83387c8379c2a6808b` - `fix: harden Jarvis voice and provider readiness` |
| `src/main/voice/gemini-live-transport.ts` | `3feeab6bb57ebac5d70d14a4878e59f909e0943c` - `feat: Jarvis Live transporte realtime (Gemini Live) + persona (P1-4)` |
| `src/main/voice/wake-engine.ts` | `3924bc43af91aae184875ee85e354f9d81831e60` - `fix(voice): JARVIS no longer talks to herself (false wake + silence STT)` |
| `src/renderer/voice/wake-mic.ts` | `db94187ebbb44b812d77ebb5a5d3aa9e3804e180` - `fix(voice): wake mic nunca mais morre sozinho + observabilidade` |
| `src/renderer/voice/wake-rearm.ts` | `db94187ebbb44b812d77ebb5a5d3aa9e3804e180` - `fix(voice): wake mic nunca mais morre sozinho + observabilidade` |
| `src/main/voice/voice-ipc.ts` | `db94187ebbb44b812d77ebb5a5d3aa9e3804e180` - `fix(voice): wake mic nunca mais morre sozinho + observabilidade` |
| `src/main/voice/voice-log.ts` | `db94187ebbb44b812d77ebb5a5d3aa9e3804e180` - `fix(voice): wake mic nunca mais morre sozinho + observabilidade` |
| `src/shared/voice-channels.ts` | `db94187ebbb44b812d77ebb5a5d3aa9e3804e180` - `fix(voice): wake mic nunca mais morre sozinho + observabilidade` |

### B.4 Blame das linhas-chave citadas

| Evidencia | Blame |
|---|---|
| `src/renderer/voice/voice-controller.ts:41` `REALTIME_ACTION_BRIDGE_ENABLED = false` | `a623a574` 2026-07-06 `fix(server): asyncHandler + errorHandler — rejeição async vira 500 JSON` |
| `src/renderer/voice/voice-controller.ts:86` comentario "Gemini Live is not action-capable yet" | `a623a574` 2026-07-06 |
| `src/renderer/voice/voice-controller.ts:153` `currentScreenSnapshot()` | `a623a574` 2026-07-06 |
| `src/renderer/voice/voice-controller.ts:517` `realtimeTurnActive = REALTIME_ACTION_BRIDGE_ENABLED && isRealtimeLive()` | `a623a574` 2026-07-06 |
| `src/renderer/voice/voice-controller.ts:587` chamada batch `window.nexus.voice.transcribe` | `1c9f42c9` 2026-07-06 `fix(voice): JARVIS operacional — confiabilidade, comandos e HUD arrastável` |
| `src/renderer/voice/voice-controller.ts:686` contexto usa `currentScreenSnapshot()` | `a623a574` 2026-07-06 |
| `src/renderer/voice/voice-controller.ts:870` branch `run_command` | `f5d738f3` 2026-07-04 `feat: living JARVIS voice assistant, home deck, providers, SaaS scaffold` |
| `src/shared/voice-config.ts:102` schema `jarvisLiveConfigSchema` | `ea2c165f` 2026-07-05 `feat: add jarvis live mode` |
| `src/shared/voice-config.ts:266` default `jarvisLive` | `ea2c165f` 2026-07-05 |
| `src/shared/voice-config.ts:296` default STT | `8a3b0449` 2026-07-03 `feat(2e): Jarvis voice mode — push-to-talk STT translate + spoken TTS response, multi-provider with local fallback` |
| `src/shared/voice-config.ts:330` default TTS | `8a3b0449` 2026-07-03 |
| `src/shared/voice-ipc.ts:209` union `JarvisAction` | `f5d738f3` 2026-07-04 |
| `src/shared/voice-ipc.ts:230` `jarvisRequestSchema` | `f5d738f3` 2026-07-04 |
| `src/main/voice/stt-service.ts:111` `attemptCloud()` | `8a3b0449` 2026-07-03 |
| `src/main/voice/tts-service.ts:54` barge-in do `say` | `1c9f42c9` 2026-07-06 |
| `src/main/voice/jarvis-brain.ts:50` catalogo de actions no prompt | `f5d738f3` 2026-07-04 |
| `src/main/voice/jarvis-brain.ts:182` `contextBlock()` | `f5d738f3` 2026-07-04 |
| `src/main/voice/jarvis-brain.ts:295` `BRAIN_TIMEOUT_MS = 15_000` | `1c9f42c9` 2026-07-06 |
| `src/main/voice/live-transport-controller.ts:31` realtime configurado por `gemini-live` + key | `3feeab6b` 2026-07-06 `feat: Jarvis Live transporte realtime (Gemini Live) + persona (P1-4)` |
| `src/main/voice/gemini-live-transport.ts:1` transporte Gemini Live full-duplex | `3feeab6b` 2026-07-06 |
| `src/main/voice/wake-engine.ts:40` chunk wake 1280 amostras | `f5d738f3` 2026-07-04 |
| `src/renderer/voice/wake-mic.ts:12` comentario do wake mic sempre ligado | `f5d738f3` 2026-07-04 |
| `src/renderer/voice/wake-mic.ts:264` rearme infinito do mic | `db94187e` 2026-07-07 `fix(voice): wake mic nunca mais morre sozinho + observabilidade` |
| `src/renderer/voice/wake-rearm.ts:11` backoff `[1s, 3s, 8s]` + lento | `db94187e` 2026-07-07 |
| `src/main/voice/voice-ipc.ts:224` handler `VOICE_CHANNELS.jarvis` | `f5d738f3` 2026-07-04 |
| `src/main/voice/voice-ipc.ts:264` confirmacao nativa para `run_command` | `ee494d62` 2026-07-05 `fix: apply architectural audit backlog (2026-07-05) + UX polish` |

### B.5 Snapshots compactos dos trechos citados

Todos os snapshots abaixo foram lidos no commit `220089412d6c6413e012b870aa7ff6024dfe57ae`.

```ts
// src/renderer/voice/voice-controller.ts:41,86-88,517
const REALTIME_ACTION_BRIDGE_ENABLED = false;
// Decision is per utterance. Gemini Live is not action-capable yet, so the
// production Jarvis path stays Classic: STT → Jarvis brain → app actions → TTS.
realtimeTurnActive = REALTIME_ACTION_BRIDGE_ENABLED && isRealtimeLive();
```

```ts
// src/renderer/voice/voice-controller.ts:153,225-233,686-690
function currentScreenSnapshot(): ScreenSnapshot { ... }
return {
  context:
    `Workspace ${wsName} em modo ${viewKind}. ` +
    `${panes.length} pane... ` +
    `Pane focado: ${focused?.title ?? 'nenhum'}.`,
};
const screen = currentScreenSnapshot();
const context = {
  workspace: useWorkspaceStore.getState().current?.name ?? null,
  screen: screen.context,
};
```

```ts
// src/renderer/voice/voice-controller.ts:538-596
if (realtimeTurnActive && isRealtimeLive()) {
  if (wakeMic.isUtteranceActive()) wakeMic.finishUtterance();
  liveEndTurn();
  store.setStatus('idle');
  return;
}
const stt = await withTimeout(
  window.nexus.voice.transcribe({
    audioBase64: result.wavBase64,
    mime: 'audio/wav',
    sampleRate: result.sampleRate,
    ...(routing === 'jarvis' ? { translate: false, language: 'pt' } : {}),
  }),
  TRANSCRIBE_DEADLINE_MS,
  'transcrição',
);
```

```ts
// src/shared/voice-config.ts:102-117,266-274
export const jarvisLiveConfigSchema = z.object({
  enabled: z.boolean().default(false),
  transport: z.enum(['classic', 'gemini-live']).default('classic'),
  liveModel: z.string().default('gemini-2.5-flash-native-audio-preview-12-2025'),
});
jarvisLive: {
  enabled: false,
  transport: 'classic',
  liveModel: 'gemini-2.5-flash-native-audio-preview-12-2025',
  voiceName: 'Charon',
}
```

```ts
// src/shared/voice-config.ts:296-339
stt: {
  provider: 'groq',
  endpoint: 'https://api.groq.com/openai/v1/audio/transcriptions',
  model: 'whisper-large-v3-turbo',
  streaming: false,
  fallback: { provider: 'openai', model: 'whisper-1', fallback: { provider: 'local-whisper' } },
},
tts: {
  provider: 'openai',
  endpoint: 'https://api.openai.com/v1/audio/speech',
  model: 'gpt-4o-mini-tts',
  streaming: true,
  fallback: { provider: 'piper', fallback: { provider: 'macos-say' } },
}
```

```ts
// src/shared/voice-ipc.ts:209-219,230-235
export type JarvisAction =
  | { type: 'none' }
  | { type: 'open_squad'; squadName: string }
  | { type: 'open_workspace'; workspaceName: string }
  | { type: 'design_squad' }
  | { type: 'new_mission' }
  | { type: 'open_terminal' }
  | { type: 'close_pane' }
  | { type: 'open_board' }
  | { type: 'send_to_pane'; text: string }
  | { type: 'run_command'; command: string };
screen: z.string().max(500).nullable().optional(),
```

```ts
// src/main/voice/stt-service.ts:111-151
async function attemptCloud(plugin, req, deps): Promise<Attempt> {
  const endpoint = resolveEndpoint(plugin, translate);
  const audio = base64ToBuffer(req.audioBase64);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: req.mime }), `audio.${ext}`);
  res = await deps.fetchImpl(endpoint, { method: 'POST', body: form, signal: AbortSignal.timeout(STT_CLOUD_TIMEOUT_MS) });
}
```

```ts
// src/main/voice/tts-service.ts:54-68
let activeSay: ChildProcess | null = null;
export function stopSystemSpeech(): void {
  if (activeSay) {
    activeSay.kill('SIGKILL');
    activeSay = null;
  }
}
```

```ts
// src/main/voice/jarvis-brain.ts:50-68,182-194,295
Tipos de action:
- {"type":"none"}
- {"type":"open_squad","squadName":"<nome aproximado>"}
- {"type":"run_command","command":"<comando exato>"}
- {"type":"send_to_pane","text":"<prompt de engenharia em INGLÊS>"}
function contextBlock(ctx: JarvisContext): string {
  return `- tela atual: ${ctx.screen ?? 'não informada'}\n` + ...
}
export const BRAIN_TIMEOUT_MS = 15_000;
```

```ts
// src/main/voice/live-transport-controller.ts:31-37,100-110
isRealtimeConfigured(): boolean {
  const live = getVoiceConfig().jarvisLive;
  return live.transport === 'gemini-live' && resolveVoiceApiKey('GEMINI_API_KEY') !== undefined;
}
micIn(b64: string): void { this.transport?.sendMicChunk(b64); }
contextIn(text: string): void { this.transport?.sendContext(text); }
endTurn(): void { this.transport?.endUserTurn(); }
```

```ts
// src/main/voice/gemini-live-transport.ts:1-13,55-61,83-99
// Gemini Live — transporte de áudio full-duplex real (WSS BidiGenerateContent...)
const LIVE_WS_BASE = 'wss://generativelanguage.googleapis.com/ws/...BidiGenerateContent';
const SETUP_TIMEOUT_MS = 10_000;
const PENDING_MIC_MAX_BYTES = 160 * 1024;
generationConfig: { responseModalities: ['AUDIO'], speechConfig: { ... } },
inputAudioTranscription: {},
outputAudioTranscription: {},
contextWindowCompression: { slidingWindow: {} },
```

```ts
// src/renderer/voice/wake-mic.ts:12-29,264-301
// Mic sempre-ligado do wake word...
// RESILIÊNCIA: track.onended, watchdog de frames, AudioContext suspenso.
private handleStreamDeath(reason: string): void { ... this.scheduleRestart(reason); }
private scheduleRestart(reason: string): void {
  if (attempt >= RESTART_BACKOFF_MS.length && !this.dead) this.onDied?.(reason);
  setTimeout(() => this.openGraph().then(...).catch(() => this.scheduleRestart(reason)), nextRearmDelay(attempt));
}
```

```ts
// src/renderer/voice/wake-rearm.ts:11-20
export const RESTART_BACKOFF_MS = [1_000, 3_000, 8_000] as const;
export const REARM_SLOW_MS = 30_000;
export function nextRearmDelay(attempt: number): number {
  return attempt < RESTART_BACKOFF_MS.length ? RESTART_BACKOFF_MS[attempt] : REARM_SLOW_MS;
}
```

```ts
// src/main/voice/voice-ipc.ts:224-240,264-270
ipcMain.handle(VOICE_CHANNELS.jarvis, async (_event, raw): Promise<JarvisReply> => {
  const parsed = jarvisRequestSchema.safeParse(raw);
  const reply = await jarvisThink(parsed.data.transcript, parsed.data.context, parsed.data.history);
  liveSession.onJarvisReply(parsed.data.transcript, reply);
  return reply;
});
// SEC#6: a shell command produced by the (LLM) Jarvis brain must never run
// without an explicit, un-spoofable human OK.
ipcMain.handle(VOICE_CHANNELS.confirmCommand, async (_event, raw): Promise<boolean> => { ... });
```
