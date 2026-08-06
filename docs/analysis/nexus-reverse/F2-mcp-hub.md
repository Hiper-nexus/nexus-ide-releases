# F2 — MCP Hub (namespace `nexus_*`)

> Engenharia reversa read-only. **Âncora deste documento: working tree em
> 2026-08-06 16:45, HEAD `57214879`.**
>
> **Ressalva de alvo móvel:** outra sessão commitou em `main` durante esta
> auditoria. três commits entraram durante a auditoria
> (`bc2c7416` → `cb5a3169` → `57214879`), deslocando `mcp-server.ts`,
> `tools-domain.ts` (~+50 linhas) e `tools-instruments.ts`. A tabela das 142 tools
> (§2.4) foi **regerada por script** contra a âncora acima, e as citações de prosa
> em `src/main/orch/*` foram conferidas uma a uma depois dela. **O conjunto de
> tools permaneceu 142 em todos os snapshots** — só os números de linha mudaram. Citações em
> `src/main/mcp-hub/` e `src/shared/` não foram afetadas (arquivos intocados).

## 0. Resumo (10 linhas)

1. O nome "MCP Hub" cobre **dois subsistemas distintos** que o brief da missão trata como um só. Separá-los é o pré-requisito para entender qualquer coisa aqui.
2. **(A) Hub de configuração** — `src/main/mcp-hub/`: observa e sincroniza *configs* de MCP servers entre Nexus, Cursor, Claude Code, Codex, OpenCode e Cline. Não executa tool nenhuma.
3. **(B) Servidor MCP embutido** — `src/main/orch/mcp-server.ts`: um HTTP server em `127.0.0.1:<porta aleatória>` que expõe as **142 tools `nexus_*`** para as CLIs de agente rodando dentro dos panes.
4. Os dois se tocam em exatamente um ponto: a tool `nexus_mcp_servers` lê o config do hub (`tools-instruments.ts:503`).
5. O hub **não é registrado no boot**: `src/main/main.ts` não o importa. Ele é acionado por quem usa — três consumidores, listados em §2.2.
6. Já o servidor embutido sobe via `initOrchestration()` no bootstrap (`main.ts:641`), e sua porta é aleatória e loopback-only.
7. Autenticação é **por agente**: cada spawn cunha um bearer token próprio (`mcp-server.ts:681`), amarrado a role, missão, allowlists de tool e de skill.
8. A propagação para a CLI **não é uniforme** — cada família recebe o servidor por um mecanismo diferente (flags, `-c`, overlay de HOME), e **AGY fica de fora por decisão explícita** (`cli-mcp-inject.ts:62`).
9. As tools são declarativas (`McpToolDef`, `mcp-protocol.ts:39-52`) e agregadas por `buildToolset()` (`tools.ts:38-62`) — mas três famílias entram por dentro de outros builders, não por essa lista.
10. 9 das 142 tools carregam `requiresConfirm: true` — confirmação nativa obrigatória, independente do guardrail genérico.

---

## 1. Trace ponta-a-ponta

### 1.A — Trace do subsistema (A): um MCP de terceiro entra no hub e é propagado entre tools

Cenário: o operador tem o `firecrawl` configurado no Cursor e quer que Claude Code e Codex também o tenham.

| # | Passo | Fonte |
|---|---|---|
| A1 | UI (Settings → MCPs) pede a matriz. IPC `product:mcpHub.observe`, **sem** gate de feature flag | `docs/MCP-HUB.md:14`; registro em `product-wave-ipc.ts:45` (`observeAcrossTools`) |
| A2 | `observeAcrossTools()` sonda os configs de cada tool no disco | `mcp-hub/mcp-hub-observers.ts` (importado em `product-wave-ipc.ts:45`) |
| A3 | Alvos sondados: hub do Nexus, `~/.cursor/mcp.json`, `~/.claude.json` (+ Claude Desktop), `~/.codex/config.toml`, `~/.config/opencode/opencode.json`, Cline (`cline_mcp_settings.json` sob VS Code / Cursor / Insiders / `~/.cline`, **primeiro que existir**) | `docs/MCP-HUB.md:28-30` |
| A4 | Ids são normalizados para comparar (`TestSprite` ≈ `testsprite`) | `shared/mcp-across-tools.ts:56-62` |
| A5 | Cada célula vira `present` \| `absent` \| `unknown` — **nunca inventada** | `shared/mcp-across-tools.ts:17`; `docs/MCP-HUB.md:15` |
| A6 | Drift = servidor presente em alguma tool **e** ausente em outra que respondeu OK | `shared/mcp-across-tools.ts:64-73` |
| A7 | Banner textual é derivado do drift | `shared/mcp-across-tools.ts:75-96` |
| A8 | Operador clica **Simular**: IPC `product:mcpHub.syncPlan` → `planMcpSync` | `product-wave-ipc.ts:46`; `docs/MCP-HUB.md:20` |
| A9 | Plano com `dryRun: true` **não escreve nada** | `docs/MCP-HUB.md:21` |
| A10 | Operador confirma: `product:mcpHub.syncApply` → `applyMcpSync`, agora atrás da flag `feature.mcp.hub` | `product-wave-ipc.ts:46`; `docs/MCP-HUB.md:17`, `:41` |
| A11 | Input aceito: `{ dryRun?, mode?: 'both'\|'import'\|'export', exportTools? }` — `exportTools` é **opt-in** e limita quais tools recebem fill-gaps | `shared/mcp-hub-sync-api.ts:18-23` |
| A12 | Tools exportáveis são um enum fechado de 5: `cursor`, `claude-code`, `codex`, `opencode`, `cline` | `shared/mcp-hub-sync-api.ts:6-12` |
| A13 | **Import**: servidores observados nas outras tools entram em `.nexus/mcp-hub.json` | `docs/MCP-HUB.md:23`; arquivo real com `schemaVersion: 1` + `servers[]`, cada um com `source` da tool de origem |
| A14 | **Export (fill-gaps)**: o hub escreve o que falta em cada tool. **Nunca deleta**; grava `.bak` timestamped antes de cada escrita; UI confirma via `askConfirm` | `docs/MCP-HUB.md:25` |
| A15 | Cline é fail-closed: sem settings existente, o plano marca `cline: config missing` e **não cria** o arquivo (evita escrever no host errado) | `docs/MCP-HUB.md:32-34` |
| A16 | Flag desligada ⇒ escritas **lançam**. O relatório de drift permanece não-destrutivo | `docs/MCP-HUB.md:45` |
| A17 | Rollback: `rollbackFromBackup` a partir do `.bak` | `docs/MCP-HUB.md:53` |

**Limites declarados:** ≤ 64 servers, ≤ 512 tools/server (`docs/MCP-HUB.md:49`).
**lacuna:** não abri `mcp-hub-core.ts` (234 L), `mcp-hub-observers.ts` (422 L) nem `mcp-hub-sync.ts` (525 L) linha a linha; os passos A2–A17 vêm de `docs/MCP-HUB.md` + call sites confirmados em `product-wave-ipc.ts:44-46`. Os números 64/512, o `.bak`, o `rollbackFromBackup` e o fail-closed do Cline **não foram verificados no código**.

### 1.B — Trace do subsistema (B): uma tool `nexus_*` chega a um pane de worker

Este é o caminho que o brief chama de "propagação entre panes".

| # | Passo | Fonte |
|---|---|---|
| B1 | `bootstrap()` chama `initOrchestration()` (async, não aguardado — a janela já está aberta) | `main.ts:641-646` |
| B2 | `startMcpServer()` monta o registry: `tools: buildToolset()`, `serverName: 'nexus-ide'`, `serverVersion: app.getVersion()` | `mcp-server.ts:1136-1140` |
| B3 | Antes disso, purga artefatos MCP obsoletos de execuções anteriores (AGY + sessões de CLI) | `mcp-server.ts:1122-1133` |
| B4 | Instala o spawn hook, o mission control por stream de PTY, o parser legado e a revogação por término de sessão | `mcp-server.ts:1141-1146` |
| B5 | Cria o HTTP server. **Primeira coisa em toda request**: `bearerContext(req)`; sem token conhecido ⇒ `401` | `mcp-server.ts:1147-1153` |
| B6 | Rotas: `/mcp` (JSON-RPC das tools), `POST /gate/<evento>`, `POST /hook/status`; resto ⇒ `404` | `mcp-server.ts:1155-1170` |
| B7 | `listenOnLoopback` — a porta **nunca sai de 127.0.0.1** e é aleatória | `mcp-server.ts:1183`; URL montada em `mcp-server.ts:188` (`http://127.0.0.1:${port}/mcp`) |
| B8 | Um agente vai nascer: `prepareAgentSpawnDecoration` é o hook de spawn | `mcp-server.ts:634-639` |
| B9 | `mintToken({...})` cunha o bearer **daquele agente**, carregando `role`, `missionId`, `workerIncarnationId`, `contextRevision`, `agentName`, `providerId`, `readOnly` e autoridades especiais | `mcp-server.ts:681-700+`; def. em `gate.ts:224` |
| B10 | **Aqui a propagação se ramifica por família de CLI** (§1.B.1 abaixo) | `mcp-server.ts:780-887` |
| B11 | Skills são materializadas conforme a allowlist do token — `ensureSkillsForCli` com `allowedSkills` | `mcp-server.ts:838`, `:900` |
| B12 | Falha em qualquer preparo ⇒ libera o token e limpa **todos** os artefatos (`releaseSessionByToken`, `cleanupAgyMcpConfig`, `cleanupCliMcpSession`, `cleanupSessionArtifacts`) | `mcp-server.ts:909-917` |
| B13 | Retorna a `AgentSpawnDecoration` com `authorityToken`, `env` e `extraArgs` | `mcp-server.ts:919` |
| B14 | A CLI sobe no PTY e chama `tools/list` → `tools/call` por JSON-RPC 2.0 | `mcp-protocol.ts` (`initialize`, `ping`, `tools/list`, `tools/call` — ver `fase4-mcp-map.md:28`) |
| B15 | Nome da tool é resolvido canonicamente — aliases de nome nu resolvem para a definição canônica | `mcp-protocol.ts:112-121` (`resolveTool` + `canonicalToolName`) |
| B16 | O efeito real passa pelo dispatcher central, que aplica política de efeito | `mcp-dispatch.ts:495` (`dispatchToolCall`) |
| B17 | Resultado serializa como `{content:[{type:'text',text:JSON.stringify(result)}]}`; erros viram `isError: true`, **não** erro de protocolo | `mcp-protocol.ts:135-137`; `fase4-mcp-map.md:28` |

#### 1.B.1 — Como cada família de CLI recebe o servidor (o passo B10 em detalhe)

| Família | Mecanismo | Fonte |
|---|---|---|
| **Claude, HOME efêmero** (política `hardened`) | `--mcp-config <home.mcpConfigPath> --strict-mcp-config`. O `--strict` existe para o CLI **não** baixar os conectores MCP da conta OAuth (Drive, Vercel, HF…), que atrasavam o boot e afogavam o orquestrador com tools inchamáveis | `mcp-server.ts:788-792` (justificativa em `:775-787`) |
| **Claude de terceiro** (GLM / LongCat) | HOME privado persistente + `--mcp-config <writeMcpConfigFile(token, cfg)> --settings <writeClaudeFamilyZeroClickSettings(token)>`. Motivo: compartilhar o `~/.claude` nativo deixava o binário reescrever a sessão OAuth da assinatura — o Claude nativo era deslogado | `mcp-server.ts:793-807` |
| **Claude, HOME real** (`mcpAutoload`) | `--mcp-config` + `--settings`; **e** `--strict-mcp-config` **só se `gated`** — pane de missão não herda os conectores MCP soltos do operador | `mcp-server.ts:808-826` |
| **Codex** | Argv puro, zero escrita em disco: `-c mcp_servers.<nome>.url=…`, `-c …bearer_token_env_var="NEXUS_MCP_TOKEN"`, `-c …tool_timeout_sec=45` | `cli-mcp-inject.ts:99-104` (via `codexMcpArgs`, chamado em `mcp-server.ts:846`) |
| | O segredo **nunca entra no argv** — o Codex lê `NEXUS_MCP_TOKEN` do ambiente | `cli-mcp-inject.ts:74-78` |
| | Timeout de 45 s é fail-closed deliberado: um `tools/call` pendurado (ex.: `Promise.all` concorrente do `exec`) mataria o orquestrador e travaria entrega de handoff | `cli-mcp-inject.ts:81`, comentário em `:76-80` |
| | `+ codexStatusHookArgs()` e `codexHookTrustBypassArgs(bin)` — o bypass é version-gated (≥ 0.134) porque flag desconhecida em Codex antigo quebraria o spawn | `mcp-server.ts:859-866` |
| **OpenCode** | `prepareOpenCodeMcpSession(url, token)` → mescla `env` + `extraArgs` | `mcp-server.ts:867-870` |
| **Kimi** | `prepareKimiMcpSession(url, token, {providerHome: KIMI_CODE_HOME})` → `env` + `extraArgs` + `providerStateHome` | `mcp-server.ts:871-876` |
| **Grok** | `prepareGrokMcpSession(url, token, {providerHome: GROK_HOME, cwd, workspaceRoot})` | `mcp-server.ts:877-884` |
| **AGY / Gemini** | **Não recebe.** `canUseNexusMcp()` retorna `false` de saída. Motivo declarado: AGY 1.1 resolve config MCP do perfil nativo real e **ignora** a projeção privada de `HOME`/`GEMINI_CLI_HOME` — anunciá-lo como capaz de MCP faz o worker esperar para sempre. Rota física de conclusão dele é o stream do PTY | `cli-mcp-inject.ts:58-64` |

---

## 2. Inventário

### 2.1 Papéis dos arquivos que o brief nomeia

| Arquivo | Linhas | Papel real |
|---|---|---|
| `.nexus/mcp-hub.json` | — | **Dado, não código.** Config do subsistema (A): `schemaVersion: 1` + `servers[]`. Cada entry tem `id`, `name`, `transport` (`stdio` \| `streamable-http`), `command`/`args`/`env` ou `url`, `tools[]` e `source` (qual tool originou). No estado atual: 15 servers importados de `cursor`, `claude-code` e `codex` |
| `src/main/mcp-hub/mcp-hub-core.ts` | 234 | Núcleo do hub: schema (`mcpHubConfigSchema`) + leitura/escrita do config | 
| `src/main/mcp-hub/mcp-hub-observers.ts` | 422 | Sondas read-only das configs das outras tools → matriz Across Tools |
| `src/main/mcp-hub/mcp-hub-sync.ts` | 525 | `planMcpSync` / `applyMcpSync` — o lado que escreve |
| `src/shared/mcp-types.ts` | 28 | Contrato **do subsistema (B)**, não do hub: `McpInvokeRequest`, `McpInvokeResult`, `McpConfirmRequest`, `McpConfirmResult` |
| `src/shared/mcp-hub-sync-api.ts` | 28 | Contrato de IPC do sync: enum das 5 tools exportáveis + `McpHubSyncApplyInput` |
| `src/shared/mcp-across-tools.ts` | 96 | Tipos + lógica pura da matriz: ids, `McpCellState`, `normalizeMcpServerKey`, `countAcrossDrift`, `acrossToolsBanner` |

### 2.2 Onde o hub (A) entra no app — **não pelo boot**

`src/main/main.ts` **não importa** `mcp-hub/` (verificado: grep sem resultado). Os três consumidores reais:

| Consumidor | Call site | O que usa |
|---|---|---|
| `src/main/product-wave-ipc.ts` | `:44` (core), `:45` (`observeAcrossTools`), `:46` (`applyMcpSync`, `planMcpSync`) | O caminho de IPC completo — observe/plan/apply |
| `src/main/discovery/workspace-discovery-service.ts` | `:34` (importa de `../mcp-hub/mcp-hub-core`) | Descoberta de configs de ecossistema no workspace |
| `src/main/orch/tools-instruments.ts` | `:502` — `await import('../mcp-hub/mcp-hub-core')`, **import dinâmico** | A tool `nexus_mcp_servers` lê o schema do hub |

O tipo também vaza para o renderer por dois re-exports: `shared/types.ts:225` e `shared/product-api.ts:5`.

### 2.3 Como uma tool é declarada e agregada

`McpToolDef` (`mcp-protocol.ts:39-52`):

| Campo | Obrigatório | Papel |
|---|---|---|
| `name` | sim | Nome canônico no namespace `nexus_*` (`mcp-protocol.ts:40`) |
| `description` | sim | Texto em inglês entregue ao modelo |
| `inputSchema` | sim | JSON Schema puro |
| `requiresConfirm` | não | **Força** confirmação nativa mesmo se o guardrail genérico mudar (`mcp-protocol.ts:45-46`) |
| `handler` | sim | `(args, ctx: AgentGateContext, invocation?: McpToolInvocation) => Promise<unknown>` |

`McpToolInvocation` (`mcp-protocol.ts:54-65+`) carrega o que torna o efeito seguro:
- `signal` — abortado quando uma intenção de missão mais nova pré-empta trabalho de bootstrap
- `assertCurrentAuthority()` — **revalida o caller num ponto de linearização assíncrono**; handlers com efeito devem chamá-la depois do preparo await e imediatamente antes de iniciar processo, request de rede ou escrita durável

`buildToolset()` (`tools.ts:38-62`) concatena **21 builders**. Mas três famílias entram **aninhadas**, não por essa lista:

| Família | Onde realmente entra | Fonte |
|---|---|---|
| Browser / preview (14 tools) | dentro de `buildDomainTools()` | `tools-domain.ts:46` (import), `:1607` (spread) |
| Handoff (4 tools) | dentro de `buildDomainTools()` | `tools-domain.ts:59` (import), `:1587` (spread) |
| Design system keyless (2 tools) | dentro de `buildDesignSystemTools()` | `tools-design-system.ts:34` (import), `:602` (spread) |

### 2.4 Tabela de todas as 142 tools `nexus_*`

**Legenda:** `**param**` = obrigatório (`required[]` do inputSchema); demais = opcionais. ⚠️ = `requiresConfirm: true`.

| Tool | Params | Efeito (description do próprio código) | Call site |
|---|---|---|---|
| `nexus_agent_get` | **agent** | Get one squad agent by id or agentName. | `tools-domain.ts:138` |
| `nexus_agent_invoke` | **agent**, **prompt**, taskId, cwd, timeoutMs | Run a squad agent on a prompt: spawns its CLI in a new pane, types the prompt, waits for the respons | `tools-domain.ts:153` |
| `nexus_agent_list` | limit | List agents defined across saved squads. | `tools-domain.ts:82` |
| `nexus_agent_spec_write` | **name**, tools, skills, model, effort, category, systemPrompt | Create or update a Claude agent spec frontmatter file in ~/.claude/agents. | `tools-domain.ts:720` |
| `nexus_audio_generate` ⚠️ | **text**, provider, model, voiceId, outPath | Generate speech audio (TTS) from text via ElevenLabs and save the mp3 inside the open workspace. | `tools-media.ts:216` |
| `nexus_bg_kill` | **taskId** | Terminate a background task started with nexus_bg_run. | `tools-bg.ts:417` |
| `nexus_bg_list` | — | List background tasks for this project checkout. | `tools-bg.ts:458` |
| `nexus_bg_run` | **command**, cwd | Start a shell command in the background (dev servers, long tests, builds). | `tools-bg.ts:149` |
| `nexus_bg_wait` | **taskId**, timeoutMs | Get status/output of a background task from nexus_bg_run. | `tools-bg.ts:348` |
| `nexus_browser_click` ⚠️ | **paneId**, **ref** | Click a visible opaque ref from browser_read. | `tools-browser.ts:304` |
| `nexus_browser_fill` ⚠️ | **paneId**, **ref**, **text** | Fill or clear a visible text field by opaque ref. | `tools-browser.ts:322` |
| `nexus_browser_hover` | **paneId**, **ref** | Hover a visible element by opaque ref (dispatches the pointer + mouse over/enter sequence and focuse | `tools-browser.ts:460` |
| `nexus_browser_inspect` | **paneId**, **ref** | Inspect one opaque element ref without reading its value or browser storage. | `tools-browser.ts:278` |
| `nexus_browser_navigate` ⚠️ | **paneId**, **url** | Navigate an owned browser pane to a confirmed URL. | `tools-browser.ts:188` |
| `nexus_browser_open` ⚠️ | **url**, title | Open an embedded browser pane at a confirmed URL. | `tools-browser.ts:100` |
| `nexus_browser_press` | **paneId**, **key**, ref, items | Press a keyboard key on the focused element, or on a when given (the element is focused first). | `tools-browser.ts:429` |
| `nexus_browser_read` | **paneId**, maxChars, maxElements | Read bounded visible page text and accessible interactive elements. | `tools-browser.ts:245` |
| `nexus_browser_screenshot` | **paneId** | Capture an owned browser pane as a PNG with redacted URL metadata. | `tools-browser.ts:211` |
| `nexus_browser_scroll` | **paneId**, ref, dx, dy, x, y, behavior | Scroll a browser pane. | `tools-browser.ts:396` |
| `nexus_browser_wait` | **paneId**, **condition**, value, ref, timeoutMs | Wait up to 15 seconds for load, visible text, or a previously read ref. | `tools-browser.ts:350` |
| `nexus_catalog_install` | **kind**, **slug** | Install an agent or skill from the aitmpl catalog (davila7/claude-code-templates) into ~/.claude. | `tools-domain.ts:636` |
| `nexus_catalog_overlay` | stacks, disabled, tombstones, categories | Persist workspace catalog overlay fields: stacks, disabled refs, tombstones and category overrides. | `tools-domain.ts:679` |
| `nexus_clarify` | **question**, **options**, items | Ask the user ONE clarifying question with 2-6 suggestion chips instead of a vague free-text prompt. | `tools-domain.ts:1047` |
| `nexus_cli_inventory` | — | List the AI CLIs known to this machine and, crucially, whether each one can actually run: installed, | `tools-instruments.ts:701` |
| `nexus_code_map_blast_radius` | goal, seedFiles, seedSymbols, depth | Structural blast radius for a goal or seed files/symbols (import neighborhood + hubs). | `tools-code-map.ts:33` |
| `nexus_code_map_get` | — | Read the structural Project Orientation Map for this checkout (inventory, hubs, import graph, docs p | `tools-code-map.ts:15` |
| `nexus_code_map_query` | **q**, limit | Search the Project Orientation Map. | `tools-code-map.ts:75` |
| `nexus_code_map_refresh` | — | Force a rebuild of the structural Project Orientation Map for this checkout. | `tools-code-map.ts:60` |
| `nexus_content_audit` | path, content, source, provenance | Read-only BridgeWard-style audit for prompt injection and repo-poisoning signals. | `tools-security.ts:64` |
| `nexus_context_commit` | — | Commit the exact complete set of independently reviewed context files and attestations. | `tools-context.ts:865` |
| `nexus_context_doctor` | — | Fail-closed project readiness + autonomous bootstrap pilot. | `tools-context.ts:501` |
| `nexus_context_draft_apply` | **draftId** | Atomically materialize an independently approved context proposal and its portable attestation. | `tools-context.ts:750` |
| `nexus_context_draft_get` | **draftId** | Read one source-bound context proposal and its trusted lifecycle state. | `tools-context.ts:665` |
| `nexus_context_draft_list` | — | List durable context drafts and their IDs/status so an interrupted Doctor run can resume determinist | `tools-context.ts:682` |
| `nexus_context_draft_propose` | **type**, **locator**, missionId, targetPath, content | Propose a source-bound business/technical context document or structured fact. | `tools-context.ts:611` |
| `nexus_context_draft_review` | **draftId**, **decision**, **rationale** | Approve or reject a context proposal as an independent reviewer. | `tools-context.ts:719` |
| `nexus_context_draft_review_run` | **draftId** | Autonomously select and launch a read-only identity/session-independent reviewer. | `tools-context.ts:801` |
| `nexus_context_draft_supersede` | **targetPath** | Escape hatch for a wedged context pipeline: when draft_propose reports but draft_list shows nothing  | `tools-context.ts:770` |
| `nexus_context_scaffold` | — | Create the safe .context directory/config scaffold. | `tools-context.ts:600` |
| `nexus_cron` | **action**, name, schedule, brief, workspacePath, executionMode, agentName, squadId, id, status | Persistir definições de agenda (grant explícito + consentimento por mutação): action {name, schedule | `tools-domain.ts:1472` |
| `nexus_design_selection_get` | **paneId**, includeScreenshot | Read the current design-mode selection of a browser pane: L0 DOM context (tag/classes/selector/style | `tools-design.ts:27` |
| `nexus_design_system_extract` | **url**, items | Propose a ContextDraft from a live website through a per-request guarded Dembrandt runner. | `tools-design-system.ts:390` |
| `nexus_design_system_get` | **identifier** | Fetch the full DESIGN.md content of a design system from designmd.ai. | `tools-design-system.ts:261` |
| `nexus_design_system_import` | **identifier** | Import a DESIGN.md from designmd.ai as a proposed ContextDraft. | `tools-design-system.ts:297` |
| `nexus_design_system_local_import` | **kitId** | Propose a design contract ContextDraft from a keyless kit source (local-catalog or getdesign). | `tools-design-system-local.ts:269` |
| `nexus_design_system_local_list` | — | List design kits available WITHOUT any API key. | `tools-design-system-local.ts:212` |
| `nexus_design_system_publish` | name, description, tags | Publish the canonical DESIGN.md from the workspace to designmd.ai. | `tools-design-system.ts:526` |
| `nexus_design_system_search` | query, tags, limit | Search public design systems on designmd.ai. | `tools-design-system.ts:211` |
| `nexus_editor_apply_patch` | **patch** | Apply a hashline patch document to one or more workspace files. | `tools-editor.ts:198` |
| `nexus_editor_focus` | **path** | Focus the editor on a specific file. | `tools-editor.ts:30` |
| `nexus_editor_goto_line` | **path**, **line** | Navigate the editor cursor to a specific line and optionally column in a file. | `tools-editor.ts:248` |
| `nexus_editor_insert` | **path**, **text**, **line** | Insert text at a specific line and column in a file. | `tools-editor.ts:70` |
| `nexus_editor_replace_selection` | **path**, **oldText**, **newText** | Replace a range of text in a file. | `tools-editor.ts:135` |
| `nexus_file_close` | **path** | Close a file in the editor by its workspace-relative path. | `tools-files.ts:156` |
| `nexus_file_open` | **path** | Open a file in the editor by its workspace-relative path. | `tools-files.ts:115` |
| `nexus_file_read` | **path** | Read a file from the workspace. | `tools-files.ts:181` |
| `nexus_file_search` | **pattern** | Search for files in the workspace by glob pattern. | `tools-files.ts:340` |
| `nexus_file_write` | **path**, **content** | Write content to a file in the workspace. | `tools-files.ts:276` |
| `nexus_git_add` | items | Stage files for commit. | `tools-git.ts:375` |
| `nexus_git_branch_create` | **name** | Create a new branch. | `tools-git.ts:603` |
| `nexus_git_branch_list` | — | List local branches. | `tools-git.ts:580` |
| `nexus_git_branch_switch` | **name** | Switch to an existing branch. | `tools-git.ts:634` |
| `nexus_git_commit` | **message** | Record changes to the repository with a message. | `tools-git.ts:409` |
| `nexus_git_diff` | — | Show changes between commits, commit and working tree, etc. | `tools-git.ts:521` |
| `nexus_git_log` | — | Show commit logs. | `tools-git.ts:548` |
| `nexus_git_pull` | — | Fetch from and integrate with another repository or a local branch. | `tools-git.ts:478` |
| `nexus_git_push` ⚠️ | — | Update remote refs along with associated objects. | `tools-git.ts:440` |
| `nexus_git_status` | — | Show the working tree status: modified, staged, untracked files, and current branch. | `tools-git.ts:138` |
| `nexus_git_sync` | — | Safely update the current branch from its origin upstream. | `tools-git.ts:356` |
| `nexus_handoff_ack` | **handoffId** | Mark one delivered handoff as consumed after you actually processed its result. | `tools-handoff.ts:358` |
| `nexus_handoff_list` | missionId, includeDelivered | List submitted handoffs (undelivered by default; includeDelivered: true for the full audit trail). | `tools-handoff.ts:330` |
| `nexus_handoff_submit` | **status**, **summary**, artifacts, evidenceIds | Submit your work handoff to the orchestrator: {status: success\|partial\|blocked\|failed, summary, arti | `tools-handoff.ts:76` |
| `nexus_hunks_analyze` | **diff**, missionId | Parse a unified git diff and attribute hunks to mission agents (by pane paths) vs user/external. | `tools-hunks.ts:15` |
| `nexus_image_generate` ⚠️ | **prompt**, model, outPath, imagePath, items, aspectRatio, size | Generate an image and save it in the workspace. | `tools-media.ts:52` |
| `nexus_lsp_definition` | **path**, **line**, **column** | Resolve definitions at a scoped JavaScript/TypeScript source position. | `tools-lsp.ts:117` |
| `nexus_lsp_diagnostics` | **path** | Return syntactic and semantic TypeScript diagnostics for one scoped JavaScript/TypeScript source. | `tools-lsp.ts:153` |
| `nexus_lsp_references` | **path**, **line**, **column** | Find references at a scoped JavaScript/TypeScript source position. | `tools-lsp.ts:135` |
| `nexus_lsp_symbols` | **path** | List document symbols from one scoped JavaScript/TypeScript source. | `tools-lsp.ts:100` |
| `nexus_mcp_servers` | — | List the third-party MCP servers configured for this workspace (.nexus/mcp-hub.json — Settings → MCP | `tools-instruments.ts:413` |
| `nexus_media_providers` | — | List media generation providers (image/video/audio), their models, whether an API key is configured, | `tools-media.ts:36` |
| `nexus_memory_recall` | **query**, limit, kind, includeGlobal | Search memories retained for this workspace using SQLite FTS5 full-text match with BM25 ranking boos | `tools-memory.ts:109` |
| `nexus_memory_retain` | **content**, kind, importance, scope | Persist an agent-authored memory candidate (fact, decision, preference, or note) shared by every CLI | `tools-memory.ts:74` |
| `nexus_memory_stats` | — | Read memory bank statistics for this workspace and the user-global bank: totals, active counts, coun | `tools-memory.ts:135` |
| `nexus_merge_retry` | **missionId**, **taskId**, **expectedStateRevision** | Retry one blocked merge with exact queue CAS. | `tools-context.ts:1433` |
| `nexus_merge_review_submit` | **reviewSessionId**, **findings** | Submit the structured result of an active Nexus merge review. | `tools-context.ts:1306` |
| `nexus_merge_status` | **missionId** | Read the durable merge queue revision, task states and recovery events for the current mission. | `tools-context.ts:1403` |
| `nexus_merge_task` | **missionId**, **taskId** | Queue one completed task worktree for exact-CAS integration. | `tools-context.ts:1346` |
| `nexus_mission_control` | — | Mission-wide control-plane snapshot in ONE read: every pane with live activity (working\|idle\|dead) a | `tools-panes.ts:598` |
| `nexus_mission_create` | **title**, description, squadId, milestones | Create a mission (a tracked unit of orchestrated work). | `tools-domain.ts:208` |
| `nexus_mission_freeze_contract` | **missionId**, **goal**, **acceptanceCriteria**, nonGoals, id, statement, requiredSensorIds, invariantRefs, requiredArtifactIds, businessInvariantRefs, impactedDomains, impactedSymbols, requestedSensors, requiredArtifacts, riskHints | Compile and freeze the mission contract against the current committed context, Git base, invariants  | `tools-context.ts:876` |
| `nexus_mission_get` | **missionId** | Get a mission by id. | `tools-domain.ts:261` |
| `nexus_mission_list` | — | List missions, optionally filtered by status. | `tools-domain.ts:278` |
| `nexus_mission_refreeze_contract` | **missionId** | Re-freeze the mission contract after CONTEXT DRIFT (context revision changed post-freeze). | `tools-context.ts:968` |
| `nexus_mission_set_status` | **missionId**, **status** | Update a mission status (pending\|running\|blocked\|done\|failed). | `tools-domain.ts:316` |
| `nexus_mission_spawn_pane` | **missionId**, adapterId, agentName, model, effort, routeReservationId, taskId, cwd, prompt | Spawn a pane bound to a mission (worker pane). | `tools-domain.ts:532` |
| `nexus_model_ranking` | limit | Read the product + + + estimate: true + + | `tools-instruments.ts:284` |
| `nexus_pane_close` | paneId | Close a pane (collapses the layout and kills its session). | `tools-panes.ts:851` |
| `nexus_pane_list` | — | List every pane in the workspace with its live state (spawning\|busy\|idle\|exited), adapter, model and | `tools-panes.ts:589` |
| `nexus_pane_list_providers` | — | List the CLI/API providers (adapters) available on this machine: id, label, models, install status. | `tools-panes.ts:675` |
| `nexus_pane_read` | **paneId** | Read the tail of a pane | `tools-panes.ts:709` |
| `nexus_pane_read_many` | **paneIds**, lines | Read the output tails of several panes at once. | `tools-panes.ts:731` |
| `nexus_pane_spawn` | adapterId, agentName, model, cwd, title, missionId, taskId, prompt | Open a new terminal pane running an AI CLI. | `tools-panes.ts:209` |
| `nexus_pane_wait_idle` | **paneId**, timeoutMs, lines | Block until a pane + + + timeout | `tools-panes.ts:914` |
| `nexus_pane_wait_many` | **paneIds**, returnOn, timeoutMs | Wait on several panes. | `tools-panes.ts:943` |
| `nexus_pane_whoami` | — | Describe the calling pane and its effective authority: role, mission, agent/provider identity, proje | `tools-panes.ts:647` |
| `nexus_pane_write` | **paneId**, **text** | Type text into a pane | `tools-panes.ts:760` |
| `nexus_pane_write_many` | **paneId**, **text**, submit | Write prompts to several panes in one call. | `tools-panes.ts:791` |
| `nexus_perf_snapshot` | — | Return process memory, Electron metrics, live PTY count and browser view count. | `tools-browser.ts:388` |
| `nexus_plan_read` | path | Read the mission plan.md if present. | `tools-plan.ts:55` |
| `nexus_plan_review_run` | **missionId** | Autonomously run the independent Review Council for the frozen plan/contract before high-risk execut | `tools-context.ts:1532` |
| `nexus_plan_write` | **content** | Write the mission plan document (plan.md). | `tools-plan.ts:15` |
| `nexus_preview_start` | **dir** | Serve a built static web app inside the active workspace on a Nexus-owned 127.0.0.1 preview URL. | `tools-browser.ts:60` |
| `nexus_preview_stop` | — | Stop a project-scoped preview by its opaque id; omit id to list previews owned by the current projec | `tools-browser.ts:85` |
| `nexus_quota_status` | — | Read the last fleet quota snapshot: per provider/account, how much of each window (session / 5h / we | `tools-instruments.ts:171` |
| `nexus_recipe_propose` | — | Synthesize candidate squad recipes for this workspace from detected stacks and catalog overlay. | `tools-domain.ts:708` |
| `nexus_remote_bridge_status` | port | Manage the Nexus Remote Bridge WSS server. | `tools-domain.ts:745` |
| `nexus_remote_cli_detect` | **target** | SSH into target and detect supported remote CLIs. | `tools-domain.ts:768` |
| `nexus_remote_spawn` | **target**, **cli**, cwd, sessionName, prompt | Create/adopt a remote tmux session running a supported AI CLI over SSH. | `tools-domain.ts:792` |
| `nexus_remote_tmux_list` | **target** | List tmux sessions on a remote SSH target for adoption/recovery. | `tools-domain.ts:780` |
| `nexus_review_submit` | **missionId**, **findings** | Submit structured review findings bound to the exact contract/context/base/head/diff. | `tools-context.ts:1031` |
| `nexus_route_log` | — | Inspect the recent nexus_route_task decisions with their reason — so the adapter/model choice is aud | `tools-domain.ts:1088` |
| `nexus_route_task` | **task**, items | Mission-orchestrator-only: reserve the best cost/capability route for a task before spawning it. | `tools-domain.ts:1211` |
| `nexus_security_audit` | — | Read-only BridgeSecurity-style source audit for secret-like credentials, dynamic execution, sensitiv | `tools-security.ts:89` |
| `nexus_sensor_run` | **missionId**, **sensorId** | Run one configured sensor in the Nexus sandbox and persist trusted evidence bound to the exact integ | `tools-context.ts:1072` |
| `nexus_skills_inventory` | limit | List the skills (and optionally agents) actually installed on this machine (Settings → Skills): name | `tools-instruments.ts:574` |
| `nexus_squad_save` | **squad** | Save a squad definition (JSON schema: {id, name, createdAt, builtin, orchestratorInstructions, agent | `tools-domain.ts:566` |
| `nexus_sync_status` | — | Read the authenticated multi-PC metadata sync status for this exact project. | `tools-sync.ts:5` |
| `nexus_system_doctor` | — | Fail-closed operational readiness for this computer and checkout: Git, project identity, SQLite, con | `tools-context.ts:592` |
| `nexus_task` | **action**, title, detail, taskId, missionId, ownership, dependsOn, tasks | Tracked background work items. | `tools-domain.ts:832` |
| `nexus_terminal_kill` | — | Kill a running terminal command by its process id. | `tools-terminal.ts:385` |
| `nexus_terminal_run` | **command** | Run a shell command in the workspace directory. | `tools-terminal.ts:164` |
| `nexus_todo_manager` | **action**, tasks, task, listId | User-visible task list with milestones. | `tools-domain.ts:994` |
| `nexus_ui_action` ⚠️ | **action**, **ref**, text | Read-then-act tool for the NexusIDE interface. | `tools-vision.ts:127` |
| `nexus_ui_read` | — | Read the currently visible NexusIDE page/dialog/settings surface through its accessibility tree. | `tools-vision.ts:75` |
| `nexus_validation_run` | **missionId** | Run the full final validation for the integrated mission diff: mandatory Nexus sensors plus independ | `tools-context.ts:1501` |
| `nexus_video_generate` ⚠️ | prompt, model, outPath, durationSeconds, resolution, aspectRatio, imagePath, endImagePath, items, recoverJobId | Generate a video clip and save the mp4 in the workspace. | `tools-media.ts:124` |
| `nexus_worker_heartbeat` | — | Renew the durable lifecycle lease for this exact worker PTY. | `tools-handoff.ts:393` |
| `nexus_workflow_advance` | **missionId**, **next** | Ask Nexus to advance exactly one non-final PREVC stage. | `tools-context.ts:1098` |
| `nexus_workflow_get` | **missionId** | Read the frozen mission contract and current computed PREVC stage. | `tools-context.ts:1018` |
| `nexus_workflow_prepare_execution` | **missionId** | Advance a Main-frozen guided PREVC workflow through deterministic planning and required independent  | `tools-context.ts:1131` |
| `nexus_worktree_create` | **missionId**, **taskId**, **workerId**, **ownership**, dependsOn | Reserve an isolated Git worktree for one mission task with explicit file/symbol/domain ownership and | `tools-context.ts:1183` |
| `nexus_worktree_get` | **missionId**, **taskId** | Read the trusted worktree record for one mission task. | `tools-context.ts:1285` |

**Tools sem o prefixo `nexus_`** (o namespace não é 100% uniforme):

| Tool | Call site | Observação |
|---|---|---|
| `load_workspace_dependencies` | `tools-workspace-dependencies.ts:18` | Registrada por `buildWorkspaceDependencyTools()` (`tools.ts:57`) |
| `impeccable` | `tools-design-system*.ts` (2 ocorrências) | Nome de skill/kit, não de tool no namespace |

---

## 3. Não-óbvio / armadilhas

1. **"MCP Hub" é ambíguo e o brief da missão cai na armadilha.** `src/main/mcp-hub/` é config-plane e **não executa tool nenhuma** — o próprio `docs/MCP-HUB.md:6` avisa: "**Does not** bypass `mcp-dispatch` effect policy, schema validation, allowlist, or audit". As tools `nexus_*` vivem em `src/main/orch/tools-*.ts` e são servidas por `mcp-server.ts`. Quem procurar as 142 tools dentro de `src/main/mcp-hub/` não vai achar nada.

2. **O hub não aparece no boot.** Nenhum `registerMcpHubIpc()` no `bootstrap()`. Ele é puxado por três consumidores (§2.2), sendo um deles um `await import()` **dinâmico** dentro de um handler de tool (`tools-instruments.ts:503`) — invisível para busca de imports estáticos.

3. **`registerMcpIpc()` no boot NÃO é o hub.** `main.ts:559` chama `registerMcpIpc` de `./jarvis/mcp-ipc` — a ponte do Jarvis, outro subsistema. Confusão fácil pelo nome.

4. **O Jarvis não usa o servidor MCP.** `fase4-mcp-map.md:70` é explícito: o Jarvis chama estado do renderer direto (Zustand), e o servidor MCP existe **só** para as CLIs dentro dos panes. Duas superfícies de ação paralelas, não uma.

5. **`.nexus/mcp-hub.json` guarda segredos em plaintext.** Verificado no arquivo atual: PAT do GitHub (`gho_…`), access token do Supabase (`sbp_…`), API keys de Firecrawl e TestSprite, token de runtime do BridgeSpace. `docs/MCP-HUB.md:49` e `:57` dizem "secrets masked" — isso é a **projeção da UI**, não o disco. As proteções reais são duas, e ambas checam: modo do arquivo `-rw-------` (0600) e `.gitignore:138` (`/.nexus/mcp-hub.json`). Confirmado que o arquivo **nunca** entrou em commit (`git log --all -- .nexus/mcp-hub.json` vazio). Ainda assim: qualquer processo rodando como o usuário lê esses tokens, e o hub os **importa de** e **exporta para** configs de outras tools que têm suas próprias posturas de permissão.

6. **A propagação `nexus_*` não é uniforme, e isso é decisão, não bug.** Cada família de CLI tem um mecanismo próprio (§1.B.1). O caso mais forte é AGY: excluído de propósito porque anunciá-lo como capaz de MCP **faz o worker esperar para sempre** (`cli-mcp-inject.ts:60-62`). A rota de conclusão dele é marcador no stream do PTY. Ver a matriz completa em [`../2026-08-05-mcp-hooks-propagation-audit.md`](../2026-08-05-mcp-hooks-propagation-audit.md) §"Matriz real hoje".

7. **`--strict-mcp-config` é performance e sanidade, não só segurança.** O comentário em `mcp-server.ts:775-787` explica: sem ele, a identidade OAuth carregada faz o Claude baixar os conectores MCP **da conta** (Drive, Vercel, HF…) — meia dúzia de OAuth remotos no boot de um agente que só pode usar `mcp__nexus`. Isso atrasava o boot (o paint espera o handshake MCP) e afogava o orquestrador em ferramentas que ele nunca poderia chamar.

8. **O token do Codex nunca passa pelo argv.** `codexMcpArgs` emite `bearer_token_env_var="NEXUS_MCP_TOKEN"` — o nome da variável, não o valor (`cli-mcp-inject.ts:102`). O segredo viaja pelo ambiente do processo. Quem auditar a linha de comando de um Codex governado não vai ver o bearer.

9. **`tool_timeout_sec = 45` é fail-closed com motivo nomeado.** `cli-mcp-inject.ts:76-81`: um `tools/call` pendurado — o exemplo citado é `Promise.all` concorrente vindo do `codex exec` — "falha fechado em vez de estacionar o orquestrador para sempre e matar de fome a entrega de handoff / o selamento do plano".

10. **Três famílias de tools não aparecem em `buildToolset()`.** Browser (14) e handoff (4) entram por dentro de `buildDomainTools()` (`tools-domain.ts:1587`, `:1607`); design-system keyless (2) por dentro de `buildDesignSystemTools()` (`tools-design-system.ts:602`). O docblock de `tools.ts:24-37` lista os grupos em prosa, mas a lista de spreads em `:39-61` não os mostra — contar builders dá 21 e subestima a superfície.

11. **`tools-handoff.ts` usa aspas duplas.** Um grep por `name: 'nexus_` (aspas simples) sobre `src/main/orch/tools*.ts` retorna **140** e perde silenciosamente as 4 tools de handoff, declaradas com `"` (`tools-handoff.ts:70`, `:301`, `:329`, `:364`). O total correto é **142**.

12. **Erro de tool não é erro de protocolo.** Falhas voltam como resultado com `isError: true` (`mcp-protocol.ts:135-137`). Um cliente que só trate erros JSON-RPC vai considerar sucesso toda falha de tool.

13. **`assertCurrentAuthority()` existe porque autoridade expira no meio da chamada.** `mcp-protocol.ts:58-62` obriga handlers com efeito a revalidar o caller **depois** do preparo assíncrono e **imediatamente antes** do efeito. Um handler que valide só na entrada tem janela para agir com autoridade já revogada.

14. **`effectMayHaveCommitted` no resultado.** `shared/mcp-types.ts:16-17`: "A failed call may have applied its effect; callers must not retry blindly." O contrato admite explicitamente efeito parcial — retry automático em cima de falha é incorreto por design.

15. **Purga de artefatos acontece no START, não no stop.** `startMcpServer()` limpa configs AGY e sessões de CLI obsoletas antes de subir (`mcp-server.ts:1122-1133`), e loga quando a purga foi **incompleta** (`truncated`). Um crash deixa lixo que só some no próximo boot.

---

## 4. Essencial vs incidental

### Essencial

| Item | Fonte | Por quê |
|---|---|---|
| Bearer por agente, checado antes de qualquer roteamento | `mcp-server.ts:1150-1153` | É a única fronteira de autenticação; 401 antes de decidir rota |
| Loopback + porta aleatória | `mcp-server.ts:188`, `:1183` | A superfície nunca sai da máquina |
| `mintToken` amarrando role/missão/allowlists | `mcp-server.ts:681`, `gate.ts:224` | Sem isso não existe autorização por objeto entre agentes |
| `assertCurrentAuthority()` | `mcp-protocol.ts:58-62` | Fecha a janela entre validação e efeito |
| `requiresConfirm` (9 tools) | `mcp-protocol.ts:45-46` | Confirmação que sobrevive a mudança do guardrail genérico |
| `dispatchToolCall` central | `mcp-dispatch.ts:495` | Ponto único de política de efeito, schema, allowlist e auditoria |
| Cleanup total em falha de preparo | `mcp-server.ts:909-917` | Impede token/artefato órfão com autoridade viva |
| `--strict-mcp-config` em pane governado | `mcp-server.ts:824` | Impede herança de conectores MCP do operador numa missão |
| Token do Codex fora do argv | `cli-mcp-inject.ts:102` | Segredo não vaza em `ps` |
| Exclusão explícita do AGY | `cli-mcp-inject.ts:62` | Evita worker travado para sempre |
| Células `unknown` na matriz | `shared/mcp-across-tools.ts:17` | Não inventar presença é o que torna o drift confiável |
| `dryRun` + `.bak` + never-delete no sync | `docs/MCP-HUB.md:21`, `:25` | O hub escreve em configs de **outras** ferramentas do usuário |
| Fail-closed do Cline | `docs/MCP-HUB.md:32-34` | Não criar arquivo em host errado |

### Incidental

| Item | Fonte | Observação |
|---|---|---|
| `acrossToolsBanner` (texto do banner) | `shared/mcp-across-tools.ts:75-96` | Cosmético; lógica de drift é que importa |
| `MCP_ACROSS_TOOL_LABELS` | `shared/mcp-across-tools.ts:46-53` | Rótulos de UI |
| `normalizeMcpServerKey` | `shared/mcp-across-tools.ts:56-62` | Conveniência (`TestSprite` ≈ `testsprite`) |
| Conjunto exato das 5 tools exportáveis | `shared/mcp-hub-sync-api.ts:6-12` | Lista cresce com o ecossistema |
| `CODEX_MCP_TOOL_TIMEOUT_SEC = 45` | `cli-mcp-inject.ts:81` | O **valor** é ajustável; ter um teto é essencial |
| `codexHookTrustBypassArgs` version-gate | `mcp-server.ts:866` | Compatibilidade com versão de Codex, some quando o piso subir |
| Composição das 142 tools | `tools.ts:38-62` | Superfície de produto, cresce/encolhe por feature |
| Parser legado de handoff | `mcp-server.ts:1144` | Ponte para agentes não-MCP; desaparece quando todos falarem MCP |

---

## 5. Lacunas

- **lacuna:** `mcp-hub-core.ts` (234 L), `mcp-hub-observers.ts` (422 L) e `mcp-hub-sync.ts` (525 L) não foram lidos linha a linha. Todo o passo A2–A17 do trace (A) apoia-se em `docs/MCP-HUB.md` + call sites. Especificamente **não verificados no código**: limite de 64 servers e 512 tools/server, a escrita do `.bak` timestamped, `rollbackFromBackup`, o fail-closed do Cline e o comportamento exato quando `feature.mcp.hub` está off.
- **lacuna:** `mcp-dispatch.ts` (1496 L) foi inspecionado só pelos exports. **Não sei** como `dispatchToolCall` aplica allowlist, valida schema, decide confirmação nem o que grava em auditoria — e essa é a camada onde a política de efeito realmente vive.
- **lacuna:** `gate.ts` não foi lido. `mintToken` (`gate.ts:224`), `isSkillAllowed`, `isHookToolAllowed`, `bindTokenToSession`, `evaluateStop` e o ciclo de vida/expiração do token são conhecidos só pelo nome no import (`mcp-server.ts:20-32`).
- **lacuna:** as descrições na tabela §2.4 foram extraídas por script a partir do campo `description:` adjacente ao `name:`, truncadas na primeira frase (100 chars). Descrições montadas por concatenação multilinha podem estar cortadas; nenhuma foi revisada manualmente uma a uma.
- **lacuna:** a coluna "Params" da §2.4 lista `required[]` + chaves de `properties` detectadas por regex de indentação (≥ 6 espaços). Schemas aninhados, `oneOf`/`anyOf` e propriedades declaradas fora desse padrão podem estar ausentes ou sobrando.
- **lacuna:** não verifiquei quais das 142 tools são efetivamente **expostas a um dado agente**. A allowlist por token (`allowedTools` em `mintToken`) filtra isso, mas não tracei onde o filtro é aplicado em `tools/list`.
- **lacuna:** `prepareOpenCodeMcpSession`, `prepareKimiMcpSession` e `prepareGrokMcpSession` (`cli-mcp-session-*.ts`) não foram abertos; sei que retornam `{env, extraArgs, providerStateHome}` mas não o formato concreto entregue a cada CLI.
- **lacuna:** o `handleGateRequest` e o `handleHookStatusHttp` (`mcp-server.ts:1161`, `:1167`) são fronteira de F3, não auditados aqui.
- **lacuna:** não testei nada em execução. Nenhuma tool foi chamada; o servidor não foi observado no ar. Tudo é leitura estática.

---

## 6. Auditorias relacionadas

- [`../../MCP-HUB.md`](../../MCP-HUB.md) — contrato do subsistema **(A)**. Ainda **coerente com o código** nos pontos que consegui verificar: os 3 módulos que ele nomeia em "Ownership" (`:38-41`) existem com esses nomes, os canais IPC (`:14`, `:20`) batem com `product-wave-ipc.ts:44-46`, e o enum de 5 tools exportáveis (`:24`) bate com `shared/mcp-hub-sync-api.ts:6-12`. Este F2 **agrega** o que falta nele: quem o consome (§2.2 — o doc não diz), e a separação explícita entre (A) e (B) (§0).

- [`../fase4-mcp-map.md`](../fase4-mcp-map.md) — mapa do subsistema **(B)**, escrito como **plano de implementação** ("§5. New tools to add"). Verificação do que aquele plano previa:

  | `fase4-mcp-map.md` | Estado hoje | Fonte |
  |---|---|---|
  | §1 "10 existing pane tools" (`:24`) | Agora **13** em `tools-panes.ts` — somaram-se `nexus_mission_control` (`:582`), `nexus_pane_whoami` (`:631`) e `nexus_pane_read` foi mantida | `tools-panes.ts:205-881` |
  | §1 `buildToolset()` = panes + domain + media (`:19-22`) | Agora **21 builders** (+3 aninhados) | `tools.ts:38-62` |
  | §5.1 `tools-files.ts` — 5 tools previstas | **Entregue**, exatamente as 5 nomes previstos | `tools-files.ts:115-340` |
  | §5.2 `tools-terminal.ts` — `nexus_terminal_run`/`_kill` | **Entregue** | `tools-terminal.ts:164`, `:385` |
  | §5.3 `tools-git.ts` — 10 tools previstas | **Entregue + 1**: as 10 previstas mais `nexus_git_sync` (`:356`) | `tools-git.ts:138-634` |
  | §5.4 `tools-editor.ts` — 4 tools previstas | **Entregue + 1**: as 4 mais `nexus_editor_apply_patch` (`:198`) | `tools-editor.ts:30-248` |
  | §6 `src/main/jarvis/audit-log.ts` | **Existe** e é configurado no boot | `main.ts:289-292`, `:439` |
  | §2 switch do Jarvis em `voice-controller.ts` (~775-955) | **lacuna:** não reverifiquei essas linhas nesta passagem |
  | §4 "Key insight: o Jarvis NÃO usa o MCP server" (`:70`) | **Continua verdadeiro** — nenhum caminho do Jarvis passa por `mcp-server.ts` nos call sites que li | — |

  > Ou seja: o plano da fase 4 foi cumprido e ultrapassado. De ~24 tools no horizonte daquele doc para **142** hoje.

- [`../2026-08-05-mcp-hooks-propagation-audit.md`](../2026-08-05-mcp-hooks-propagation-audit.md) — a auditoria de propagação. **Fonte primária da §1.B.1**; não reescrevi a matriz dela aqui. Reverificação das citações dela contra o HEAD atual:

  | Citação da auditoria | Estado hoje | Nota |
  |---|---|---|
  | `cli-mcp-inject.ts:62` — AGY excluído | **Bate exatamente** — `if (adapter.quirks.nexusMcp === "agy") return false;` está na linha 62 | ✅ |
  | `mcp-server.ts:833` — Codex via `-c mcp_servers.*` | **Derivou** para `mcp-server.ts:846` (chamada de `codexMcpArgs`); a geração dos `-c` está em `cli-mcp-inject.ts:99-104`. `bc2c7416` (16:30 de hoje) tocou este arquivo | ⚠️ linha movida |
  | `mcp-server.ts:443-463` — autoridade do evento `stop` | **lacuna:** não reverifiquei |
  | `gate.ts:619-639` — `evaluateStop` | **lacuna:** não reverifiquei (F3) |
  | `spawn-home-policy.ts:37-59` — `shouldUseEphemeralHome` | **lacuna:** não reverifiquei (F3) |

  O "furo" central daquela auditoria — worker Claude em política `operator-choice` roda **sem** o Stop bloqueante — é **de hooks (F3)**, não de MCP: a superfície `nexus_*` chega normalmente nesse caso (`mcp-server.ts:808-826`). Os dois eixos são independentes e a auditoria os separa corretamente na matriz de `:32-39`.

- [`./F1-arquitetura-entrypoints.md`](./F1-arquitetura-entrypoints.md) — `initOrchestration()` (`main.ts:641`) e `registerMcpIpc()` (`main.ts:559`) aparecem lá como passos de boot; o detalhe do que sobe está aqui em §1.B.
- [`./F3-hooks-lifecycle.md`](./F3-hooks-lifecycle.md) — dono de `/gate/*` e `/hook/status` (`mcp-server.ts:1161-1170`), de `evaluateStop` e da política de HOME efêmero.
- [`./F4-orquestracao.md`](./F4-orquestracao.md) — dono de `mcp-dispatch.ts`, `gate.ts` e do ciclo de vida de missão que as tools `nexus_mission_*` / `nexus_handoff_*` movimentam.
- [`./F5-adapters-failover.md`](./F5-adapters-failover.md) — dono de `adapter.quirks` (`mcpAutoload`, `nexusMcp`), que é o que decide o ramo de propagação em §1.B.1.
