# NexusIDE — Documento de Arquitetura

> **Produto:** Terminal IDE multi-agente para macOS.
> **Status:** IMPLEMENTADO — decisões-base e corte de produto V2.
> **Atualizado:** 2026-08-08
> **Audiência:** mantenedores de main, preload, renderer, PTY e MCP.
> **Fontes:** implementação em `src/` e documentos de subsistemas citados abaixo.

Este documento é **prescritivo e decisivo**. Onde há trade-off, a decisão está tomada e justificada.

### Extensões 2026-07-13 (Warp/BridgeMind clean-room foundations)

Contratos e infraestrutura **feature-flagged** (default **off**), clean-room — sem código AGPL:

| Capacidade             | Docs                          | Flag                             |
| ---------------------- | ----------------------------- | -------------------------------- |
| CommandBlock + OSC 133 | `docs/TERMINAL-BLOCKS.md`     | `feature.terminal.commandBlocks` |
| Mission event journal  | `docs/MISSION-EVENTS.md`      | `feature.mission.eventJournal`   |
| SearchMixer            | `docs/SEARCH-MIXER.md`        | `feature.search.mixer`           |
| Feature flags          | `src/shared/feature-flags.ts` | (registry itself)                |

Diagnóstico: `docs/analysis/2026-07-13-warp-bridgemind-phase0-diagnosis.md`.  
PTY stream, effect policy, budgets e `event_ledger` **permanecem**; as novas camadas são laterais.

### Corte de produto V2 (2026-08-08)

`src/renderer/App.tsx` monta uma única navegação declarada por
`product-navigation-store.ts`: launcher, terminal, configuração de missão,
missão (quadro ou terminais), quadro de tarefas, memória e configurações.
`AppShell` e `WorkspaceRail` são o chrome único; Mission Rail, Ops Board,
Orchestration Panel e o wizard modal antigos não têm montagem paralela.

O ciclo de vida canônico de missão cruza o preload em `window.nexus.mission`
(`prepare`, `start`, `command`, `snapshot`, `list`, `onChanged`) e é
implementado pelo `MissionEngine`. `window.nexus.orch` permanece para
capacidades que ainda são realmente distintas — panes, eventos, reabertura,
squads e projeções de controle — e não deve receber uma segunda API de ciclo
de vida. A configuração de missão é a única superfície de criação; o quadro é
a única superfície de verdade operacional.

---

## 0. Sumário Executivo das Decisões

| #   | Decisão                | Escolha                                                                                                                             | Justificativa curta                                                                                |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| A   | Runtime                | **Electron + Electron Forge**                                                                                                       | node-pty/xterm/uiohook/onnx todos Node-native; Forge faz .dmg signing+notarization; alvo macOS 11+ |
| B   | Processos              | **Main + Renderer + PTY Host (utilityProcess) + MCP embutido**                                                                      | isola crash de PTY nativo; separa orquestração da UI                                               |
| C   | Panes                  | **Workspace → View(grid\|canvas) → Pane → Session**; grid = split-tree, canvas = `@xyflow/react`; ambos referenciam a MESMA Session | grid↔canvas sem re-spawn do PTY; canvas arrastável além do grid                                    |
| D   | Adapters               | **JSON declarativo tipado: `cli-pty`, `api-provider`, `voice`**; hot-reload                                                         | usuário adiciona CLI nova sem tocar código; handoff/estado/modelos de primeira classe              |
| E   | Orquestração           | **Domínio squads/missões/handoffs/catálogo + MCP embutido (24 tools, namespace `nexus_*`)**; skill-gate client+server               | orquestração multi-agente completa, auditável                                                      |
| F   | Voz                    | **Jarvis v1: STT + Silero VAD + Groq translate + TTS streaming + resposta falada**                                                  | ditado E resposta falada de volta                                                                  |
| G   | Persistência/Segurança | **better-sqlite3 + Keychain + CSP + contextIsolation**                                                                              | secrets fora do DB; sem cripto caseira                                                             |
| H   | Build                  | **2a shell/grid → 2b adapters → 2c canvas → 2d orquestração → 2e voz → 3 QA/.dmg**                                                  | cada fase com entregável verificável                                                               |

---

## A. Decisão de Stack: Electron vs Tauri

### A.1 Tabela de trade-offs

| Critério                  | Electron                                                | Tauri                                             | Peso                  |
| ------------------------- | ------------------------------------------------------- | ------------------------------------------------- | --------------------- |
| PTY nativo                | `@lydell/node-pty` / `node-pty` maduro (v1.2.0-beta.12) | `portable-pty` (Rust) menos provado desktop       | 🔴 Crítico            |
| Terminal render           | xterm.js em Chromium consistente + webgl garantido      | xterm.js em WKWebView (quirks WebGL)              | 🔴 Crítico            |
| Hotkey global keyup       | uiohook-napi (N-API) direto no main                     | crate Rust + bridge                               | 🟠 Alto               |
| ONNX (Silero VAD)         | onnxruntime-node no main                                | ort crate (duplica pipeline em Rust)              | 🟠 Alto               |
| .dmg signing+notarization | Electron Forge out-of-box                               | tauri build menos documentado macOS multi-binário | 🟠 Alto               |
| RAM/bundle                | ~150–250MB / ~120–200MB                                 | ~40–80MB / ~10–40MB                               | 🟡 Médio (é dev tool) |
| 1 linguagem (TS)          | Main+renderer+PTY+MCP todos TS                          | Rust + TS (2 toolchains)                          | 🟠 Alto               |
| Ecossistema Node-native   | os 4 pilares (pty/webgl/uiohook/onnx) já são N-API/Node | cada um exige ponte Rust↔JS                       | 🔴 Crítico            |

### A.2 Decisão: **Electron + Electron Forge**

Os quatro pilares técnicos do NexusIDE — `node-pty` (PTY nativo), `xterm.js`+WebGL (render do terminal), `uiohook-napi` (hotkey global com keyup) e `onnxruntime-node` (Silero VAD) — são todos Node-native/N-API maduros. Em Electron rodam direto no processo main; em Tauri cada um exigiria uma ponte Rust↔JS e, em vários casos, duplicar o pipeline em Rust. O footprint do Chromium (~150–250MB) é plenamente aceitável para uma dev tool desktop. Electron ainda entrega, via Electron Forge, signing + notarization do `.dmg` out-of-box e um único toolchain TypeScript em todos os processos (main, renderer, PTY host, MCP). Parâmetros de plataforma decididos: alvo macOS 11+, bundle assinado com Developer ID, URL scheme `nexus://`, auto-update via Squirrel.Mac, persistência em `better-sqlite3`. **Electron decidido.** Ver §I para descartados.

### A.3 Stack canônico (pinado)

```
Runtime .............. Electron + Electron Forge (packaging/signing/notarization)
Linguagem ............ TypeScript (strict) em TODOS os processos
Frontend ............. React 18+ + TypeScript; Zustand (client state); zod (boundaries)
Terminal ............. @xterm/xterm + addons fit/webgl/search/serialize
PTY .................. @lydell/node-pty v1.2.0-beta.12 — PRIMÁRIO;
                       node-pty-prebuilt-multiarch como alternativa se build nativo problemático
Canvas ............... @xyflow/react (MIT)  — NÃO tldraw (licença comercial)
Persistência ......... better-sqlite3 (síncrono, no main)
Voz — VAD ............ onnxruntime-node + Silero VAD (ONNX ~2MB)
Voz — hotkey ......... uiohook-napi (keydown/keyup global)
Secrets .............. Electron safeStorage / keytar → macOS Keychain (ou libsodium fallback)
MCP .................. @modelcontextprotocol/sdk (servidor embutido no main)
```

**Licenças (bundle, permissivas):** Electron, xterm.js, @lydell/node-pty, @xyflow/react, Silero VAD, uiohook-napi, Piper, whisper.cpp, better-sqlite3, onnxruntime-node — todas MIT/Apache/BSD. **Descartado por licença:** tldraw (comercial). **Só referência (não copiar código):** Claude Squad (AGPL-3.0).

---

## B. Arquitetura de Processos

### B.1 Topologia (4 processos)

```
MAIN (Node/TS): lifecycle, janelas, globalShortcut, orchestration domain,
                MCP server embutido, SQLite (better-sqlite3), voice engine
                (Silero VAD onnxruntime-node, STT/TTS), secrets (Keychain),
                adapter registry (carrega/valida/hot-reload plugins JSON)
   │ MessagePort (IPC tipado+zod)            │ spawn utilityProcess
   ▼                                          ▼
RENDERER (Chromium/React):                   PTY HOST (utilityProcess/Node):
  UI grid+canvas+panes, xterm.js,             @lydell/node-pty spawn/kill/resize,
  Zustand, mic (getUserMedia+AudioWorklet),   1 host p/ N sessões, isola crash
  Web Audio playback (TTS)                    nativo, stream bytes → renderer
                                              via MessagePort dedicado

contextIsolation:true, nodeIntegration:false, sandbox:true, contextBridge no preload.
Agentes CLI rodam DENTRO das sessões PTY; falam MCP com o servidor embutido.
```

### B.2 PTY Host separado (padrão VS Code)

@lydell/node-pty é addon nativo C++; segfault/FD-leak (cf. bug Gemini CLI #15945) **não pode derrubar main nem UI**. PTY Host é `utilityProcess` (mais leve que BrowserWindow, sem Chromium): mantém `sessionId → IPty`, streama bytes por MessagePort dedicado por sessão (baixa latência), recebe controle (spawn/write/resize/kill) do main, reinicia isolado com re-spawn de sessões recuperáveis.

**Persistência opt-in (2026-08-10, flag `feature.pty.persistentSession`):** quando `tmux` está no PATH e o spawn **não** é native-sealed (Darwin authenticity no binário da CLI), o main cria uma sessão tmux nomeada (`nexus-<workspace>-<paneId>`) com o mesmo `spawnEnv` (`tmux -e`) e o PTY host só faz `attach-session -t =name`. Quit do app faz detach (não `kill-session`); fechar o pane mata a sessão tmux. Registry em SQLite (`persistent_pty_sessions`); sessão ausente limpa a linha stale. Launches sealed ficam em PTY direto por desenho (o supervisor amarra a CLI, não o wrapper). Fallback fail-open se tmux ausente. Superfície product `project` (`feature.ui.projectOverview`) expõe flock/minimap + goal box → Mission Setup (caminho canônico V2), sem alterar o MissionEngine.

Implementação (2026-07): `pty-host-entry.ts` roda no utilityProcess e é um **executor burro** — só spawna/escreve/mata; nunca decide política. Todo o trabalho sensível (allowlist de env, montagem de argv, `$HOME` efêmero quando o adapter precisa, espelho de skills, ownership) fica no main (`pty-manager.ts`). A ponte pura vive em `pty-host-core.ts` (sem electron, unit-testada); o supervisor `pty-host-client.ts` é o **único** módulo PTY que importa electron e é injetado via `setPtyHost`, mantendo `pty-manager` fora do grafo electron (testável). O stream de bytes hoje volta ao main (não vai direto ao xterm) porque as taps de orquestração — cost tracker, parser de handoff legado, pipes — precisam observá-lo; a MessagePort direta ao xterm da §B.3 é otimização futura condicionada a preservar essas taps.

No macOS, toda CLI governada nasce sob o helper universal assinado
`nexus-pty-supervisor`. O `/usr/bin/perl` da Apple atua como estágio zero:
autentica as duas imagens de `exec` do helper por ID, Team ID e CDHash antes de
desanexar o trace. O helper trace-executa e valida também a imagem viva do
provider, sela a identidade de responsabilidade do kernel, mantém o anchor vivo
e, no encerramento, congela o conjunto até um fixed point, sinaliza por audit
token e exige duas varreduras completas vazias. Assim, `double-fork`, `setsid` e
reparent para o `launchd` não transformam ausência na árvore PPID em uma prova
falsa. Saída por sinal, inventário incompleto ou helper fora do bundle assinado
são falha de autoridade, nunca sucesso sintético. O contrato e o risco residual
de APIs privadas estão em
`docs/DARWIN-PTY-SUPERVISOR.md`.

**Threat model do PTY (capability).** O renderer é confiável-mas-não-privilegiado: ele NÃO segura um handle de terminal real, só um `sessionId` opaco. Toda ação PTY é mediada pelo main, que amarra cada sessão ao `WebContents` que a criou (`ownedSession`); um renderer não escreve nem mata sessão que não seja sua (regressão em `pty-manager.test.ts`). O host isolado remove a classe "write em PTY morto derruba o main" (o addon nativo não roda mais no main). **Risco residual aceito e documentado:** uma XSS/comprometimento no renderer confiável ainda consegue dirigir os PANES DAQUELE renderer (é o trabalho legítimo de um terminal) — daí a CSP estrita (§ segurança), o isolamento de processo aqui, e a autorização por objeto das tools de orquestração (impede escape lateral ENTRE agentes/missões) serem camadas complementares, não redundantes.

### B.3 IPC tipado (não-negociável)

- `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`; renderer nunca toca Node/fs/child_process direto.
- **Todo** payload cross-boundary validado por **zod** no receptor (dados externos = untrusted).
- Canais por domínio: `pane:*`, `session:*`, `voice:*`, `orch:*`, `adapter:*`, `db:*`.
- Stream de bytes do PTY (`session:data`) usa **MessagePort transferido** à instância xterm (evita structured-clone por chunk); só controle usa canal JSON.
- Preload expõe `window.nexus` tipado (gerado do contrato) — sem `ipcRenderer` cru.

Contrato (design, `src/shared/ipc/contracts.ts`): canais `session:spawn/write/resize/kill/serialize`, `orch:mission.create`, `orch:handoff.list`, `voice:ptt.transcribe`, `adapter:list/reload` (invoke); `session:data/exit`, `orch:handoff.received`, `voice:tts.chunk`, `adapter:changed` (events). Cada Input é `z.object(...)`.

### B.4 Sessões PTY

- `Session` nasce de `SpawnSessionInput` (adapterId+model+cwd+env); main resolve adapter, monta spawnArgs+env e pede spawn ao PTY Host. Panes diretos preservam o perfil completo escolhido pelo usuário. Workers governados recebem um perfil privado por sessão: só continuidade de autenticação/sessão, MCP Nexus e skills explicitamente permitidas ficam visíveis; plugins, hooks, comandos, agentes, MCPs externos e discovery de projeto não são herdados.
- **Session ≠ Pane**: referenciada por `sessionId`; panes de grid e canvas apontam para o mesmo id. Fechar pane não mata session salvo último referenciador (`killOnLastPane` default true, exceto missões).
- Idle/busy via `stateParsing` do adapter → alimenta `pane_wait_idle`.
- Buffer serializado (@xterm/addon-serialize) → SQLite ao fechar; re-hidratado ao reabrir.

---

## C. Sistema de Panes (Grid + Canvas Infinito)

### C.1 Modelo de dados

```
Workspace(1) ──< View(N: 1 grid + 0..N canvas)
  │                ├ GridLayout (split-tree)   ──< PaneRef ─┐
  │                └ CanvasLayout (xyflow nodes) ──< PaneRef ─┤ referencia por sessionId
  └──< Session(N) ◄──────────────────────────────────────────┘  (pty vivo + buffer xterm + adapter)
```

**Regra de ouro:** estado de terminal vive em `Session`, não no Pane. Grid e Canvas são projeções de layout sobre as mesmas Sessions — é o que torna o canvas 'grátis'.

Interfaces (design): `Workspace{id,name,views,activeViewId}`; `View = {kind:'grid',layout:SplitNode} | {kind:'canvas',nodes:CanvasNode[],viewport}`; `Session{id,adapterId,providerId?,model?,cwd,ptyId,status,serializedBuffer?}`; `SplitNode = {kind:'leaf',paneRef} | {kind:'split',dir:'row'|'col',ratio,a,b}`; `CanvasNode{id,paneRef,position,size,z}`; `PaneRef{paneId,sessionId,title}`.

### C.2 Grid (split-tree)

Árvore binária (row/col + ratio, mental model tmux/VS Code). Ops: splitPane/resizeSplit/closePane(colapsa irmão)/focusPane. Render CSS flex recursivo; divisores arrastáveis animando só flex-basis/transform (nunca width/height em loop). Cada leaf hospeda `<TerminalPane sessionId>` com addon-fit + ResizeObserver → `session:resize` (cols/rows ao PTY).

### C.3 Canvas infinito (@xyflow/react)

Além do grid split-tree, o NexusIDE oferece um modo **canvas infinito**: cada pane é um custom node do xyflow, arrastável livremente, redimensionável, com z-order; `<MiniMap/>`, `<Controls/>`, `<Background/>` (dots), pan/zoom por trackpad. Edges representam relações de orquestração (orquestrador→worker, missão→panes), animadas em handoff. Performance: em zoom-out, nós abaixo de um threshold renderizam **snapshot congelado** (canvas image do serialize) em vez de xterm ativo; `onlyRenderVisibleElements`.

### C.4 Grid ↔ Canvas compartilhando sessão

1. **Reparent (preferido):** instância xterm+div mantida viva num `SessionSurfacePool` fora da árvore React; grid/canvas apenas reposicionam (portal) o mesmo DOM — O(1), zero re-spawn.
2. **Serialize/attach (fallback/persistência/mover-janela):** addon-serialize captura buffer; nova instância faz write(serialized) + reattach ao mesmo PTY stream.

---

## D. Adapter System (Plugins Declarativos JSON)

Três tipos, todos declarativos, em `~/.nexus/plugins/`, zod-validados, hot-reload. Adapters tipados dão **handoff, estado e modelos de primeira classe a qualquer CLI**: em vez de um wrapper 'shell' genérico que roda a CLI sem handoff nativo, cada adapter descreve spawn, auth, modelos, injeção de prompt e parsing de estado de forma declarativa. Usuário adiciona uma CLI nova dropando um JSON — sem tocar código.

### D.1 Adapter `cli-pty`

Campos: `kind:'cli-pty'`, `id`, `label`, `version`, `icon`, `bin`, `detect`, `install{method,command}`, `auth{method:oauth|api_key|device_code|subscription|none, envVarFallback, credentialStore, loginHint}`, `spawn{interactive[], headless[], headlessJson[], ptyRequired, resumeArgs[], extraArgs[]}` (placeholder `{{PROMPT}}`/`{{SESSION_ID}}`), `env{static{}, passthrough[], ephemeralHome:bool}`, `models{flag, list[], default}`, `promptInjection{method:stdin|arg|flag, flag, trailingNewline, bracketedPaste}`, `stateParsing{idle{type:regex,pattern}, busy{...}, shellIntegration:bool, exitCodes{}}`, `quirks{altScreen, requiresNoAutoUpdate, approvalFlag, mcpAutoload}`.

**Adapters iniciais (do recon):** claude, codex, agy (Antigravity), kimi, grok, aider (único ptyRequired:false em headless), opencode → `cli-pty`. fugu, glm → `api-provider`.

**Quirks pinados:** grok `requiresNoAutoUpdate:true`+`approvalFlag:'--always-approve'`; aider `ptyRequired:false`,`altScreen:false`; claude/agy/kimi `altScreen:true`; agy sem `--max-turns` (usar `--print-timeout`). Os tipos claude/codex/kimi/agy são cobertos como adapters `cli-pty` concretos; o JSON generaliza para qualquer outra CLI sem tocar código.

### D.2 Adapter `api-provider`

Campos: `kind:'api-provider'`, `id`, `label`, `endpoint`, `protocol:openai-chat|openai-responses|anthropic-messages`, `auth{method:api_key, header, scheme, envVar, keychainKey}`, `models{list[],default}`, `streaming`, `quirks`. Não spawna PTY — cliente HTTP interno + pane de chat, ou exposto como modelo p/ cli-pty com base-URL custom (aider/opencode via LiteLLM). Descoberta espelha `pane_list_providers`. Ex: glm (BigModel), fugu (Sakana).

### D.3 Adapter `voice`

Schema já no voice-pipeline-report (Entregável 3), adotado e estendido a partir do formato base de audio-config (ver §F). STT: groq(default), openai, deepgram, assemblyai, local-whisper, mlx-whisper. TTS: openai(default), elevenlabs, piper, kokoro, macos-say. VAD: silero(default), webrtc.

### D.4 Diretório, hot-reload, validação

```
~/.nexus/
├── plugins/{adapters,voice,themes,keybindings}/*.json (+assets)
├── models/  (whisper, piper)
├── bin/     (piper, whisper-cpp)
└── nexus.db (SQLite)
```

(Toda a configuração — `squads.json`, `audio-config.json`, `plugins/`, `cache/` — vive sob `~/.nexus/`; a migração de configs legadas lê apenas esse diretório.)

Registry (main) varre no boot, valida cada JSON com zod do seu `kind`; inválido → rejeitado fail-fast. Hot-reload via chokidar → `adapter:changed`. Sessions vivas mantêm snapshot do adapter (imutabilidade). Plugin do usuário sobrescreve built-in por `id`. Versionamento via `$schema`+`version`.

---

## E. Camada de Orquestração + MCP Embutido

### E.1 Domínio squads

Formato de squad JSON do NexusIDE:

```jsonc
{
  "squads": [
    {
      "id": "...",
      "name": "...",
      "createdAt": "...",
      "builtin": false,
      "orchestratorInstructions": "# markdown...",
      "agents": [
        {
          "id": "...",
          "agentName": "...",
          "category": "orchestrator|scout|executor|reviewer|architect",
          "cli": "claude",
          "providerId": "...",
          "model": "...",
          "effort": "low|medium|high|xhigh",
          "allowedSkills": [],
          "allowedTools": [],
        },
      ],
    },
  ],
}
```

Notas de design: `category` inclui **orchestrator** (não só os 4 worker roles); `orchestratorInstructions` é markdown; `effort` pinado por agente; allowlists por agente alimentam o skill-gate (§E.4). Squads têm **export/import em JSON** nativo do schema.

### E.2 Servidor MCP embutido — namespace `nexus_*`

Main hospeda MCP server (@modelcontextprotocol/sdk); cada CLI-agente conecta via stdio/socket local injetado no spawn. Tools principais:

| Grupo                     | Tools                                                                                                                                                                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Panes (10)                | `nexus_pane_spawn`, `nexus_pane_list`, `nexus_pane_list_providers`, `nexus_pane_read`, `nexus_pane_read_many`, `nexus_pane_write`, `nexus_pane_write_many`, `nexus_pane_close`, `nexus_pane_wait_idle`, `nexus_pane_wait_many`                                   |
| Handoffs (2)              | `nexus_handoff_submit`, `nexus_handoff_list`                                                                                                                                                                                                                     |
| Agentes (3)               | `nexus_agent_invoke`, `nexus_agent_list`, `nexus_agent_get`                                                                                                                                                                                                      |
| Missões (5)               | `nexus_mission_create`, `nexus_mission_get`, `nexus_mission_list`, `nexus_mission_set_status`, `nexus_mission_spawn_pane`                                                                                                                                        |
| Squad/Catálogo/Task (3)   | `nexus_squad_save`, `nexus_catalog_install`, `nexus_task`                                                                                                                                                                                                        |
| Todos (1)                 | `nexus_todo_manager`                                                                                                                                                                                                                                             |
| Roteamento (1)            | `nexus_route_task`                                                                                                                                                                                                                                               |
| Preview/Browser/Perf (11) | `nexus_preview_start`, `nexus_preview_stop`, `nexus_browser_open`, `nexus_browser_navigate`, `nexus_browser_screenshot`, `nexus_browser_read`, `nexus_browser_inspect`, `nexus_browser_click`, `nexus_browser_fill`, `nexus_browser_wait`, `nexus_perf_snapshot` |
| Design (1)                | `nexus_design_selection_get` — seleção visual redigida, hints de framework, candidatos de código e screenshot opcional                                                                                                                                           |

`nexus_handoff_submit` é uma fronteira física, não um status declarativo. O
main consome uma capability one-shot emitida pelo transporte HTTP MCP ou pelo
PTY-stream e grava, na mesma transação do handoff, missão, sessão,
incarnação, source, tool-call id e fingerprint de autoridade. Aceitar um task,
alimentar dependências e concluir a missão revalidam esse receipt e seu
`audit intent` correlacionado; cada resultado precisa ainda ser entregue e
consumido pela sessão física do Maestro. Alterar apenas `task.status` ou
fabricar um integration receipt nunca satisfaz “missão cumprida”.

Browser panes usam um preload isolado e um protocolo fechado: `browser_read`
retorna texto visível limitado e refs opacas (`e1`, `e2`), e as ações aceitam
somente essas refs — nunca JavaScript ou seletores arbitrários. Senhas/valores
de inputs/storage não entram no resultado. Toda navegação e redirect é
revalidada contra IPs privados/link-local/metadata; apenas origins de preview
emitidas pelo próprio Nexus são confiadas automaticamente, e outros destinos
privados exigem confirmação exata por host+porta.

### E.2.1 Live Design

O picker roda no preload sandboxed do browser pane, em ShadowRoot fechado.
Somente gestos nativos (`Event.isTrusted`) são aceitos; cada ativação recebe
uma geração UUID emitida pelo main, eventos repetidos ou antigos são
descartados e a sessão é limpa em navegação, troca de projeto ou fechamento.

O contexto combina DOM/estilos limitados, hints best-effort de React/Vue/
Svelte/Angular e busca heurística no workspace. Valores de form controls,
subárvores sensíveis, tokens e credenciais são podados/redigidos. Conteúdo da
página é serializado como dado não confiável antes de ser enviado ao agente.
O pane alvo precisa pertencer ao mesmo projeto/checkout, estar vinculado a uma
missão com contrato atual e estar no estágio PREVC `execution`.

O motor de write-back direto é opt-in por projeto. `src/main/design/` instrumenta JSX
com IDs efêmeros pertencentes à sessão, aplica range edits ou mudanças
estruturais reparsadas, usa CAS SHA-256 e rename atômico, recusa symlinks e
preserva edições externas. Undo/redo é byte-identical, reorder não cria keys
persistentes e o shutdown aguarda o cleanup. Uma janela por projeto/checkout
detém a autoridade, enquanto projetos diferentes podem operar em paralelo.
Na distribuição empacotada 0.12, `main.ts` registra esse IPC com
`allowSourceMutation: false`: status informa indisponibilidade, nenhuma
instrumentação/reorder é registrada e todas as mutações diretas falham
fechadas. O fluxo seleção → agente e o preview efêmero não dependem desse
motor e permanecem ativos.

**Anotações de design (paridade com o Design Mode do Orca, MIT):** o usuário
fixa notas numeradas em elementos da página (comentário + intenção
corrigir/mudar/pergunta/aprovado; teto 20/página) e envia TUDO de uma vez como
um feedback consolidado. O store é main-owned em `design-session.ts` — o
renderer só contribui a nota digitada; o contexto do elemento é o snapshot da
seleção já validada (congelado no momento do anotar). Badges numerados são
renderizados na página por uma camada própria do preload
(`browser-design-annotations.ts`, ShadowRoot fechado, só geometria — comentário
nunca chega à página), independente do picker: anotações sobrevivem ao modo
Design off e morrem com o documento (did-navigate limpa main + renderer via
evento de modo `navigation` sintetizado, e destrói junto com o pane). O envio
em lote (`design-annotation-format.ts`) numera os itens igual aos badges e
embala os dados da página no envelope não confiável padrão; os comentários do
usuário (confiáveis) e as instruções por intenção ficam fora do envelope.
`nexus_design_selection_get` lista as anotações da página junto da seleção.

Aliases curtos `pane_*`/`handoff_*` mantidos no registry (namespace duplo) para prompts/agentes que usam nomes não-prefixados. **Sempre permitidos independente de allowlist:** `ToolSearch`, `nexus_handoff_submit`, `nexus_handoff_list`.

### E.3 Handoffs — mecanismo durável

O NexusIDE controla handoffs por **3 hooks `.mjs` gerados por sessão+pane**: PostToolUse (registra o handoff), Stop (bloqueia a saída do worker se não houver handoff pendente, máx 3 tentativas), PreToolUse (skill-gate por whitelist, exit 2 se a tool/skill estiver fora da allowlist; `ALLOWED_TOOLS`/`ALLOWED_SKILLS` null = irrestrito). O worker chama `handoff_submit({status,summary,artifacts})`; o orquestrador coleta via `handoff_list`.

**Substrato durável:** em vez de marker files temporários no filesystem, o handoff é gravado numa tabela `handoffs` (SQLite) e um evento `orch:handoff.received` é emitido ao orquestrador; o Stop-gate consulta o DB, não o filesystem. Isso elimina corrida e lixo de arquivos e dá durabilidade + auditabilidade. Entrega automática quando o orquestrador fica ocioso. Como fallback de parsing no terminal, o marker `### NEXUS_HANDOFF v1` também é reconhecido. `outputSchema` valida `artifacts` no submit.

### E.4 Skill-gate (enforcement duplo)

Ao spawnar worker Claude-like, o Nexus injeta hook PreToolUse e um `$HOME` efêmero. Codex, AGY, OpenCode, Kimi e Grok governados também usam overlays privados por sessão: preservam somente a continuidade mínima de auth/sessão, recebem o MCP Nexus e materializam apenas as skills nomeadas na allowlist. Configurações executáveis do perfil real — plugins, hooks, comandos, agentes, skills e MCPs externos — não atravessam a fronteira; panes diretos continuam com o perfil completo do usuário. **Defesa em profundidade:** o MCP server ainda recusa server-side qualquer chamada fora da allowlist do bearer; o isolamento do perfil não substitui a autoridade main-owned.

No fluxo agêntico, o Squad Architect não aceita `allowedSkills` ou
`allowedTools` do JSON do modelo. O main deriva uma projeção determinística por
categoria, intersecta skills com o vocabulário Nexus conhecido/instalado e
repete a projeção na cópia runtime antes de calcular o snapshot/seal. UI
executor/reviewer recebe `impeccable`; QA/reviewer recebe `check-work` quando
instalada; arquitetura e segurança seguem suas allowlists próprias. Uma skill
visual não concede mídia implicitamente: somente o executor visual Codex,
quando o objetivo main-owned pede geração de asset, recebe exatamente
`nexus-visual-media`, `nexus_media_providers` e `nexus_image_generate`; os
demais workers ficam com `allowedTools=[]`. A skill main-owned proíbe
`imagegen`, `hatch-pet`, API key ambiente e o diretório privado
`generated_images`. `nexus_image_generate` continua `requiresConfirm`, registra
uso/custo e só grava dentro do workspace.

Um worktree é fronteira de integração Git, não sandbox de processo. Por isso,
`isolated_worktree` só autoriza escrita autônoma quando o adapter builtin
também possui confinamento nativo qualificado e o main o reaplica no último
spawn. Na release 0.19.31 essa capacidade é fechada ao Codex 0.145.0:
`workspace-write` + aprovação `never`, sem bypass, `--add-dir`, troca de raiz
ou profile/config capaz de ampliar o processo. CLIs não qualificadas continuam
em panes diretos/manuais, mas não entram no conjunto mutante do Guided
Scheduler.

Subprocessos de tools do Codex mutante recebem rede somente pelo proxy
`limited` da sessão: MITM/CA local, GET/HEAD/OPTIONS e uma allowlist exata de
registries centrais. POST, GitHub, `storage.googleapis.com`, binding local,
proxy upstream e SOCKS ficam negados; read-only fica sem rede. A política
canônica, seu hash e a ressalva sobre configs de registro existentes no
workspace aparecem na aprovação apenas quando o roster realmente contém um
executor Codex workspace-write.

O Pet Studio é uma exceção de execução de agente único, não uma exceção ao
isolamento. O perfil main-owned concede ao Pet Maker Codex escrita apenas no
workspace e mantém subprocessos offline. A skill `nexus-pet-studio` usa
`nexus_media_providers`, `nexus_image_generate` e o Pillow retornado por
`load_workspace_dependencies`; seu output é filho direto de
`artifacts/nexus-pet-studio/<missionId>/`. O worker nunca escreve no HOME real.
Após um `nexus_handoff_submit` com provenance física da sessão, main abre e
valida os dois arquivos por descriptor, rejeita symlink/hardlink e publica por
rename atômico em `~/.codex/pets`, sem sobrescrever ids divergentes. Recovery
reexamina somente o output exclusivo daquela missão.

### E.5 Matriz de capacidades

| Capacidade                                                                  | Seção      | Detalhe                                                                                                          |
| --------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------- |
| Grid de panes (CLI/shell por pane)                                          | §C.2, §B.4 | split-tree; layout em SQLite/Zustand                                                                             |
| Spawn de agente (providerId/model/cwd)                                      | §B.4       | adapters cli-pty: claude\|codex\|agy\|kimi + qualquer CLI via JSON                                               |
| Providers HTTP + `pane_list_providers`                                      | §D.2, §E.2 | api-provider (glm/fugu)                                                                                          |
| Squads (id/name/createdAt/builtin/orchestratorInstructions/agents[])        | §E.1       | category inclui orchestrator; effort low\|high\|xhigh; allowedSkills/allowedTools por agente; export/import JSON |
| Skill-gate (`$HOME` efêmero + hooks .mjs)                                   | §E.4       | PreToolUse exit 2; null=irrestrito; sempre: ToolSearch/handoff_submit/handoff_list                               |
| Missões (create/get/list/set_status/spawn_pane)                             | §E.1, §E.2 | Estado em `~/.nexus/nexus.db` (better-sqlite3)                                                                   |
| `todo_manager` + milestones visíveis                                        | §E.2       | —                                                                                                                |
| Handoffs (submit/list; 3 hooks .mjs; Stop máx 3; artifacts/outputSchema)    | §E.3       | SQLite + IPC tipado (durável, auditável)                                                                         |
| Entrega auto quando ocioso + marker `### NEXUS_HANDOFF v1`                  | §E.3       | —                                                                                                                |
| Catálogo (aitmpl 70+ agentes, davila7/claude-code-templates)                | §E.6       | API `GET /api/catalog/search?q=&kind=agent\|skill\|command&limit=`; plugin `.claude-plugin/plugin.json`          |
| Voz/ditado (audio-config)                                                   | §F         | groq/whisper-large-v3/pt→english/hold/Space/coding/190wpm/4700ms — estendido p/ Jarvis (TTS)                     |
| MCP tools                                                                   | §E.2       | namespace `nexus_*`; panes, missões, squads, preview/browser e perf                                              |
| Auth backend (Supabase + Google OAuth)                                      | opcional   | NexusIDE v1 é local-first — auth de nuvem é OPCIONAL, não requisito                                              |
| Config dirs (`~/.nexus/`: squads.json, audio-config.json, plugins/, cache/) | §D.4       | tudo unificado sob `~/.nexus/`                                                                                   |
| Auto-update (Squirrel)                                                      | §G.4       | Forge maker ZIP + Squirrel.Mac                                                                                   |
| Canvas infinito arrastável                                                  | §C.3       | 🚀 além do grid split-tree                                                                                       |
| Multi-CLI universal declarativo                                             | §D         | 🚀 adapters JSON tipados p/ qualquer CLI                                                                         |
| Resposta falada TTS (Jarvis)                                                | §F         | 🚀 ditado E fala de volta                                                                                        |
| UI de debug de missões/handoffs                                             | §E.6       | 🚀 timeline + edges animadas                                                                                     |

### E.6 Decisões de robustez e diferenciais

1. **Secrets sem cripto caseira:** nunca implementar criptografia própria. Usar **macOS Keychain** via `safeStorage`/`keytar`; se indisponível, **libsodium** (secretbox) com **fallback gracioso** e nunca degradar para plaintext. Secrets jamais em SQLite/logs.
2. **Handoffs duráveis:** **SQLite + IPC tipado** (§E.3) em vez de marker files temporários — durável, auditável, sem corrida.
3. **Export/import de squads:** JSON nativo do squad schema (§E.1).
4. **Modo canvas:** @xyflow/react arrastável além do grid split-tree (§C.3).
5. **UI de debug de missões:** view dedicada — timeline de missões, estado de workers, handoffs em voo como edges animadas no canvas, inspeção de artifacts.

**Catálogo (integração aitmpl):** davila7/claude-code-templates, 70+ agentes. `nexus_catalog_install` chama `GET https://.../api/catalog/search?q=<termo>&kind=agent|skill|command&limit=<n>` e instala plugins no formato `.claude-plugin/plugin.json` em `~/.nexus/plugins/`.

---

## F. Pipeline de Voz Jarvis

### F.0 Config base de áudio (JSON)

```jsonc
{
  "provider": "groq",
  "baseUrl": "https://api.groq.com/openai/v1",
  "model": "whisper-large-v3",
  "language": "pt",
  "outputMode": "english",
  "captureMode": "hold",
  "pushToTalkKey": { "code": "Space" },
  "interactionMode": "coding",
  "targetWpm": 190,
  "chunkMs": 4700,
}
```

NexusIDE parte deste **formato base** e o estende com: bloco `stt.vad` (Silero), `stt.fallback` (whisper.cpp local), bloco `tts` completo (OpenAI tts-1 streaming → Piper → macOS say) e **resposta falada** (o diferencial Jarvis). O formato estendido é um superset compatível; a migração de configs legadas lê apenas `~/.nexus/`.

### F.1 Fluxo integrado à topologia de processos

```
Hotkey global: globalShortcut(keydown) + uiohook-napi(keyup, pois globalShortcut não emite key-up)
  → renderer 'voice:ptt.start'
[Renderer] getUserMedia 16kHz mono + AudioWorklet → PCM chunks → ipc 'voice:chunk'
[Main] Silero VAD (onnxruntime-node) — silêncio descarta (minSpeechMs 300, maxSilenceMs 800)
[Main] STT Groq whisper-large-v3 task=translate PT→EN (fallback whisper.cpp base/Metal)
[Main] ROTEAMENTO (§F.2): session:write no pane-alvo OU orquestrador
[Agente processa] → resposta texto (pane_read / handoff summary)
[Main] Sumário falável (§F.3) → TTS OpenAI tts-1 streaming voz onyx
       (fallback Piper pt_BR-faber-medium → macOS say Luciana) → 'voice:tts.chunk'
[Renderer] Web Audio playback → usuário OUVE (Jarvis)
```

Latência v1 cloud: ~2.5–5s ponta-a-ponta (aceitável p/ IDE).

### F.2 Roteamento

`voice.routing: 'focused-pane'(default) | 'orchestrator' | 'ask'`. Voz vira texto injetado via `session:write` (idêntico a digitar). Com Squad ativo, pode ir ao orquestrador que delega via MCP.

### F.3 Resposta falada (Jarvis)

Além de ditar→injetar, o NexusIDE **fala de volta**: fonte = summary de `handoff_submit` ou última resposta idle (via pane_read); passo de condensação leve → 1–3 frases faláveis; código/texto longo NÃO é falado na íntegra. `voice.speakMode: 'summary'(default)|'full'|'off'`. TTS streaming: 1ª palavra ~500ms.

### F.4 Decisões v1 pinadas

✅ Push-to-talk ✅ STT batch (Groq rápido) ✅ tradução no ASR (task=translate)
✅ TTS streaming. Wake word offline usa o pipeline SpeechKit/openWakeWord com
head SpeechKit Apache-2.0 e hashes pinados; nenhum modelo de frase NC é enviado.

---

## G. Persistência, Modularidade, Segurança, Empacotamento

### G.1 Persistência (better-sqlite3, `~/.nexus/nexus.db`)

Síncrono no main; migrations versionadas. Tabelas (design): workspaces, views(kind, layout_json, viewport_json), sessions(adapter_id, provider_id, model, cwd, status, serialized_buffer), missions(status, milestones_json), handoffs(from_worker, summary, status, artifacts_json, output_schema_json), squads(orchestrator_instructions, roster_json), configs(key, value_json), adapters_meta(kind, version, source, enabled). Layout, sessões, missões e handoffs ficam unificados neste único SQLite. **Secrets NÃO ficam aqui** — Keychain (§G.3).

### G.2 Modularidade

Temas (JSON, CSS custom properties `--color/*text/*space/*duration` — sem palette hardcoded; terminal 16-ANSI + UI; light E dark ambos intencionais). Keybindings (JSON command→key, chords, command registry central). Layouts (workspaces salvos reabríveis, templates instaláveis). Plugins (adapters/voice/themes/keybindings, hot-reload). Sistema de plugins inspirado em Tabby (DI→React context) e Hyper (composição) — referência, não porte (Hyper abandonado).

### G.3 Segurança

| Superfície            | Controle                                                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer              | contextIsolation/sandbox true, nodeIntegration false, sem remote                                                                                                                                     |
| IPC                   | zod no receptor; contextBridge mínimo; sem ipcRenderer cru                                                                                                                                           |
| CSP                   | estrita (default-src 'self', sem unsafe-eval, sem remote scripts)                                                                                                                                    |
| Spawn                 | node-pty só no PTY Host; argv array (sem shell-string concat); panes diretos preservam perfil; workers governados usam overlay privado por sessão com auth mínima e extensões executáveis bloqueadas |
| **Secrets**           | **macOS Keychain (safeStorage/keytar) ou libsodium (secretbox) como fallback gracioso — sem cripto caseira, nunca plaintext.** Nunca em SQLite/logs; resolução on-demand no spawn                    |
| Skill-gate            | client (hook) + server (MCP) — defesa em profundidade                                                                                                                                                |
| Plugins untrusted     | JSON fail-fast; adapters não executam código arbitrário (só declaram argv/env)                                                                                                                       |
| Mic                   | entitlement microphone + NSMicrophoneUsageDescription; captura só sob PTT                                                                                                                            |
| Auth nuvem (opcional) | Auth de nuvem (Supabase/Google OAuth) NÃO é requisito v1 (local-first); se adicionada, tokens no Keychain                                                                                            |

### G.4 Empacotamento (.dmg)

Electron Forge: maker-dmg (final) + ZIP (auto-update Squirrel.Mac). Signing `@electron/osx-sign` (Developer ID). Notarization `@electron/notarize`. Entitlements: microfone + hardened runtime + allow-jit (V8). Native rebuilds: @lydell/node-pty, better-sqlite3, onnxruntime-node, uiohook-napi, keytar (prebuilt multiarch; universal arm64+x64). macOS-only. URL scheme `nexus://`.

---

## H. Plano de Build Faseado

**2a — Shell+Grid+Terminal:** Forge scaffold; Main+Renderer+PTY Host; IPC+zod; xterm+addons; grid split-tree; spawn shell. _Verificável:_ grid splita, cada pane roda zsh real; matar PTY Host não derruba app.

**2b — Adapters:** registry + zod (cli-pty/api-provider); hot-reload; seletor por pane; adapters JSON (claude/codex/agy/kimi/grok/aider/opencode + glm/fugu); stateParsing. _Verificável:_ spawn claude+codex; adicionar CLI nova só dropando JSON (sem rebuild); pane_wait_idle correto.

**2c — Canvas:** @xyflow/react; pane=custom node; pan/zoom/minimap; SessionSurfacePool (reparent grid↔canvas sem re-spawn); frozen em zoom-out; edges de orquestração. _Verificável:_ alternar grid↔canvas mantém MESMO PTY vivo; fluido com ≥6 terminais.

**2d — Orquestração+MCP:** MCP server no namespace `nexus_*`; domínio squads(schema)/missões/handoffs (SQLite+IPC, não marker files); todo_manager; skill-gate duplo; entrega auto ocioso; parser do marker `### NEXUS_HANDOFF v1` (fallback); catálogo aitmpl. _Verificável:_ Squad orquestrador+2 workers delega via pane_spawn/write; worker handoff_submit; entregue ao ficar ocioso; skill fora da allowlist BLOQUEADA; export/import de squad funciona.

**2e — Voz Jarvis:** PTT (globalShortcut+uiohook keyup); getUserMedia+AudioWorklet; Silero VAD; STT multi (Groq+whisper.cpp); roteamento; TTS streaming (OpenAI→Piper→say); sumário falável; voice plugin estendendo audio-config. _Verificável:_ segurar PTT, falar PT, ver EN injetado, agente responde, **NexusIDE fala resumo**; sem key → whisper.cpp+Piper/say.

**3 — QA+.dmg:** testes (unit domínio/adapters/parsers; integração IPC/MCP; E2E Playwright: grid/canvas/spawn/handoff/voz); a11y + reduced-motion; signing+notarization; universal .dmg. _Verificável:_ .dmg assinado+notarizado instala em máquina limpa; E2E verde; 3 fluxos-farol (multi-CLI, canvas, Jarvis) passam.

---

## I. Riscos e Alternativas Descartadas

### I.1 Descartados

| Descartado               | Em favor de           | Razão                                                                                    |
| ------------------------ | --------------------- | ---------------------------------------------------------------------------------------- |
| Tauri (Rust)             | Electron              | node-pty/xterm-webgl/uiohook/onnx Node-native; WKWebView quirks; 2 linguagens/toolchains |
| tldraw                   | @xyflow/react         | Licença SDK comercial paga                                                               |
| Gemini CLI               | Antigravity (agy)     | Descontinuada 18/jun/2026                                                                |
| electron-builder         | Electron Forge        | Oficial; signing/notarization out-of-box                                                 |
| Realtime duplex voz      | Batch v1              | Complexidade WebSocket+sync = risco alto; v2                                             |
| Wake word em v1          | Push-to-talk          | Porcupine comercial; PTT zero falso-positivo; v2                                         |
| Backend Go (Wave)        | Node/TS no main       | 1 linguagem (TS em todos os processos)                                                   |
| Wrapper 'shell' genérico | Adapters JSON tipados | wrapper genérico não dá handoff/estado/modelos nativos                                   |
| Cripto caseira           | Keychain/libsodium    | risco de vazamento; Keychain é o padrão macOS                                            |
| Marker files p/ handoff  | SQLite+IPC            | Corrida/lixo/frágil                                                                      |
| Copiar Claude Squad      | Só ref UX             | AGPL-3.0 copyleft                                                                        |

### I.2 Riscos e mitigações

| Risco                                    | Sev   | Mitigação                                                           |
| ---------------------------------------- | ----- | ------------------------------------------------------------------- |
| Crash node-pty derruba app               | Alta  | PTY Host utilityProcess isolado + re-spawn                          |
| xterm-webgl pesado no canvas             | Alta  | frozen snapshot em zoom-out; onlyRenderVisibleElements; SurfacePool |
| CLIs mudam flags (grok beta, kimi novo)  | Média | Quirks no adapter JSON — patch sem rebuild                          |
| Alt-screen TUI idle/busy difícil         | Média | stateParsing + OSC 133 + timeout (agy --print-timeout)              |
| Latência voz alta                        | Média | Batch Groq + TTS streaming + fallback local                         |
| Pricing STT/TTS incerto                  | Baixa | Providers plugáveis; default Groq barato; fallback local            |
| Notarization falha em native modules     | Média | Prebuilt multiarch; hardened runtime; testar signing cedo           |
| Skill-gate contornável                   | Alta  | Enforcement duplo (hook + MCP server-side)                          |
| Secrets vazando                          | Alta  | Só Keychain/libsodium; nunca SQLite/logs                            |
| @lydell/node-pty é beta (v1.2.0-beta.12) | Média | maduro na prática; fallback node-pty-prebuilt-multiarch             |

---

## Apêndice — Reuso OSS (licenças)

| Fonte                                                                                                                               | Licença        | Uso                                    |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------- |
| Electron, xterm.js, @lydell/node-pty, @xyflow/react, Silero VAD, uiohook-napi, Piper, whisper.cpp, better-sqlite3, onnxruntime-node | MIT/Apache/BSD | Bundle direto (atribuição)             |
| Wave Terminal                                                                                                                       | Apache-2.0     | Ref arquitetural (bloco/sync/SQLite)   |
| VS Code terminal                                                                                                                    | MIT            | Ref (Pty Host, ShellIntegrationAddon)  |
| Tabby                                                                                                                               | MIT            | Ref plugin system                      |
| Hyper                                                                                                                               | MIT            | Ref composição (abandonado — não base) |
| Conductor (MS)                                                                                                                      | MIT            | Ref delegação                          |
| Claude Squad                                                                                                                        | AGPL-3.0       | Só UX (não copiar código)              |
| tldraw                                                                                                                              | Comercial      | ❌ não usar                            |

_Fim. Documento prescritivo — decisões de stack, processos, panes, adapters, orquestração, voz e segurança tomadas e justificadas nos próprios termos do NexusIDE._
