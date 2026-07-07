# Auditoria competitiva: Nexus vs Overclock, BridgeVoice e BridgeSpace

Data: 2026-07-07
Baseline visual consultado: Linear (`~/.design-references/linear.md`)
Apps inspecionados localmente:

- `/Applications/Overclock.app` (`sh.overclock.app`, 1.0.4)
- `/Applications/BridgeVoice.app` (`com.bridgemind.bridgevoice`, 2.8.1)
- `/Applications/BridgeSpace.app` (`io.bridgemind.bridgespace`, 3.4.9)
- Nexus dev/local em `/Users/cleofasrocha/dev/nexus-ide`

## Evidencias capturadas

Screenshots locais:

- `screenshots/01-overclock-home.png`
- `screenshots/02-bridgevoice-home.png`
- `screenshots/03-bridgespace-home.png`
- `screenshots/04-nexus-canvas-current.png`

Inspecao de bundle:

- Overclock expoe bastante arquitetura em `/Applications/Overclock.app/Contents/Resources/sidecar/dist`.
- BridgeVoice e BridgeSpace estao mais fechados/compilados em Tauri/Rust; a leitura util veio de `Info.plist` e `strings` nos binarios.

## O que os concorrentes fazem melhor hoje

### Overclock

Overclock vence em operacao porque separa voz fluida de execucao confiavel:

- Usa uma sessao Gemini Live full-duplex para a experiencia de voz, com singleton de sessao, fila serializada de turnos, buffer de mic pre-setup, timeout de setup e supressao de eco textual.
- Nao tenta fazer tudo pelo modelo realtime. A voz usa tools grosseiras e delega trabalho real para um `JarvisService` com Agent SDK + MCP in-process.
- As tools tem gates tecnicos: permissao, confirmacao, bloqueio de pane duplicado, pass-through verbatim do ditado para `pane_write`, e protecao contra wizard/delegacao acontecendo no mesmo turno.
- A UI tem uma narrativa clara: workspace, missoes/sessoes, agente/Jarvis. Mesmo sendo densa, a intencao aparece mais cedo que no Nexus.

Gap direto no Nexus: agora temos uma ponte realtime hibrida
transcript -> Classic/MCP, mas ainda nao temos `functionDeclarations`/tool calls
nativas no provider live como o Overclock.

### BridgeVoice

BridgeVoice vence por foco:

- A primeira tela e simples: ditado, historico, dicionario, atalhos, ajustes.
- `Info.plist` e `strings` indicam captura persistente de audio, recuperacao de microfone, failover de device, mutar audio do sistema durante gravacao, STT local/cloud e logs de transcricao.
- O produto nao tenta ser IDE; por isso as metricas e estados principais cabem na tela sem competir.

Gap direto no Nexus: nosso pipeline de mic ja melhorou, mas ainda aparece `mic.firstFrame rms:0` e a calibracao do Fifine precisa virar uma rotina diagnostica guiada, nao tentativa manual por log.

### BridgeSpace

BridgeSpace vence em clareza de entrada:

- A tela inicial comunica quatro modos de trabalho com alto contraste: BridgeSpace, BridgeSwarm, BridgeBoard, BridgeMemory.
- A interface e menos "engenharia exposta"; o usuario entende o que fazer antes de ver detalhes.
- O bundle aponta para gerenciamento de perfis/contas/sessoes Claude/Codex e leitura de transcripts, mas nao expõe uma stack de voz comparavel ao Overclock.

Gap direto no Nexus: nosso primeiro viewport mistura topbar, canvas, Jarvis HUD, minimap, rails e pane. O poder existe, mas a hierarquia visual ainda nao guia.

## Diagnostico Nexus nesta passada

Problemas confirmados:

- Canvas: abrir terminal em modo canvas usava cascata global. Em layouts com pane fora do topo, o novo terminal parecia nascer "la embaixo" ou desalinhado.
- Pixel/operator: o sprite tinha dois frames lentos, com movimento quase invisivel; parecia parado.
- Runtime dev: o renderer quebrou por import errado em `jarvis-action-executor.ts` (`listPanes` vindo de `layout-store`).
- IPC realtime smoke: `liveSmokeTest` estava usado no main/preload, mas faltava em `VOICE_CHANNELS`.
- Dev Electron: `better-sqlite3` estava compilado para outro `NODE_MODULE_VERSION`, deixando SQLite em modo degradado ate rodar rebuild.

Problemas ainda abertos:

- Realtime action bridge: a ponte hibrida ja esta ligada, mas o caminho correto
  final e MCP/Agent-style com tools nativas no provider, permissoes e eventos
  de tool result voltando para a sessao live.
- HUD Jarvis ainda pode cobrir panes no canvas quando expandido e salvo no canto superior direito.
- `mic.firstFrame rms:0` ainda apareceu no primeiro frame, embora o wake tenha detectado `Hey Jarvis` depois com score `0.59`.
- `npm test` completo falhou por timeouts em testes de servidor (`auth`, `billing`, `team`, `db`): 43 falhas/905 testes. A area alterada passou, mas a suite global nao esta verde.

## Correcoes implementadas

- Canvas side-by-side:
  - Adicionado `nextCanvasLayout()` em `src/renderer/lib/canvas-layout.ts`.
  - `addShellPane`, `spawnAgent` e `addBrowserPane` agora usam o pane focado como pivot no canvas.
  - O novo pane preserva tamanho/y do foco, abre a direita e escaneia para a proxima coluna livre.

- Testes de layout:
  - Coberto em `src/renderer/lib/canvas-layout.test.ts`.

- Pixel/operator:
  - `src/renderer/components/OperatorSprite.tsx` agora usa 4 frames, 220ms por frame, bob vertical mais visivel, aura/acento animados, e hook reativo para `prefers-reduced-motion`.

- Polimento leve do canvas:
  - Minimap/controls ficaram menores e menos dominantes em `src/renderer/styles/canvas-voice.css`.

- Realtime/dev runtime:
  - Adicionado `VOICE_CHANNELS.liveSmokeTest` em `src/shared/voice-channels.ts`.
  - Corrigido import runtime em `src/renderer/voice/jarvis-action-executor.ts`.
  - Rodado `npm run rebuild:electron` para reconstruir `better-sqlite3` contra a versao Electron usada pelo dev app.

## Validacao executada

Passou:

- `npm run typecheck`
- `npx vitest run src/renderer/lib/canvas-layout.test.ts src/renderer/components/operator-sprite-data.test.ts src/main/voice/jarvis-action-fastpath.test.ts src/main/voice/jarvis-brain.test.ts src/main/voice/jarvis-live.test.ts`
  - 38 testes passaram.
- `npm start`
  - App Electron abriu.
  - SQLite degradado desapareceu apos rebuild.
  - Wake mic ligou no Fifine.
  - Log registrou `wake.detected` com score `0.59`.
  - Abrir `Terminal` pelo botao em canvas criou pane shell ao lado do pane focado, nao embaixo.
- Rodada Jarvis app-aware:
  - `npm run typecheck`
  - 12 testes focados / 85 asserts passaram.
  - Clique na pill/HUD da Jarvis acorda a assistente.
  - Fast-path responde pane/pagina/tela atual sem LLM.
  - Delegacao para agente usa prompt de engenharia em ingles no `send_to_pane`.

Falhou / risco:

- `npm test` completo:
  - 117 arquivos passaram, 13 falharam.
  - 862 testes passaram, 43 falharam.
  - Falhas foram timeouts de 5s concentrados em `server/src/auth`, `server/src/billing`, `server/src/team` e `server/src/db`.

## Proximos P0 recomendados

1. Evoluir da ponte hibrida para live tool-calling nativo.
   - Seguir o padrao do Overclock: Live para conversa, executor separado para
     tools, confirmacao/gates tecnicos, tool result de volta para a sessao.

2. Transformar diagnostico de mic em rotina de calibracao no app.
   - Medir RMS real por device, sugerir ganho/threshold, mostrar device escolhido e explicar quando Chromium esta recebendo zero.

3. Corrigir suite server timeout.
   - Sem isso, release "operacional sem medo" fica comprometido mesmo que a voz/canvas passem.

4. Redesenhar HUD/canvas com regra de nao-obstrucao.
   - O HUD precisa ancorar sem cobrir pane ativo ou entrar em mini automaticamente quando o canvas tem pane sob ele.

5. Empacotar 0.10.7+ so depois dos P0 acima e smoke em app empacotado.
