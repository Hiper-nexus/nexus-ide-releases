# Dossiê Técnico — Frontend BridgeSpace 3.4.18

**Fonte:** engenharia reversa do binário Tauri (brotli carve) em
`docs/analysis/bridgespace-3418-extract/frontend/` — ~90 chunks Vite minificados
mas legíveis. Data da análise: 2026-09-03.

**Stack confirmada:** Tauri 2 (Rust) + React 19.2.4 (`vendor-react`, React DOM
embutido no entry), xterm.js (`vendor-xterm-core`/`vendor-xterm-addons`),
CodeMirror 6 (`vendor-codemirror`), markdown-it/remark (`vendor-markdown`),
Radix UI primitives (ContextMenu etc.), lucide-react 0.562, Tailwind (tokens
`bg-background`, `text-text-primary`, `bg-primary`...), d3 (grafo do
BridgeMemory), Sentry (telemetria de erro) e PostHog (`posthogCapture`, eventos
de produto). Sem roteador (nenhum `react-router`/`HashRouter`): a navegação é
uma máquina de estados própria em `MainApp`.

---

## 1. Arquitetura do frontend

### 1.1 Boot e camadas

```
index.html
 └─ index-D0sLjlYW.js        entry: React DOM + Sentry + error handlers + mount
     └─ AuthenticatedShell-B6g16bmQ.js   gate de autenticação/assinatura (97 KB)
         └─ MainApp-Bsp7gQmz.js          shell principal (1,1 MB — monólito)
             ├─ PaneWorkspace, WelcomeScreen, KanbanBoard, SettingsPage,
             │  SkillsPage, SwarmWorkspaceView, BridgeMemoryPage, BridgeCanvas,
             │  BridgeCodeView, RunTaskModal, modais SSH, modais de update
             ├─ swarm-*.js / handoff-*.js / ambient-agent-detector (lazy)
             └─ tauriApiCompat-Dma6bZXU.js  ponte IPC `window.tauriAPI` (58 KB)
```

- **`index-D0sLjlYW.js`** — além do React DOM, contém o bootstrap real:
  - Sentry com *event processor* que filtra ruído conhecido e sanitiza payloads
    (`ya()` faz deep-sanitize de Error/objetos antes de `captureException`).
  - Handlers globais de `unhandledrejection` e `error`.
  - **Detector de "stale chunk"**: se um dynamic import falha (deploy
    half-updated), recarrega a página até N tentativas; esgotado o orçamento,
    renderiza tela preta "BridgeSpace failed to start" com botão Reload
    (`_g()`/`Ey()`).
- **`AuthenticatedShell-B6g16bmQ.js`** — error boundary de renderer ("BridgeSpace
  hit an unrecoverable UI error", botões Reload/Send Feedback), gate de
  assinatura ("BridgeSpace could not verify your subscription yet…" com estados
  `offline/auth/server/unknown`), config de endpoints HTTP e cliente de API
  (ver §3.2), e o lazy-load do `MainApp`.
- **`MainApp-Bsp7gQmz.js`** — o "sistema operacional" do app: registro de
  agentes CLI, workspaces, panes, notificações (com som sintetizado via
  WebAudio: `AudioContext` + BiquadFilter lowpass, toggle
  `bs.notifications.sound`), sons de alerta, wizard de criação de workspace,
  swarm store, histórico.

### 1.2 Roteamento = máquina de estados, não URL

Não há rotas. `MainApp` mantém `activeView` + `workspaceType` +
`showWelcomeScreen` e faz lazy-import por view (`React.lazy` com wrapper de
retry `Np("NomeView.preload", …)`). IDs de view encontrados: `terminal`,
`kanban`, `skills`, `browser`, `jarvis` (assistente de voz), mais as views de
workspace `swarm`/`canvas`/`code`/`memory`/`settings`. Views com preload
antecipado no boot: `WelcomeScreen`, `BridgeMemoryPage`.

### 1.3 Estado global

Estado em stores vanilla (padrão `subscribe`/`getSnapshot` — estilo zustand
reimplementado) exportados como bindings minificados do MainApp (ex.: `cx`,
`d$`, `e0`, `cR` usados pelo `swarmSessionResume`). Persistência quase toda em
`localStorage` com chaves namespaced:

- `bridgespace-preferred-agent` — agente CLI padrão (default `claude`)
- `bridgespace.swarm-scope-migration-v1` — flag de migração de escopo
- `bridgespace-auto-update-on-launch-enabled` — update-on-launch (ApiKeyService)
- `bridgespace.terminalInputDebug.v1`, `bridgespace.terminalImeDirectCommit.v1`
- `bs.notifications.sound` — som de notificações

---

## 2. Catálogo de features (tela a tela)

### 2.1 WelcomeScreen (`WelcomeScreen-kX1kluDM.js`)
Tela de boas-vindas estilo marketing: "Build the future. Choose how you want to
work." com 4 cartões que vendem os 4 modos do produto:
1. **"The terminal built for vibe coding"** — split panes, command blocks, agente em cada shell.
2. **"A team of agents, in parallel"** — swarm de agentes que "build, review, and ship together".
3. **"Plan the work, work the plan"** — kanban para "turn loose ideas into shipped tasks".
4. **"A living knowledge graph"** — BridgeMemory: memória persistente que agentes leem e escrevem.

### 2.2 Workspace setup wizard (em `PaneWorkspace-BN9oxoE0.js`)
"Create a workspace — Pick how you'd like to work":
- **BridgeSpace** ("recommended") — grade limpa de terminais.
- **BridgeSwarm** ("advanced multi-agent workflow") — time de agentes com um objetivo.
- **BridgeCanvas** — canvas de terminais livre.
- Atalho: "Open a single terminal".

Depois: escolha de pasta ("Working folder"), número de terminais com tiles de
layout, **presets salvos** ("Save current setup as a preset", "One-click
launch", "Last opened workspaces"), atribuição de agentes por terminal
("Assign agents across your N terminals", "Split evenly", "Add custom command",
"Skip — no agents").

### 2.3 PaneWorkspace — grade de terminais
- Splits redimensionáveis (biblioteca de painéis estilo react-resizable-panels
  embutida), layout tree com error boundary (`PaneLayoutErrorBoundary` desativa
  recovery após erros repetidos de "layout-race").
- **Restore de terminais com guardrails de segurança** — estados textuais:
  "Terminal restore paused", "Paused after a high-terminal-count exit was
  detected", "Automatic restore stopped after another terminal failed", "The
  saved working folder is no longer available", "SSH reconnect requires
  explicit confirmation", "Automatic terminal restore is disabled by the safety
  switch" + ações "Restore terminal", "Restore all anyway", "Choose folder",
  "Resume bound agent".
- **"Resume your agents"** (`MainApp`): painel listando agentes "Running when
  BridgeSpace last closed. Pick up where you left off." com botão fechar que
  mantém sessões recuperáveis.
- Menu "Terminal actions" por pane (`SimpleTerminalPane`): Generate handoff,
  Create git worktree, Open git panel, Copy current path, Copy output, Open
  current directory, Reopen with shell, Open elevated shell. Chip de custo por
  agente ("· Est. cost", "Waiting for agent activity…", "Available after the
  first Codex response").

### 2.4 SimpleTerminal — terminal + AI inline autocomplete ("ghost text")
(`SimpleTerminal-M-KTTCPg.js`, 88 KB)
- Parse de **OSC 133** (semantic prompt: A/B/C/D) para saber se o usuário está
  digitando ou se há comando rodando; **OSC 9;9** para cwd. Buffer de input
  reconstruído por keystroke; ESC conta "missed capture".
- **Ghost text** (sugestão cinza inline): duas fontes com prioridade —
  1. **Local**: histórico ranqueado por *frecency* no backend SQLite
     (`history_lookup`, engines configuráveis via `history_set_ranking_engine`),
     escopos `local-cwd` / `local-project` / `local-global`; suprime `cd`
     redundante para o cwd atual.
  2. **LLM**: endpoint remoto `TERMINAL_ASSIST.PREDICT`/`SUGGEST`/
     `SUGGEST_STREAM` na API BridgeMind, com debounce 400 ms, min 3 chars,
     cache LRU de 200, AbortController por request.
- Telemetria PostHog: `terminal_assist_ghost_shown` / `_accepted` /
  `_dismissed` (também espelhados como comandos Tauri homônimos). "Dismiss" por
  divergência de buffer registra denylist (`history_dismiss_suggestion`).
- Backpressure: dropa output bufferizado além de limites com mensagem
  "[bridgespace: dropped N bytes total of buffered output due to backpressure]".
- Command blocks: cada comando vira bloco com cwd, git branch, exit code,
  duração — base do handoff e do histórico.

### 2.5 KanbanBoard (`KanbanBoard-C40V2t93.js`)
Quadro de tarefas com colunas **To Do / In Progress / In Review / Complete /
Cancelled**. Cards têm `instructions` (título+descrição), `taskKnowledge`
(markdown renderizado, com preview truncado), aba de anexos
(`TaskAttachmentsTab`, upload/download/finalize via API `/tasks/:id/attachments`),
e **"Run task"** → `RunTaskModal`: escolhe agente CLI, toggle "Skip permission
prompts (--dangerously-skip-permissions)" e dispara o agente com as instruções
da tarefa (`Cmd+Enter to run`). Sincroniza com backend `/tasks` (CRUD, subtasks,
claim, comments, dependencies).

### 2.6 SkillsPage (`SkillsPage-mNINH9N6.js`)
Gerenciador de *skills* (prompts reutilizáveis): built-ins read-only ("Built-in
skill — read-only") e custom ("Custom skill", Create/Edit/Delete). Seção "Skill
Sync" nas Settings sugere sync com backend.

### 2.7 SettingsPage (`SettingsPage-Bc3SVYwB.js`, 219 KB — a maior view)
Seções (ids reais): **account, appearance, terminal, agents, mcp, mobile,
notifications, shortcuts, billing, jarvis, about** (+ cline?). Destaques dos
labels: "Agents & AI", "Agent hooks", "Swarm guardrails", "Swarm roles",
"Autocomplete", "Default shell", "History" (enable/denylist/ranking engine/
export JSONL/"Reveal db"), "MCP Servers" (transport/url/headers/env/command),
"Mobile" (pareamento), "Bridge Assistant" + "Push to talk" (voz), "Bridge
server", "API Keys" (New key/rotate/revoke), "Billing" (Stripe: "Cycle grant",
"Cycle spent", "Payment methods", checkout/portal), "Updates" ("Check for
updates", "Download latest .deb/.rpm"), "Diagnostics", "Application" (app zoom
slider), terminal font family/size, temas Light/Dark.

### 2.8 SwarmWorkspaceView (`index-C3qSma5A.js`, 108 KB) — a peça central
- **Board visual de agentes**: chips flutuantes por agente (`swarm-chip`),
  cores por papel (**coordinator / builder / scout / reviewer** — variáveis
  `--agent-coordinator` etc.), "swarm-ping" de atividade, pan/zoom ("Fit to
  content", "Cycle density mode", "Click a chip to inspect · drag to pan").
- **Command bar** "Direct the Swarm…" com **@mentions** de agentes e diretivas
  rápidas: "Post a brief status report…", "Wrap up your current task and report
  completion", "Pause after finishing your current step…".
- **Message feed** do mailbox ("No messages yet — Send a message below or wait
  for agents to communicate"), tipos: message / status / worker_done /
  swarm_complete / escalation; "Open chat at the latest escalation".
- **Mission brief** popover ("No mission brief — click to add one"), painel de
  goals/tasks ("Mission seeded — the coordinator is decomposing it into goals
  and tasks"; "The coordinator should use `bs-swarm task create` so this panel
  can track ownership and progress").
- Header com ações: "Resume previous sessions" (vs "New CLI sessions briefed
  from the swarm board"), "Respawn the agents…", "Nudge coordinator", stop
  ("Agents finish their current writes, then exit" vs "Destroy all live
  sessions immediately"), "Mission complete" card ("Completed agents still hold
  their terminal sessions — stop to release them").
- Keyboard shortcuts sheet (command bar, cycle selection, fit, zoom, Esc,
  toggle help).

### 2.9 BridgeMemory (`index-DAcJ4vIR.js`)
Knowledge graph local ("hub"): busca com palette ("type to filter"), seções
("Delete section (memories return to root)"), drag de memórias ("Drop memories
here"), "Copy as wikilink", "Reveal in Finder", "Remove from BridgeMemory
(Files on disk are not deleted)", grafo d3. Comandos `bridgememory_install`,
`bridgememory_discover_hubs`, `bridgememory_revoke_runtime`; auto-instala MCPs
(`installAllBridgeMemoryMcp`/`uninstallAllBridgeMemoryMcp`, chunk
`index-CRbQOgLM`).

### 2.10 BridgeCanvas (`index-D6EeKRiU.js`)
Canvas free-form de terminais com o **"Bridge voice orchestrator"** (codinome
`jarvis`): "Tell Bridge what to run across the canvas…", "Tap to orchestrate",
transcript de conversa ("New conversation", "Collapse transcript"),
orquestração por voz com "Push to talk". Backend via `poll_bridgevoice_inject`.

### 2.11 BridgeCodeView (`index-DZWbKrEm.js`)
View de chat estilo Cursor que **dirige o Codex CLI num terminal oculto**:
monta comando `codex exec` com workspace/thread/sandbox, faz parse de eventos
JSONL linha a linha (`dispatchItem`, "Codex is working", dots animados),
renderiza mensagens/comandos com exit codes, composer markdown
("bc-composer-shell"). "A turn is already running".

### 2.12 SSH (`SshConnectionModal`, `SshPassphraseModal`, `HostKeyVerificationModal`)
- Modal de conexão: host/user/porta, 4 métodos de auth — **ssh-agent** ("Most
  secure. Uses your OS ssh-agent (or 1Password / YubiKey…)"), **senha**
  ("Stored in your OS keychain when remembered"), **arquivo de chave**
  ("Encrypted keys will prompt for a passphrase"), **entrada do ~/.ssh/config**
  (`ssh_parse_config` importa profiles).
- "Startup command" ("Great for attaching a named tmux/zellij session"),
  "Default directory", "Remember this host", duplicate/delete profiles.
- Host key verification dedicada (`ssh_verify_host_key` — fluxo TOFU) e modal
  de passphrase com opção de gravar no keychain (`ssh_store_credential`,
  `ssh_forget_key_passphrase`, `ssh_has_key_passphrase`).
- Upload de arquivo para terminal remoto (`ssh_upload_terminal_file`).

### 2.13 Updater (`UpdateNotificationModal`, `UpdateOnLaunchOverlay`)
- **Update-on-launch** (opt-in, `bridgespace-auto-update-on-launch-enabled`):
  overlay bloqueante no boot — "Checking for a new version…", "Download
  progress", "BridgeSpace will restart automatically when the install
  completes"; fallback "BridgeSpace will continue with your existing version.
  You can retry from Settings → App updates". Integra com crash sentinel
  (`crash_sentinel_expect_updater_restart`).
- Modal in-app: "Update vX available" → download → "Install and Restart";
  indicador de status persistente; erros de rede traduzidos para texto amigável
  ("could not reach the update server. Check your internet connection, VPN,
  proxy…").

### 2.14 Autenticação e conta (`AuthenticatedShell` + `tauriApiCompat`)
- Login **web-oauth via browser**: `start_web_login` abre
  `www.bridgemind.ai/login/bridgespace…` e retorna por deep link
  `bridgespace://auth/callback` (dev: `bridgespace-dev://`), página
  `auth-success.html`. Tokens guardados pelo lado Rust (cookie `bmrt`,
  `refresh_tokens`, storage criptografado com erro tipado
  `StorageNotInitializedError`).
- Gate de assinatura com retry automático e estados offline/auth/server.
- Eventos de auth do backend: `auth_principal_changed`,
  `auth_refresh_envelope_invalid`, `auth_refresh_revoked` → "auth:signed-out".

### 2.15 Extras
- **Browser sidebar**: webview filho embutido (`browser_sidebar_mount`,
  navigate/resize/capture, picker mode para selecionar elementos da página).
- **Mobile bridge**: servidor local (127.0.0.1:47421 ou LAN 0.0.0.0) com token
  rotacionável para app companion (`mobile_bridge_*`).
- **Drag & drop global**: `DropZoneOverlay` + `FileDropToast`,
  `fs_copy_dropped_file` (anexos de tarefa e "supporting knowledge" do swarm).
- **Git**: status/diff/log/commit/stage, worktrees (`git_create_worktree`),
  review de diffs (`git_review_diffs`) — painel Git por pane.
- **History**: histórico de comandos local (SQLite no Rust) com frecency,
  denylist, export JSONL, "first run", ranking engine configurável, e
  `history_record_agent_session` para rastrear sessões de agentes (base do
  resume).
- **Shell integration** (`shellIntegration-B-SsC1Nz.js`): instala bloco no
  `~/.zshrc` emitindo OSC 133 + OSC 9;9 em shells externos (marcadores
  `# >>> BridgeSpace shell integration >>>`), removível; "Safe to delete this
  block". Só instala fora do shell primário do app para não duplicar.

---

## 3. Como o cliente fala com o backend

### 3.1 IPC Tauri (`tauriApiCompat-Dma6bZXU.js`)

O chunk define `window.tauriAPI = { terminal, ssh, mobileBridge, git, system,
dialog, fs, window, browserSidebar, shell, bridgememory, mcp, history,
agentUsage, api, authFlow, updater }` e atribui `window.tauriAPI=Gr` no fim.

- **Comandos**: `invoke("<cmd>")` — 156 nomes distintos usados pelo renderer
  (154 em `tauri-commands.txt` + `logout`, `refresh_tokens`, `start_web_login`,
  `poll_bridgevoice_inject`, `system_*`, `shell_*`, `window_*`, `wsl_*`).
  Famílias: `terminal_*` (17), `fs_*` (17), `history_*` (30), `ssh_*` (16),
  `git_*` (12), `mcp_*` (11), `mobile_bridge_*` (7), `browser_sidebar_*` (10).
- **Streaming via Tauri `Channel`**: dados de PTY não vêm por eventos globais;
  cada `terminal_create`/`terminal_attach` recebe `dataChannel` e
  `exitChannel` (objetos `Channel` com `onmessage`), entregando stdout e exit
  por canal dedicado — modelo de alta vazão do Tauri 2.
- **Eventos** (`listen`): `fs:change` (watcher), `auth:signed-out`, eventos de
  janela (focus/blur/theme/drag-drop via plugin window), updater.
- **Browser-mock mode**: se não há runtime Tauri (`s()`), toda a API vira mock
  ("[BridgeSpace Browser Mode] Terminal UI preview — no PTY available") — o app
  roda no navegador para desenvolvimento/preview.
- Resiliência: caches com TTL de cwd (`terminal_get_cwds` batch),
  coalescing de chamadas in-flight, dedup de attach (`attach` memoizado),
  `writeChecked` vs `write` fire-and-forget, tradução de erro de storage.

### 3.2 API HTTP BridgeMind (`AuthenticatedShell`)

Cliente REST com **retry (3x, status 408/429/5xx) + circuit breaker (5 falhas,
reset 60 s)**, timeout 30 s, refresh de token com buffer de 300 s. Ambientes:
- produção: `https://api.bridgemind.ai`, app `https://app.bridgemind.ai`,
  MCP `https://mcp.bridgemind.ai/mcp`, site `https://www.bridgemind.ai`
- dev: `localhost:8080` / `localhost:3000` / `localhost:4000/mcp`

Namespaces de endpoints: `AUTH` (signup-init/signin/logout/me/verify-email),
`USERS` (profile/avatar/roles/admin), `PROJECTS`, `TASKS` (subtasks, claim,
comments, dependencies, attachments com finalize/download), `AGENTS`,
`AGENT_MESSAGES` (mark read), `BRIDGE_CONVERSATIONS`, `PROJECT_KNOWLEDGE`,
`PROMPTS` + biblioteca, `MCP_PROJECTS`, `API_KEYS` (rotate/revoke com
`X-Revoke-Reason`), `STRIPE` (checkout, subscriptions, customer portal,
live-subscription), `JOBS`, `TERMINAL_ASSIST` (suggest/predict/suggest-stream).

---

## 4. Protocolo de swarm e handoff (lado cliente)

### 4.1 Spawn de agentes (`swarm-orchestrator-BJGVI262.js`)

- Registro de **10 CLIs** (`MainApp`): `bridgecode` (próprio), `claude`,
  `codex`, `grok` (Grok Build), `kimi` (Kimi Code!), `antigravity` (`agy`,
  Google), `opencode` (default args `--model openrouter/sakana/fugu-ultra`),
  `cursor` (`agent`), `droid` (Factory), `copilot`. Cada um tem
  `promptStrategy` (`inline-arg` com template ou `type-after-launch`),
  `autoApproveFlag` (`--dangerously-skip-permissions`, `-a never`, `--yolo`…),
  `planModeFlag`, `resumeStrategy` (`native-id` com `resumeTemplate`, ex.
  `claude --resume {id}`, `codex resume {id}`, ou `continue`/`none`), acentos
  de cor e `spawnGraceMs`/`inactivityIdleMs`.
- Spawn: `terminal_create` com env enriquecido (`SWARM_AGENT_NAME`,
  `BRIDGESPACE_EXTRA_PATH=<root>/.bridgespace/swarms/<scope>/bin`,
  `BRIDGESPACE_FAST_SHELL=1`, `BRIDGESPACE_SWARM_SCOPE_ID`, env de auto-approve
  tipo `OPENCODE_YOLO=1`).
- **Detecção de prompt robusta**: espera OSC 133;A com timeouts/escalonamento,
  watchdog re-escreve o comando se não há output ("No agent output N ms after
  launch; retrying command write"), verificação de launch por *banner sniff* no
  buffer xterm (`sniffAgentFromBuffer`) + checagem de processo filho
  (`terminal_has_child_processes` batch com coalescing de 40 ms).
- **Ambient agent detection** (`ambient-agent-detector`): varre os primeiros 4
  KB de output de qualquer terminal por banners de CLIs conhecidos (Claude
  Code, Codex, Antigravity, Gemini, opencode, cursor-agent, droid, Copilot,
  aider, grok, mods, fabric, llm) e adota o terminal como agente — detecção
  passiva de "agente que o usuário abriu sozinho".

### 4.2 Mailbox de arquivos (`swarmMailboxInit`, 58 KB)

O renderer **gera e instala scripts Node no workspace do usuário**:
`.bridgespace/swarms/<scope>/bin/` contém `bs-mail.cjs`, `bs-swarm.cjs`,
`bs-notify.cjs` (+ wrappers `.cmd`/`.sh`), colocados no PATH dos agentes via
`BRIDGESPACE_EXTRA_PATH`. Estrutura de diretórios:

```
<root>/.bridgespace/swarms/<scope>/
  bin/            bs-mail, bs-swarm, bs-notify (+ shims win32/posix)
  inbox/<agent>/  mensagens JSON por destinatário
  nudges/         nudges pendentes
  transcript/     cópia imutável de toda mensagem (sobrevive a consume)
  agents.json     registro de agentes (label/role)
  plan/events/    eventos goal/task (goal_created, task_created, task_updated…)
```

- `bs-mail send --to @all|<label> --body …` / `check [--inject|--consume]` /
  `agents`. O **hook do Claude Code** (`UserPromptSubmit` etc., instalado em
  `.claude/settings.local.json` — "agent hooks") roda `bs-mail check --inject`
  a cada prompt, imprimindo `--- BridgeSwarm Inbox ---` no contexto do agente
  (inbox-zero pattern). O mesmo hook captura `session_id` e `transcript_path`
  nativos do Claude — identidade durável para `claude --resume` pós-crash e
  continuação cross-account.
- `swarmMailWatcher` (renderer): polling adaptativo (2,5 s ativo → 30 s idle,
  backoff com jitter) + lê inbox e alimenta o message feed da UI; dedup por
  `dir::arquivo` com TTL de 5 min.
- `swarmPlanWatcher`: consome `plan/events/*.json` via `fs.watch` (fallback
  polling), valida/normaliza eventos (`goal_created/updated`,
  `task_created/updated`, `task_note_added`; status de task: open/assigned/
  planning/building/review/done/blocked/cancelled) e alimenta o painel de
  goals/tasks do SwarmWorkspaceView.
- `swarmScopeMigration`: migra pastas de swarm legadas (sem scope id) para
  quarentena `_legacy`, flag one-shot em localStorage.
- O prompt de spawn injeta o "mission brief" + supporting knowledge +
  instruções de protocolo ("**Send to all agents:** bs-mail send --to @all…")
  como behavioral directives.

### 4.3 Monitoramento de atividade (`swarm-activity-monitor`)

Estados running/idle/done/error por agente: batch `hasRunningProcesses` com
throttle, grace period por CLI (`spawnGraceMs`), idle por inatividade
(`inactivityIdleMs`, ex. 8 s), extração de "última linha significativa" do
output (strip ANSI, ignora `No messages`/`$ `) para o chip do board, pausa
quando a janela está oculta.

### 4.4 Resume de sessão (`swarmSessionResume`)

Antes de respawnar, consulta `history_latest_agent_sessionsForPanes` e só
oferece resume para CLIs com `resumeStrategy:"native-id"` e ID nativo seguro;
valida transcript (existe, não-vazio), cwd e configDir no disco. "Resume
previous sessions — Each agent reopens its saved conversation and continues
with full context" vs "New CLI sessions briefed from the swarm board"
(`buildSwarmResumePrompt` / `buildSwarmResumeCatchUpNudge`).

### 4.5 Handoff (`handoff-engine`, `handoff-context`, `HandoffOverlay`)

"Generate handoff" no menu do terminal:
1. `handoff-context` reconstrói o contexto da sessão a partir dos command
   blocks (OSC 133): comando, output (truncado inteligente: cabeça 2 KB +
   cauda 10 KB, blocos com erro priorizados, orçamento 128 KB), cwd, git
   branch, duração, gaps de idle; platform/node/gitDirty via `system.getInfo`.
2. `handoff-engine` escreve o contexto num arquivo temporário e **dispara um
   CLI agente headless** (`claude --print`, `codex exec --skip-git-repo-check -`,
   `grok -p … --output-format plain`, etc., com quoting por shell:
   posix/powershell/cmd) com um mega-prompt ("You are creating a detailed
   handoff document… PRESERVE tables, scores, findings…"). Detecta o output
   entre marcadores `---HANDOFF_START---`/`---HANDOFF_END---` ou
   `<<<BRIDGESPACE_HANDOFF_START/END>>>`, valida seções obrigatórias (Session
   Summary, What Happened, Detailed Results, Problems, Where Things Left Off,
   Next Steps), timeout 60 s, erros amigáveis (exit 127 = "CLI not found").
3. `HandoffOverlay`: painel deslizante sobre o terminal ("Handoff via <agent>",
   badge "Generating" com spinner, cursor `▌` de streaming, auto-scroll com
   stick-to-bottom, botão Copy com feedback, MarkdownRenderer lazy).

---

## 5. Padrões de UX dignos de nota (para o NexusIDE)

1. **"Resume your agents"** — retomada explícita de agentes vivos no fechamento
   anterior, com resume nativo por CLI (`claude --resume`) validado contra
   disco (transcript/cwd) antes de oferecer.
2. **Ghost text de terminal em duas camadas** — frecency local (escopo cwd >
   projeto > global) com precedência sobre LLM remoto; telemetria completa do
   funil (shown/accepted/dismissed + motivo), denylist por dismiss.
3. **Mailbox de arquivos como bus de agentes** — comunicação inter-agente via
   CLI gerada (`bs-mail`) injetada no PATH, transcript imutável separado do
   inbox consumível, hook de prompt injeta inbox no contexto do agente.
4. **Terminal restore defensivo** — safety switch, pausa após falhas em massa,
   confirmação explícita para SSH, "Restore all anyway" como escape hatch.
5. **Kanban → agente em um clique** — "Run task" transforma card em missão de
   agente com toggle de auto-approve; knowledge da tarefa vira contexto.
6. **Browser-mock mode** — todo o `window.tauriAPI` tem fallback JS; app
   renderiza e é navegável sem backend Tauri.
7. **Handoff como documento gerado por IA** — usa o próprio CLI do agente
   (headless) para destilar a sessão em markdown estruturado, com marcadores
   delimitadores e validação de seções.
8. **Streaming IPC por `Channel` dedicado** (não por evento global) — PTY data
   e exit por canal; attach memoizado com replay de scrollback.
9. **Stale-chunk self-healing** — dynamic import falhou → reload com orçamento;
   esgotou → tela fatal honesta ("half-updated state").
10. **Assistente de voz (`jarvis`) orquestrando canvas de terminais** — "Tell
    Bridge what to run across the canvas", push-to-talk, transcript visível.

---

## Apêndice — mapa de chunks de aplicação

| Chunk | Papel |
|---|---|
| `index-D0sLjlYW.js` (288 KB) | Entry: React DOM, Sentry, bootstrap, fatal screen |
| `AuthenticatedShell-B6g16bmQ.js` (97 KB) | Auth gate, API client, error boundary, endpoints |
| `MainApp-Bsp7gQmz.js` (1,1 MB) | Shell: registro de agentes, workspaces, views, notificações, swarm store |
| `tauriApiCompat-Dma6bZXU.js` (58 KB) | Ponte IPC `window.tauriAPI` (17 namespaces, 156 comandos, Channels) |
| `PaneWorkspace-BN9oxoE0.js` (159 KB) | Grade de panes, wizard de workspace, presets, restore, swarm setup |
| `SimpleTerminal-M-KTTCPg.js` (89 KB) | xterm host, OSC 133, ghost text, backpressure |
| `SimpleTerminalPane-3eQKrQMy.js` (54 KB) | Chrome do pane: menu de ações, custo, handoff trigger |
| `index-C3qSma5A.js` (109 KB) | SwarmWorkspaceView (board, command bar, feed, missão) |
| `KanbanBoard-C40V2t93.js` (49 KB) | Kanban + TaskDetail + RunTask |
| `SettingsPage-Bc3SVYwB.js` (219 KB) | Configurações (11 seções) |
| `index-DAcJ4vIR.js` (113 KB) | BridgeMemoryPage (knowledge graph) |
| `index-D6EeKRiU.js` (43 KB) | BridgeCanvas + voice orchestrator |
| `index-DZWbKrEm.js` (26 KB) | BridgeCodeView (chat dirigindo Codex CLI) |
| `swarmMailboxInit-C-ClIQEJ.js` (59 KB) | Gera bs-mail/bs-swarm/bs-notify + hooks Claude |
| `swarm-orchestrator-BJGVI262.js` (11 KB) | Spawn/verify/retry de agentes swarm |
| `swarm-activity-monitor / swarmMailWatcher / swarmPlanWatcher / swarmScopeMigration / swarmSessionResume` | Monitoramento, mailbox, plan events, migração, resume |
| `handoff-engine / handoff-context / HandoffOverlay` | Handoff de sessão via IA |
| `SshConnectionModal / SshPassphraseModal / HostKeyVerificationModal` | Fluxo SSH |
| `UpdateNotificationModal / UpdateOnLaunchOverlay` | Updater in-app e no boot |
| `ambient-agent-detector` | Detecção passiva de CLIs por banner |
| `workspacePresets / shellIntegration / terminalCopyStore` | Presets, OSC 133 no zshrc, clipboard |
| `SkillsPage / RunTaskModal / TaskAttachmentsTab / DropZoneOverlay / FileDropToast / WelcomeScreen` | Views e utilitários de UI |
