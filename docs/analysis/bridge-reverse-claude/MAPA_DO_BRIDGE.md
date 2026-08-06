# MAPA DO BRIDGE — engenharia reversa (versão Claude)

> Dissecação do app **Bridge** (BridgeSpace / BridgeMind / BridgeMemory / BridgeBoard / BridgeVoice)
> feita a partir dos artefatos legíveis instalados nesta máquina (app Tauri compilado em
> `/Applications/BridgeSpace.app`, MCP server em `~/.bridgespace/`, SQLite `history.db`,
> hooks, logs, App Support) — **não** há source. Tudo abaixo é mecânica/arquitetura
> inferida e citada; código proprietário é parafraseado, nunca reproduzido.
>
> Data: 2026-08-06 · Fontes principais: `server.cjs` (BridgeMemory MCP), `history.db`,
> `bs-claude-hook.cjs`/`bs-agent-notify.cjs`, `Info.plist`, `strings` do binário Tauri,
> `bridgespace-tauri.log`, App Support. Base de conhecimento prévio: docs Bridge do próprio
> NexusIDE (§9).

---

## Sumário

1. [Visão geral executiva](#1-visão-geral-executiva)
2. [Linha de produtos — quem é quem](#2-linha-de-produtos--quem-é-quem)
3. [Arquitetura do app (Tauri, capacidades, IPC)](#3-arquitetura-do-app-tauri-capacidades-ipc)
4. [BridgeMemory MCP — o hub de memória](#4-bridgememory-mcp--o-hub-de-memória)
5. [Hooks & integração com agentes CLI](#5-hooks--integração-com-agentes-cli)
6. [Modelo de dados & runtime (`history.db`, App Support)](#6-modelo-de-dados--runtime-historydb-app-support)
7. [Swarm / missões](#7-swarm--missões)
8. [Modelo conceitual da UI](#8-modelo-conceitual-da-ui)
9. [Padrões portáveis (ideias pra reusar no NexusIDE)](#9-padrões-portáveis-ideias-pra-reusar-no-nexuside)
10. [O que o NexusIDE JÁ portou vs. o que falta](#10-o-que-o-nexuside-já-portou-vs-o-que-falta)
11. [Lacunas restantes](#11-lacunas-restantes)

---

## 1. Visão geral executiva

O **Bridge** é uma suíte desktop **Tauri 2.x** (Rust + webview) da **BridgeMind, Inc.** (`bridgemind.ai`),
macOS-first, que funciona como um **shell gráfico multi-agente**: hospeda terminais reais (PTY),
rodeia CLIs de IA (Claude Code, Codex…), orquestra **swarms** de agentes, mantém um **hub de
memória local** em Markdown (BridgeMemory) e integra um ditado por voz (BridgeVoice).

A peça central é o **BridgeSpace** (`/Applications/BridgeSpace.app`, bundle
`io.bridgemind.bridgespace`, **v3.4.18**). É um Tauri "gordo" (binário 33,8 MB) com backend Rust
que faz PTY próprio (`portable_pty`), SSH (`russh 0.61`), SQLite (`refinery` migrations),
crypto (AES-GCM/ChaCha20) e hospeda dois MCP servers locais. O **BridgeVoice** é um app
satélite (v2.8.2, 131 MB) de STT/dictation que injeta texto em qualquer app via AppleEvents.

**Princípios de design observados:**
- **Local-first**: estado em SQLite + arquivos Markdown; o agente nativo (Claude/Codex) é
  *observado*, não substituído — o transcript segue vivendo no filesystem do agente.
- **MCP como camada de cola**: o BridgeSpace *hospeda* MCP servers e *reescreve* a config MCP
  dos CLIs externos (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) para que enxerguem esses servers.
- **Shell integration não-intrusiva**: captura comandos via OSC 133 + OSC 9;9, preservando o
  `.zshrc` original do usuário (override de `ZDOTDIR`).
- **Token de sessão como âncora de identidade**: `runtime.session` (hex 64 bytes) valida que
  processos filhos (shells, MCP) pertencem ao BridgeSpace vivo.

---

## 2. Linha de produtos — quem é quem

| Produto | O que é | Evidência |
|---|---|---|
| **BridgeMind, Inc.** | Empresa + API cloud (`api.bridgemind.ai`, `app/downloads.bridgemind.ai`, S3, Sentry). "BridgeMind" é a **marca**; os bundles usam `io.bridgemind.*` / `com.bridgemind.*`. | Info.plist + strings |
| **BridgeSpace** | **App host principal** — o "shell gráfico" que une tudo: terminais/PTY, swarm, hub BridgeMemory, proxy MCP, mobile bridge, integrações Claude/Codex. URL scheme `bridgespace://`. Tauri 3.4.18. | Info.plist + binário |
| **BridgeVoice** | **App satélite STT/dictation** (Tauri 2.8.2). Voz→texto injetado em qualquer app via AppleEvents (estilo Superwhisper). Modelos locais Whisper + NVIDIA Parakeet, fallback cloud (Together/Fireworks). LaunchAgent no login. Token compartilhado. | Info.plist + `~/Library/LaunchAgents/BridgeVoice.plist` |
| **BridgeMemory** | **Subsystem de memória persistente** (não é app separado, vive dentro do BridgeSpace). Hub = pasta `.bridgememory/` com Markdowns + `[[wikilinks]]`. Exposto aos agentes via `bridgememory-mcp`. Gating: "requer Pro ou Ultra". | `src/bridgememory.rs` (strings) + `bridgememory-mcp/` |
| **BridgeBoard** | **Tipo de workspace** (kanban) dentro do BridgeSpace — é uma *view* do frontend, não binário próprio. | UI strings + sidebar |
| **Mobile Bridge** | Companion móvel (provável iOS) que controla o BridgeSpace pela LAN via token (`mobile_bridge.rs`, `mobile-bridge-config.json` porta 47421 loopback). | App Support + strings |

> **Nomenclatura:** "BridgeMind" = marca/empresa; "BridgeSpace" = o app instalado. Os docs
> do NexusIDE às vezes trocam os dois — aqui fica claro que **o app é BridgeSpace**.

---

## 3. Arquitetura do app (Tauri, capacidades, IPC)

### 3.1 Stack e capacidades (plugins Tauri)

BridgeSpace roda **Tauri 2.8.3 com ACL de capabilities**. Plugins oficiais presentes
(`plugin:<name>|`): `clipboard-manager`, `dialog`, `http` (reqwest), `notification`, `shell`,
`global-shortcut`, `updater`, `deep-link`, `single-instance` + core `app/event/image/menu/path/
process/resources/tray/webview/window` + **`sentry`** (telemetria — DSN `o447951.ingest.sentry.io`).

Capacidades de backend Rust embutidas (não são plugins Tauri, são runtime próprio):
- **PTY** via `portable_pty` + `openpty` — terminal nativo completo (necessário p/ xterm.js com
  renderer canvas/WebGL, recovery de DPR, controle de backpressure, restore de sessão).
- **SSH** via `russh 0.61` (decisão no binário: "russh over thrussh por causa da CVE-2025-54804").
  Suporta passphrase, ssh-agent, `read_ssh_id`. Desabilitável em release (`BRIDGESPACE_DISABLE_SSH_IN_RELEASE`).
- **SQLite** (`history.db`, modo WAL) + **refinery** para migrations (`refinery_schema_history`).
- **Crypto**: AES-GCM, ChaCha20Poly1305, RSA (ring/rustls); `session_write_encrypted`
  (`auth_credentials.enc` + chave em `auth_storage.key`).

### 3.2 Superfície de comandos IPC (inferida do binário)

> Os nomes vêm de literais string junto a `__TAURI_INTERNALS__.invoke(...)` e da fronteira
> Rust snake_case. Comandos de plugin usam `plugin:<name>|<cmd>`; comandos de domínio são
> snake_case direto.

**Domínio — Terminal/PTY:** `terminal_create`, `terminal_destroy`, `cleanup_terminal_handle`,
`spawn_command`, `resume_command`, `active_terminals`.

**Domínio — Sessões de agente:** `record_agent_session`, `upsert_agent_session`,
`reconcile_agent_session_locations`, `latest_agent_sessions_for_panes`, `check_session`.

**Domínio — BridgeMemory:** `create_memory`, `read_memory`, `update_memory`, `delete_memory`,
`list_memories`, `list_orphans`, `append_to_memory`, `init_hub`, `hub_status`, `shrink_memory`
(`src/bridgememory.rs`).

**Domínio — Swarm:** `spawnSwarmAgent`, `swarmMailboxInit`, `swarmMailWatcher`,
`swarmPlanWatcher`, `swarmScopeMigration`, `swarmSessionResume` (assets JS:
`swarm-orchestrator-*.js`, `swarmMailWatcher-*.js`, etc.).

**Domínio — Auth/identidade:** `get_or_refresh_access_token`, `start_web_login`,
`write_auth_request(_if_needed)`, `read_ssh_id`, `session_write_encrypted`, `login_session`.

**Domínio — Mobile bridge** (`src/mobile_bridge.rs`): servidor TCP local, header
`x-bridgespace-token`, vars `BRIDGESPACE_MOBILE_BRIDGE_HOST`; conectividade checada contra
`8.8.8.8:80`.

**Domínio — Voice bridge:** `bridge_agent_voice{,_start,_stop,_cancel}` (acionam o BridgeVoice
externo via deep link + token).

### 3.3 MCP servers hospedados (a "cola")

- **`bridgememory-mcp`** — MCP server Node (`~/.bridgespace/bridgememory-mcp/server.cjs`, 22 K
  linhas). Só roda dentro do BridgeSpace; valida `runtime.session` + token (§4). Tools:
  `hub_status`, `init_hub`, `list_memories`, `read_memory`, `create_memory`, `update_memory`,
  `delete_memory`, `append_to_memory`, `search_memories`, `find_backlinks`, `list_orphans`,
  `suggest_connections`. Auto-descobre o hub subindo dirs até achar `.bridgememory/`.
- **`bridgespace-mcp-proxy`** — proxy HTTP local que centraliza a config "source of truth" de
  **todos** os MCP servers (`{"mcpServers":{}}`), expõe `/commands/` e methods MCP
  (`tools/list`, `resources/list`, `prompts/list`, `notifications/*_list_changed`). Suporta
  *task mode* (`ExperimentalMcpServerTasks`) e *sampling/context*. Erros canônicos:
  `[bridgememory-mcp-proxy] {server not found, missing target URL, …}`.
- **Shimming nos CLIs externos:** o BridgeSpace **reescreve** a config MCP do Claude Code
  (`CLAUDE_CONFIG_DIR`) e do Codex (`CODEX_HOME`) para que enxerguem `bridgememory` (string
  `serialize Codex MCP proxy config failed:`). Padrão clonável.

### 3.4 Runtime (log + artefatos)

Log principal: `~/Library/Logs/io.bridgemind.bridgespace/bridgespace-tauri.log` (JSON lines).
Domínio ~100% terminal: `renderer-recovery`, `xterm-opened`, `terminal-renderer-policy`,
`Spawned terminal session`, `Prepared terminal environment`, `write-raf-stall`,
`slow-terminal-roundtrip`, `automatic terminal restore outcome`. Renderizador xterm.js política
`auto` (WebGL→canvas fallback, theme dracula), backpressure monitorado (`frontend-channel-backpressure`,
alerta se write > 80 ms). Terminais são **persistidos e restaurados** no relançamento.

Variáveis injetadas no shell filho: `BRIDGESPACE_FAST_SHELL`, `BRIDGESPACE_EXTRA_PATH`,
`BRIDGESPACE_SWARM_SCOPE_ID`, `SWARM_AGENT_NAME` (quando pertence a agente swarm),
`BRIDGESPACE_ACTIVE_HUB_FILE`, `BRIDGESPACE_SHELL_INTEGRATION_DIR` (exporta `ZDOTDIR`).

Updater Tauri: `latest.json` em `downloads.bridgemind.ai` + espelho CloudFront, assinatura
Ed25519/SHA256 (`.sig`). Deep links versionados: `bridgespace(-dev)://`, `bridgevoice(-dev)://`
(dev/prod lado-a-lado em dogfood).

---

## 4. BridgeMemory MCP — o hub de memória

Fonte: `~/.bridgespace/bridgememory-mcp/server.cjs` (código próprio nas linhas 21015–22013;
restante é SDK/deps bundled) + `SKILL.md`.

### 4.1 Transporte e inicialização

Servidor MCP **somente stdio** (sem SSE/HTTP/WS). Boot (`main()` em `server.cjs:21981-22008`):
1. `assertBridgeSpaceRuntime()` — valida que roda dentro do BridgeSpace.
2. `new McpServer({name:"bridgememory-mcp", version:"0.2.0"})`.
3. `registerBridgeMemoryTools(server,...)` registra todas as tools.
4. `new StdioServerTransport()` + `server.connect(transport)`.
5. **`orphanGuard`** (`server.cjs:22001-22007`): `setInterval` 30 s que faz `process.exit(0)`
   se `process.ppid === 1` (pai morreu) — bom cidadão anti-zumbi.

**Sem resources, sem prompts** — só tools. As descrições longas das tools funcionam como
prompt implícito pro modelo (ensinam quando/usar e fallbacks).

### 4.2 Runtime gate (só funciona dentro do BridgeSpace)

- Env `BRIDGESPACE_RUNTIME_TOKEN` deve estar presente.
- Arquivo `~/.bridgespace/runtime.session` (default; override
  `BRIDGESPACE_RUNTIME_SESSION_FILE`) contém o token esperado, escrito pelo BridgeSpace.
- Comparação **`constantTimeEquals`** (XOR bit-a-bit, anti-timing) (`server.cjs:21062-21069`).
- Se falha: servidor sobe, mas toda tool retorna `runtimeUnavailableErr` (`server.cjs:21666-21671`).
  Mensagem orienta abrir terminal fresco no BridgeSpace.

### 4.3 Modelo de hub e formato das memórias

Um hub é qualquer diretório com `.bridgememory/`. Dentro:
- `index.json` — só metadata `{version:1|2, name:<basename>, createdAt:<iso>}`. **Não é índice
  de busca.** Lido só em `loadHub` p/ `name`/`indexVersion` (`server.cjs:21348-21357`).
- `*.md` — uma memória por arquivo. **Markdown puro, SEM frontmatter YAML** (confirmado:
  `extractTitle` em `server.cjs:21295-21303` só procura `^#\s+(.+)$`).
  - Título = H1 do topo (fallback: nome do arquivo sem `.md`).
  - Wikilinks `[[Target]]` / `[[Target|alias]]` = único mecanismo de grafo.
  - `welcome.md` plantado em hubs novos.
- `.bridgememory` pode ser symlink/junction **in-root**, mas symlinks que escapam da raiz são
  rejeitados (`resolveMemoryFolder` `server.cjs:21210-21225`: `realpath` + `isPathInside`).
  Mesmo check por arquivo (`safeMemoryFile` `server.cjs:21234-21245`).

### 4.4 Descoberta do hub

`findHubRoot(start)` (`server.cjs:21274-21283`): sobe no máx. **64 níveis** procurando
`.bridgememory/`. Em `resolveHub` (`server.cjs:21690-21716`), ordem final:
**(1)** walk-up a partir de `cwd` → **(2)** fallback p/ `BRIDGESPACE_ACTIVE_HUB_FILE`
(arquivo com o hub aberto na UI do BridgeSpace, lido por `readActiveHubFile`
`server.cjs:21284-21294`). `init_hub` é o único que recebe `rootPath` absoluto direto.

### 4.5 Persistência e busca (por dentro)

**Sem DB, sem índice persistente, sem cache em disco.** Cada chamada de tool faz **full-scan +
parse do hub inteiro em memória** (`loadHub` `server.cjs:21338-21386`: `readdir` → `readFile` de
cada `*.md` → `extractTitle` → array ordenado por `modified` desc). Custo O(n) I/O por chamada —
OK p/ centenas de notas, gargalo p/ milhares.

Escrita segura:
- `atomicWriteFile` (`server.cjs:21260-21273`): tmp + `rename` no mesmo dir.
- `appendFileNoFollow` (`server.cjs:21246-21259`): `O_WRONLY|O_APPEND|O_NOFOLLOW` (anti-symlink).

**Busca full-text** (`searchMemories` `server.cjs:21549-21600`):
- Tokenização `toLowerCase().split(/[^a-z0-9]+/)`, tokens ≥ 2 chars. Sem stemmer.
- Score: +5 se token no título; +1/ocorrência no corpo (cap 5/token); +3 se título contém a
  query verbatim.
- `mode:"all"` (default, exige todos os tokens) vs `"any"`. Se `all` retorna 0 mas `any` acha,
  devolve hint sugerindo retry com `any`.
- Snippet (`buildSnippet` `server.cjs:21601-21634`): janela ±40/+80 chars por termo, merge de
  janelas sobrepostas, trunca 400 chars com `…`.

### 4.6 Wikilinks / graph ops

- `parseWikilinks` (`server.cjs:21080-21100`): regex global, suporta pipe, retorna offsets
  absolutos `{start,end}` → permite extrair linha de contexto.
- `find_backlinks` (`server.cjs:21519-21541`): itera todas as memórias, casa `target`
  case-insensitive, devolve a **linha inteira** de contexto de cada ocorrência.
- `list_orphans` (`server.cjs:21635-21651`): órfão = sem link de entrada válido **e** sem link
  de saída válido. Só contam links válidos (p/ titles que existem); links quebrados não contam.
- `suggest_connections` (`server.cjs:21177-21193`): top-N por overlap de tokens distintivos
  (≥4 chars, não-stopword — stopwords só EN em `server.cjs:21104-21167`), excluindo a própria
  e as já linkadas.

### 4.7 Padrões portáveis (BridgeMemory)

- Markdown puro + H1=título + slugify p/ filename: humano, diff-friendly, sem schema p/ errar.
- Wikilinks com offsets absolutos: habilita contexto/backlinks/snippets sem reprocessar.
- Atomic write (tmp+rename) + `O_NOFOLLOW` p/ appends: robusto a crash e anti-symlink-attack.
- `realpath` + `isPathInside`: aceita junctions internos, rejeita escapes — portar p/ qualquer
  tool que escreve em "pasta do usuário".
- Runtime gate token + constant-time compare: só processos do host usam o MCP.
- Walk-up + fallback "hub aberto na UI": modelo git-like + UX.
- **Descrições de tool como prompt operacional**: cada tool ensina "quando usar / fallback /
  significado dos campos".
- `notFoundErr` com 3 sugestões (`findMemorySuggestions` `server.cjs:21498-21518`): recupera
  interação sem round-trip extra.
- `hub_status` barato devolvendo contagens (memórias/links/órfãos): "estado" sem listar tudo.
- **Sem índice persistente** = sem invalidação/migração/corrupção. Vale add cache por mtime só
  se escalar.

---

## 5. Hooks & integração com agentes CLI

> A frente B dedicada teve saída neutralizada pelo guarda do harness (o `.json` de hook casou
> com padrão "settings-json"). O material abaixo vem das frentes C e D, que leram os mesmos
> artefatos.

### 5.1 Captura de comandos shell (OSC 133 + OSC 9;9)

Shell integration em `~/Library/Application Support/io.bridgemind.bridgespace/shell-integration/`
gerada pelo app a cada lançamento: wrappers `.zshrc`/`.zprofile`/`.zshenv`/`.bashrc`/`profile.ps1`
+ `integration.{zsh,bash}`. Padrão: **preserva a config original do usuário** (`USER_ZDOTDIR` →
faz source do `.zshrc` real **antes** de `source integration.zsh`) e controla o `ZDOTDIR`
efetivo via env do processo terminal.

O `integration.zsh` emite **OSC 133** (marks de prompt/command/exit) e **OSC 9;9;<PWD>` (report
de cwd). O emulador embutido parseia essas sequências, captura exit code + duração, e grava em
`commands` (`session_id = term_<uuid>`, `git_branch` resolvido no momento).

### 5.2 Hooks do Claude Code / agentes (`bs-claude-hook.cjs`)

`~/.bridgespace/bin/bs-claude-hook.cjs` e `bs-agent-notify.cjs` são **despachados como hooks do
Claude Code**. A cada evento (`session-start`, `user-prompt-submit`, …) eles leem o payload do
stdin, **derivam o workspace root do `cwd`** do payload, e emitem um JSON pequeno em
`~/.bridgespace/claude-hooks/global/` (ou `agent-hooks/global/` p/ agentes genéricos) com nome
`<sessionId>--<ts>-<event>.json` e campos `{sessionId, event, cwd, nativeSessionId,
transcriptPath, agentType, pid, timestamp, title, userPrompt}`.

**Drop-box one-way hook→app sem IPC direto** — tolerante a crashes da UI (a app consome os JSONs
quando volta). `bs-agent-notify.cjs` notifica a app Tauri (canal local — provável HTTP/IPC local
ou consumo do drop-box).

### 5.3 Correlação sessão ↔ workspace ↔ pane

O Bridge **não inventa** o ID do Claude: reusa o `native_session_id` (UUID v4 nativo) para casar
transcripts. `resume_command` (curto, `claude --resume <uuid>`) vs `spawn_command` (completo,
com env/args — até ~11 KB) = separação explícita "criar nova" vs "retomar". `transcript_path`
aponta p/ o transcript nativo (`~/.claude/...`) — a UI do Bridge é **camada de apresentação/
orquestração** sobre transcripts que seguem no filesystem do agente. `pane_id`
(`swarm-pane-<ts>-<rand>`) + `app_instance` (bundle ID) permitem multi-agente por workspace e
multi-app coexistindo.

---

## 6. Modelo de dados & runtime (`history.db`, App Support)

Fonte: `sqlite3 ~/.bridgespace/history.db ".schema"` + amostras redigidas + App Support.

### 6.1 Schema — `commands` (histórico bruto de shell)

`id, command, cwd, cwd_project_root, shell, exit_code, duration_ms, ts_started, ts_ended,
git_branch, session_id, redacted_at`.

Índices (todos `WHERE redacted_at IS NULL`, exceto "open"): `idx_cmd_cwd_prefix (cwd,command)`,
`idx_cmd_root_prefix (cwd_project_root,command)`, `idx_cmd_global_prefix (command)`,
`idx_cmd_session_open (session_id,ts_started) WHERE exit_code IS NULL`, `idx_cmd_ts`. →
**desenhado p/ autocomplete por prefixo em 3 níveis** (cwd → project root → global) e listar
"comandos em aberto".

`redacted_at` = **soft-delete seletivo** (redige conteúdo sensível mantendo o registro de
existência).

### 6.2 Schema — `agent_sessions` (sessões de agente observadas)

`id, session_id, workspace_id, cwd, agent_id, native_session_id, resume_command, spawn_command,
title, last_prompt, status(active/ended), ts_started, ts_updated, ts_ended, config_dir,
transcript_path, pane_id, app_instance`.

Índices: `idx_agent_sessions_{status,workspace,session_active,pane}`. → base da visão "swarm".

### 6.3 Schema — `command_stats` (o "command refinery")

`cwd, command` (PK `WITHOUT ROWID`), `cwd_project_root, total_count, success_count,
distinct_days, last_day, first_used, last_used, last_branch, dismissed_count,
last_dismissed_at, last_decayed_at`.

→ agregado materializado que alimenta **autocomplete ranqueado**: combina frequência + taxa de
sucesso + recência (com **decay**) + sinal negativo explícito (dismiss). Índices por `command`,
`cwd_project_root`, `last_used`.

### 6.4 Schema — `denylist_patterns` + `meta` + migrations

- `denylist_patterns(id, kind, pattern, added_at)` — nesta instância só `kind=cwd_glob`
  (globs de path **nunca** capturados/indexados). Camada preventiva na entrada.
- `meta(key, value)` — maintenance: `last_maintenance_ts`, `last_maintenance_pruned`,
  `missed_capture_count` (job periódico de GC/decay in-app).
- `refinery_schema_history(version, name, applied_on, checksum)` — crate Rust **refinery**.
  Migrations nesta instância: 1 `init`, 2 `agent_sessions`, 4 `command_stats`, 5
  `agent_session_profile`, 6 `agent_session_pane`, 7 `agent_session_app_instance` (as duas
  últimas de 2026-08-06 = adições recentes de swarm + multi-app; versão 3 ausente, sem impacto).

### 6.5 Runtime state

`~/.bridgespace/`: `history.db`+`-wal`(2,6 MB)+`-shm` (WAL), `runtime.session` (hex 64 bytes =
token que `bridgememory-mcp` valida), `bridgememory.active` (marker 1 byte de hub ativo),
`claude-hooks/global/*.json` + `agent-hooks/global/` (drop-box de eventos), `bin/bs-*.cjs`,
`bridgememory-mcp/`, `logs/`, `skills/` (reservado).

`~/Library/Application Support/io.bridgemind.bridgespace/`:
- `session.alive.v1.json` — **heartbeat** do processo Tauri: `{pid, release:"bridgespace@3.4.18",
  os, arch, started_at_ms, last_heartbeat_at_ms, heartbeat_bucket:"alive.heartbeat:30min",
  diagnostics:{file_watcher_count, process_rss_bucket, terminal_count}, expected_exit}`.
  `expected_exit=null` → **crash recovery detectável**.
- `auth_credentials.enc` (5,6 KB) + `auth_storage.key` (43 B, consistente c/ chave
  age/XChaCha20) + `.key.bak` — keystore criptografado (chave separada do payload + backup).
- `device_fingerprint.dat` (64 B), `mobile-bridge-config.json` (`{binding:"loopback",port:47421}`),
  `mobile-bridge-token` (33 B).
- `shell-integration/` (wrappers gerados pelo app a cada lançamento).

### 6.6 Redação dual-layer

1. **Denylist preventiva** (`denylist_patterns`, `cwd_glob`) — filtro na entrada.
2. **Redação retroativa** (`commands.redacted_at`) — apaga conteúdo sem perder o registro;
   índices filtram `WHERE redacted_at IS NULL`.

---

## 7. Swarm / missões

Componentes (assets JS + handlers IPC):
- **Mailbox compartilhada** — `swarmMailboxInit` + `swarmMailWatcher` (mensagens entre agentes).
- **Plano compartilhado** — `swarmPlanWatcher` (observa plano).
- **Lifecycle** — `swarmScopeMigration` (migrar swarm entre sessões), `swarmSessionResume`
  (retomar após restart), `spawnSwarmAgent` (handler de spawn), `swarm-activity-monitor`,
  `swarm-orchestrator`.
- Cada terminal de agente recebe `SWARM_AGENT_NAME` + `BRIDGESPACE_SWARM_SCOPE_ID`.
- O pane virtual (`pane_id = swarm-pane-<ts>-<rand>`) é a unidade: um agente por pane, vários
  panes por workspace. `latest_agent_sessions_for_panes` materializa a visão.

**Mission wizard** (tela "Define the mission", Step 1/3 da screenshot): coleta **Working Folder**
(cwd base), **Mission Brief** (texto com `@` p/ referenciar arquivos — estilo Cursor/Claude),
**Context Files** (lista de arquivos seed). É o wizard que instancia agentes e os aponta a um
objetivo. (Steps 2/3 não observáveis sem abrir o app — lacuna.)

> **Comparativo c/ NexusIDE:** o Nexus já tem orquestração **muito mais rica** e durável
> (squads selados, `mission_events` com cursor/ACK, handoffs com receipt + cadeia de hash,
> skill-gate duplo, scheduler adaptativo). O swarm do Bridge parece mais leve (mailbox +
> plan watcher + pane virtual) — ver §10.

---

## 8. Modelo conceitual da UI

- **Workspace** = unidade de topo. Tipos/presets observados: pasta simples, **swarm**,
  **BridgeBoard (kanban)**, **BridgeMemory (grafo)**. BridgeBoard e BridgeMemory aparecem na
  sidebar como entradas navegáveis **e** como tipos de workspace.
- **Pane** = subdivisão do workspace; cada pane pode ter um terminal. Modelo relacional em
  SQLite (`agent_sessions.workspace_id × pane_id`).
- **Inspector/Picker/Connector no frontend**: camada JS de overlay — `__bridgeInspector*`
  (inspetor de elementos), `__bridgePickerChunks`/`__bridgePreparePickerChunks` (picker de
  arquivos/referências com **chunking via `document.title = '__BRIDGE_PICKER__'+encoded`** —
  técnica p/ passar dados grandes do webview pro Rust via title-set hack), `__bridge_agent_menu`,
  `__bridge_modal`, `__bridge_connector`. Animações próprias (`@keyframes __bridgePulse`,
  `__bridgeModalIn`). → **isto é o "luxo visual" que você admirou**: overlay custom com
  microinterações, não shadcn padrão.

---

## 9. Padrões portáveis (ideias pra reusar no NexusIDE)

Consolidado e dedupeado de todas as frentes:

1. **MCP shimming** — hospedar MCP servers locais **e** reescrever a config MCP dos CLIs
   externos (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) p/ enxergá-los. Padroniza "source of truth".
2. **MCP proxy central** (`bridgespace-mcp-proxy`) com matriz servidor×ferramenta, drift,
   `.bak`, secrets mascarados, task mode + sampling/context.
3. **`bridgememory-mcp` model**: hub Markdown + wikilinks + walk-up discovery + UI fallback +
   runtime gate (token constant-time) + atomic write + `O_NOFOLLOW` + `realpath`/`isPathInside`.
4. **Captura shell via OSC 133 + OSC 9;9** com shell integration por override de `ZDOTDIR`
   **preservando** a config original do usuário.
5. **Command refinery**: `command_stats` `WITHOUT ROWID` com decay + dismiss + success rate →
   autocomplete ranqueado.
6. **Redação dual-layer**: denylist preventiva (`cwd_glob`) + `redacted_at` retroativo (índices
   `WHERE redacted_at IS NULL`).
7. **Drop-box de eventos JSON por arquivo** (hook→app) — one-way, tolerante a crash, sem IPC direto.
8. **Session alive por heartbeat JSON** (`session.alive.v1.json`, bucket 30 min, `expected_exit`
   p/ crash recovery).
9. **Crypto store split**: `.enc` + `.key` + `.key.bak`, paths sob App Support.
10. **PTY próprio** (`portable_pty`+`openpty`) em vez do shell plugin Tauri — necessário p/
    xterm.js com renderer/recovery/backpressure/restore.
11. **Companion desacoplado** (BridgeVoice via deep link + token + LaunchAgent): ditação funciona
    sobre **qualquer** app, não só o host.
12. **Mobile bridge loopback + token** (TCP local, `x-bridgespace-token`).
13. **Updater Tauri + CloudFront** com `latest.json` + assinatura Ed25519/SHA256.
14. **Telemetria única via Sentry** (incluindo breadcrumb IPC).
15. **Title-set hack** p/ passar dados grandes webview→Rust (picker chunks).
16. **Descrições de MCP tool como prompt operacional** + `notFoundErr` com sugestões.

---

## 10. O que o NexusIDE JÁ portou vs. o que falta

Fonte: `docs/bridgemind-integration.md`, `docs/analysis/2026-07-13-warp-bridgemind-phase0-diagnosis.md`,
`docs/analysis/2026-07-13-wave1-checkpoint.md`, `docs/prompts/grok-apply-warp-bridgemind-learnings.md`,
`src/main/orch/bridge-mind-skills.ts`.

### Já portado (clean-room, feature-flagged default off, MIT — waves 0–2)

- Feature-flag registry tipado (canal dev/dogfood/preview/stable, kill switch, fail-closed).
- `CommandBlock` + redaction + OSC 133 scanner + tracker + SQLite store.
- Mission event journal append-only (dedupe, replay, cursor, ACK, projeção p/ UI).
- SearchMixer core (debounce, generation counter, cancel, stable ranking).
- Migração SQLite **014** (`mission_events`, `mission_event_cursors`, `command_blocks`) c/ trigger
  de imutabilidade.
- Shell integration OSC 133 p/ zsh/bash/fish (`resources/shell-integration/nexus-osc133.*`).
- MCP tools read-only `nexus_content_audit` / `nexus_security_audit` (estilo BridgeWard/BridgeSecurity)
  em `src/main/orch/tools-security.ts`.
- Skills `bridgeward` + `bridgesecurity` espelhadas (`skill-mirror.ts`).
- Benchmark runner A/B + journal append-only (estilo BridgeBench) em `src/main/eval/`.
- Skills catalog (inspirado em BridgeSkills) c/ lockfile (`skills-catalog.ts`).
- Onboarding progressivo "Bridge-inspired" (`progressive-onboarding.ts`).

### Onde o NexusIDE JÁ é mais forte que o Bridge (preservar)

PTY em `utilityProcess` + env allowlist + ownership de sessão + output ACK; scheduler com
prioridade foreground + backpressure + chunking ANSI-safe; effect policy de MCP; validação zod em
boundaries; reservas/budgets duráveis de missão; multi-CLI/contas/handoffs/local-first;
workspace path-scope anti-traversal; **orquestração muito mais rica** (squads selados, handoffs
com receipt + cadeia de hash, skill-gate duplo, scheduler adaptativo).

### Faltam portar (gaps vs Bridge — waves 3+, marcadas BLOQUEADO)

- **BridgeMemory hub de verdade** (`.nexus-memory/` MD + wikilinks + walk-up + MCP runtime gate)
  — hoje o Nexus tem `memory_entries` + Jarvis facts, sem hub Markdown navegável.
- **MCP Hub multi-source + proxy** com drift, matriz servidor×ferramenta, `.bak`, OAuth hub,
  shimming em `CLAUDE_CONFIG_DIR`/`CODEX_HOME`.
- **Command refinery UI** (autocomplete ranqueado com decay/dismiss — o store já existe, falta UX).
- **Onboarding wizard de layout/agentes** (seleção visual 1/2/4/6/8/10/12 terminais, "split evenly").
- **Launcher multi-produto** (BridgeSpace/Swarm/Board/Memory/Skills como entradas).
- **Painel contextual** (tabs Browser/Editor/Git/Skills).
- **Editor real** (CodeMirror + MD read mode + "Edit source").
- **Skills catalog UX** (descrição, categoria, fases, Copy, drag-and-drop p/ o terminal).
- **Perfis de autonomia**, **worktree isolation**, **isolamento por conta** (não confirmado no
  Bridge — lacuna).
- **Mobile/companion bridge** (loopback + token).
- **BridgeVoice-equivalente** (STT desacoplado via deep link + token + AppleEvents).

---

## 11. Lacunas restantes

- **Swarm do Bridge não dissecado a fundo**: como agentes são spawnados/comunicam/dividem
  trabalho/sincronizam (mailbox + plan watcher inferidos, sem detalhe do protocolo de mensagens).
- **Mission wizard steps 2/3** não observáveis sem abrir o app.
- **Endpoints `api.bridgemind.ai`** (auth, billing, swarm config, sync) não visíveis como strings
  limpas — só por instrumentação de rede (mitmproxy no webview).
- **`spawn_command` de ~11 KB** não inspecionado (pode incluir env/system prompt embutido).
- **Capabilities ACL Tauri** (`capabilities/*.toml`) não legíveis no bundle compilado — scoping
  exato de paths/commands é opaco.
- **MCP Hub drift/`.bak`/matriz servidor×ferramenta**: mecânica exata não confirmada no proxy.
- **Perfis de autonomia / worktree isolation / isolamento por conta** no Bridge — não confirmado.
- **`denylist_patterns.added_at`**: unidade ambígua (provável segundos, não ms).
- **`workspace_id`**: como é derivado exatamente (hash de qual input?).
- **Stopwords só EN** em `suggest_connections` (PT-BR sofre: "que/para/com/não" não são stop).
- **Slugify ASCII-only**: "Autenticação" vira `autenticao.md`.
- **Busca sem stemmer/fuzzy/transliteração**: "auth" ≠ "authentication".
- **`list_orphans` desconsidera links quebrados** (sem tool p/ "dangling references").
- **Sem renomear/mover** memória preservando backlinks (hoje é delete+create+relink manual).
- **Sem watch/cache incremental** no BridgeMemory MCP (full-scan por chamada).
- **"BridgeVoice 2.app"** no LaunchAgent sugere instalação paralela — não investigado.

---

## Fontes-chave (caminhos absolutos)

| Artefato | Papel |
|---|---|
| `/Applications/BridgeSpace.app/Contents/Info.plist` | Identidade, versão, schemes, ATS |
| `/Applications/BridgeSpace.app/Contents/MacOS/bridgespace-tauri` | Binário — IPC, capacidades, plugins (via `strings`) |
| `/Applications/BridgeVoice.app` | App satélite STT |
| `~/.bridgespace/bridgememory-mcp/server.cjs` | MCP BridgeMemory (22 K linhas) |
| `~/.bridgespace/bridgememory-mcp/SKILL.md` | Orientação de uso do MCP |
| `~/.bridgespace/bin/bs-claude-hook.cjs` | Hook dispatcher do Claude Code |
| `~/.bridgespace/bin/bs-agent-notify.cjs` | Notificador de agentes genéricos |
| `~/.bridgespace/claude-hooks/global/*.json` | Drop-box de eventos de hook |
| `~/.bridgespace/history.db` | SQLite — commands/agent_sessions/command_stats/denylist |
| `~/.bridgespace/runtime.session` | Token de sessão (validado pelo MCP) |
| `~/Library/Application Support/io.bridgemind.bridgespace/` | Config, crypto, heartbeat, shell-integration |
| `~/Library/Logs/io.bridgemind.bridgespace/bridgespace-tauri.log` | Runtime behavior |
| `docs/bridgemind-integration.md` (NexusIDE) | Contrato da integração clean-room |
| `docs/analysis/2026-07-13-warp-bridgemind-phase0-diagnosis.md` | Diagnóstico baseline + gaps |
| `docs/analysis/2026-07-13-wave1-checkpoint.md` | O que foi implementado (waves 0–2) |
| `docs/prompts/grok-apply-warp-bridgemind-learnings.md` | Mapa de padrões observados + roadmap |
