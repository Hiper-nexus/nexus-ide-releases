# Dossiê Técnico — Harness Runtime do BridgeSpace 3.4.18

**Data:** 2026-09-03 · **Alvo:** harness runtime do BridgeSpace 3.4.18 (BridgeMind), extraído para `docs/analysis/bridgespace-3418-extract/harness/`
**Escopo:** integração com agentes CLI, orquestração de swarms, BridgeMemory MCP, skills e arquivos de runtime. Complementa o `DOSSIE.md` (visão geral da extração).
**Nota de método:** o `harness/` espelha `~/.bridgespace/` + fatias de `~/Library/Application Support/`. Caminhos citados são relativos a `harness/`, salvo indicação contrária. Nada aqui é código-fonte do app — é o material runtime legível (scripts `.cjs`, JSON, Markdown) que o app instala e consome.

---

## 0. Mapa do harness

```
harness/
├── bin/
│   ├── bs-claude-hook.cjs        (312 l.) dispatcher de hooks do Claude Code
│   └── bs-agent-notify.cjs       (545 l.) adaptador genérico p/ Codex/Cursor/outros
├── bridgememory-mcp/
│   ├── server.cjs                (22.013 l.; bundle esbuild — código próprio em 21015–22013)
│   └── SKILL.md                  (91 l.) skill do BridgeMemory distribuída aos agentes
├── runtime.session               token de runtime (64 hex chars = sha256-like)
├── bridgememory.active           path do hub ativo (vazio neste snapshot)
├── history.db                    SQLite WAL — histórico de comandos + agent_sessions + refinery
├── claude-hooks/global/          drop-box de status (vazia neste snapshot — consumida pelo app)
├── claude-hooks/scopes/          marcadores de escopo de swarm (vazia)
├── agent-hooks/global/           drop-box genérica de status (vazia)
├── skills/                       (vazia neste snapshot)
├── logs/claude-hook-stdin-debug.log
├── swarms/1182a86f584ad1/        um swarm real completo (ver §3)
├── app-support/io.bridgemind.bridgespace/
│   ├── session.alive.v1.json     heartbeat do processo principal
│   ├── mobile-bridge-config.json {"binding":"loopback","port":47421}
│   ├── auth_credentials.enc / auth_storage.key / mobile-bridge-token  (secrets — não lidos)
│   └── shell-integration/        loaders ZDOTDIR + integration.zsh/.bash (OSC 133, OSC 9;9)
└── app-support/{BridgeMindOne,ai.bridgemind.one,bridgemind}/   apps irmãos (chat, PostHog, BridgeVoice)
```

`.gitignore` do `.bridgespace/` é `*` — o diretório inteiro é efêmero/regenerado.

---

## 1. Integração com agentes CLI (hooks e eventos)

O BridgeSpace não parseia saída de terminal para saber o estado do agente: ele **instala hooks na config global de cada CLI** e recebe eventos estruturados via **drop-box de arquivos JSON** vigiada pelo app (`fs.watch`). Dois scripts cobrem dois universos:

### 1.1 `bin/bs-claude-hook.cjs` — dispatcher do Claude Code

Registrado nos hooks do Claude Code (`SessionStart`, `UserPromptSubmit`, `Stop`, `Notification`). Fluxo:

1. **Lê o payload JSON do stdin** (`readStdinSync`, `bs-claude-hook.cjs:15-23`) — o Claude inclui `cwd`, `session_id`, `transcript_path` e `prompt` em todo evento.
2. **Deriva o workspace root** com 3 fallbacks (`deriveWorkspaceRoot`, :31-48): `stdinPayload.cwd` → heurística de path legado (`<ws>/.bridgespace/bin/`) → `process.cwd()`.
3. **Resolve o escopo de swarm** (`resolveScopeContext`, :78-100): env `BRIDGESPACE_SWARM_SCOPE_ID` → marcador `<ws>/.bridgespace/claude-hooks/scopes/<scopeId>.json` (com `binDir`); se houver exatamente 1 escopo ativo, usa-o. O marcador aponta para o `bin/` do swarm (ex.: `swarms/1182a86f584ad1/bin`).
4. **Despacha por evento** (:261-310):
   - `session-start` → escreve status global `running` (torna `claude --resume` observável; renderer trata como não-visível).
   - `user-prompt-submit` → **`bs-mail.cjs check --inject`** (injeta inbox do swarm no turno) + grava o `userPrompt` no status global.
   - `stop` → `bs-notify.cjs idle "Finished working"` (via `dispatchStatus`) ou status global no caminho sem swarm.
   - `notification` → `needs-input` / `"Needs input"`.
5. **Drop-file atômico** (`writeGlobalStatus`, :205-259): escreve `<sessionId>--<timestamp>-<evento>.json` em `~/.bridgespace/claude-hooks/global/` via **tmp + rename** (:250-255), **um arquivo por evento** para que eventos back-to-back (Stop→Notification) não se sobrescrevam antes do watcher ler.

**Envelope do drop-file** (:217-241):

```json
{
  "sessionId": "<BRIDGESPACE_SESSION_ID — id do pane PTY>",
  "status": "running|idle|needs-input",
  "title": "...", "body": "...",
  "event": "stop|notification|session-start|user-prompt-submit",
  "cwd": "...", "pid": 1234, "timestamp": 1786047336056,
  "userPrompt": "<prompt do usuário, truncado em 4KB>",
  "nativeSessionId": "<session_id do Claude — para `claude --resume <id>`>",
  "transcriptPath": "<path do JSONL — continuação cross-account>",
  "configDir": "<$CLAUDE_CONFIG_DIR — perfis de conta AI>",
  "agentType": "claude"
}
```

Detalhe-chave de design: **dois namespaces de sessão** (`bs-claude-hook.cjs:144-147`) — `BRIDGESPACE_SESSION_ID` (id do PTY/pane, injetado pelo spawn em `src-tauri/src/main.rs`) para correlação de UI, e `nativeSessionId` (id de conversa do CLI) para recovery estilo Warp (`claude --resume <id>`, precisa rodar sob o mesmo `configDir`).

⚠️ **Risco observado (não portar como está):** o breadcrumb de debug grava `stdinRaw.slice(0,200)` — 200 chars do prompt bruto — em `logs/claude-hook-stdin-debug.log` (:191-199). O log real do extract confirma entradas com `stdinLen:0` (diagnóstico de stdin vazio em FIFOs).

### 1.2 `bin/bs-agent-notify.cjs` — adaptador genérico (Codex, Cursor, Grok etc.)

Invocado por configs globais (`~/.codex/config.toml`, `~/.cursor/hooks.json`, …) com `--agent codex --event <ev>`. Responsabilidades:

- **Normalização de eventos → status canônico** (:457-476): `stop|agent-response|after-agent`→`idle`; `notification|needs-input`→`needs-input`; `error`→`error`; `session-start`→`running`; `session-end`→`ended`. Eventos `prompt-submit|before-agent|user-prompt-submit` são **ignorados** (fluxo removido, :390-392).
- **Extração tolerante de payload**: session id em 4 chaves (`session_id/sessionId/session-id/session.id`, :64-73); thread id do Codex em ~10 variantes (:75-94); corpo em `last_assistant_message` etc. (:96-104); prompt em `input_messages[]` (:106-117).
- **Filtro de subagentes Codex** (:127-245): detecta threads não-primárias por `source.subagent`, `parent_thread_id`, marcadores de identidade de agente (`agent_id`, `agent_role`…), e — se o payload não bastar — **faz scan limitado** (5000 dirs / 20000 arquivos) dos rollouts `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (:257-324) lendo o `session_meta` dos primeiros 256 KB (:326-353). Subagentes não geram notificação.
- **Gate de posse** (:428-433): sem `BRIDGESPACE_SESSION_ID` (nem `--session-id`), `exit 0` — agentes disparados por outros IDEs não poluem a UI.
- **Drop-box** `~/.bridgespace/agent-hooks/global/` com tmp+rename e fallback Windows (EEXIST/EPERM → unlink+copy, :522-540). Envelope idêntico ao do Claude, mais `agentType` e `configDir` (`CODEX_HOME`/`CLAUDE_CONFIG_DIR`, :487-492).

**Regra de ouro dos dois scripts:** hook nunca falha o processo pai — todo erro é engolido (`exit 0`).

### 1.3 Shell integration (OSC 133 + OSC 9;9)

`app-support/io.bridgemind.bridgespace/shell-integration/`: o app **sobrescreve `ZDOTDIR`** apontando para este diretório, cujos `.zshenv`/`.zprofile`/`.zshrc` primeiro carregam o ambiente real do usuário (`__BS_ORIG_ZDOTDIR`, `/etc/zprofile` para `path_helper`, gate `BRIDGESPACE_FAST_SHELL` para shells não-login) e depois dão source em `integration.zsh`/`integration.bash`:

- `OSC 133 A/B/C/D;exitcode` (prompt/comando/saída/exit code) — marcação semântica de blocos;
- `OSC 9;9;<cwd>` — reporte de CWD (estilo ConEmu/iTerm), emitido a cada `precmd`.

É o mesmo padrão de shell integration do VS Code, com loader **reversível** (preserva o `.zshrc` do usuário).

---

## 2. BridgeMemory MCP (`bridgememory-mcp/`)

Bundle esbuild CJS single-file (`server.cjs`, `#!/usr/bin/env node`): ~21k linhas de vendor (ajv, zod, `@modelcontextprotocol/sdk`) + **~999 linhas de código próprio em `server.cjs:21015-22013`** (comentários de módulo esbuild preservam os paths: `src/runtimeGate.ts`, `src/hub.ts`, `src/tools.ts`, `src/wikilinks.ts`, `src/index.ts`). Servidor: `bridgememory-mcp@0.2.0`, transporte **stdio/NDJSON** (`StdioServerTransport`, :21999), com **orphan guard** — `setInterval` de 30s que sai se reparentado para init (:22001-22007).

### 2.1 Runtime gate (anti-uso fora do app)

`assertBridgeSpaceRuntime` (`server.cjs:21030-21061`): exige env `BRIDGESPACE_RUNTIME_TOKEN` e compara em **tempo constante** (`constantTimeEquals`, XOR byte a byte, :21062-21069) com o conteúdo de `~/.bridgespace/runtime.session` (override via `BRIDGESPACE_RUNTIME_SESSION_FILE`). **Degrada graciosamente** (:21982-21998): se o gate falha, o servidor **sobe mesmo assim** e cada tool responde `isError` com `reason` + `hint` acionável ("abra um terminal novo no BridgeSpace"). Não derruba o agente.

### 2.2 Modelo de dados — hub

- Hub = diretório marcador **`.bridgememory/`** na raiz de um projeto; pode ser junction/symlink **resolvendo dentro do root** (escape é rejeitado, `resolveMemoryFolder` :21210-21225).
- Cada memória = arquivo `.md` **sem frontmatter**; **título = primeiro H1** (`extractTitle` :21295-21303); filename = slug do título (`slugify` :21101-21103, colisões recebem `-2`, `-3`… com teto de 1000).
- **`index.json` NÃO é índice de busca** — só `{version, name, createdAt}` (:21309-21316).
- `init_hub` cria `.bridgememory/` + `index.json` + `welcome.md` (:21304-21337).
- Links: `[[Título]]` e `[[Título|alias]]` (`WIKILINK_RE` :21080, `parseWikilinks` :21081-21100).

### 2.3 Descoberta do hub

`resolveHub` (:21690-21716): (1) **walk-up** de até **64 níveis** a partir de `cwd` (param opcional de toda tool; default = cwd do processo) procurando `.bridgememory/`; (2) fallback para o arquivo apontado por **`BRIDGESPACE_ACTIVE_HUB_FILE`** (`readActiveHubFile` :21284-21294 — é o `bridgememory.active`, escrito pelo app quando o usuário abre um hub no painel). `hub_status` reporta `source: "cwd" | "active-hub-file"`.

### 2.4 As 12 tools MCP (registro em `server.cjs:21725-21975`)

| # | Tool | Params | Efeito |
|---|------|--------|--------|
| 1 | `hub_status` | `cwd?` | Root/nome do hub + stats (`memories`, `links`, `orphans`) + `source` da descoberta; `hub: null` se nada. Barata — "chame primeiro". |
| 2 | `list_memories` | `cwd?` | Todas as memórias newest-first: `{id, title, fileName, modified, size, outgoingLinks}`. |
| 3 | `read_memory` | `identifier`, `cwd?` | Corpo completo. `identifier` casa H1 (ci) → filename → path absoluto (`findMemory` :21478-21497). Miss → erro com **3 sugestões ranqueadas** (`findMemorySuggestions` :21498-21518). |
| 4 | `search_memories` | `query`, `limit?≤100`, `mode? all|any`, `cwd?` | Busca tokenizada full-scan (sem índice). Scoring: **+5** token no título, **+1**/ocorrência no corpo (teto 5/token), **+3** título contém query verbatim; desempate por recência. `all` = AND de tokens (precisão); zero hits em `all` → dica automática "tente `any`" com contagem (:21879-21887). Snippet = janelas ±40/80 chars mescladas, ≤400 chars (`buildSnippet` :21601-21634). |
| 5 | `create_memory` | `title≤200`, `body?`, `cwd?` | Cria `.md` com H1 garantido (`ensureLeadingHeading` :21417-21422); escrita **atômica** tmp+rename (`atomicWriteFile` :21260-21273). |
| 6 | `append_to_memory` | `identifier`, `addition`, `cwd?` | Append com `O_APPEND|O_NOFOLLOW` (anti-symlink, :21246-21259), separado por linha em branco. Preferido sobre update. |
| 7 | `update_memory` | `identifier`, `body`, `cwd?` | Substitui corpo inteiro (risco de perder wikilinks — doc desencoraja). |
| 8 | `delete_memory` | `identifier`, `cwd?` | `unlink` irreversível; doc exige pedido explícito do usuário. |
| 9 | `find_backlinks` | `target`, `cwd?` | Todas as memórias com `[[target]]` + linha de contexto (`findBacklinks` :21519-21541). |
| 10 | `list_orphans` | `cwd?` | Órfão = **sem incoming E sem outgoing resolvível** — link quebrado não conta como aresta (:21635-21651). |
| 11 | `suggest_connections` | `identifier`, `limit?≤20`, `cwd?` | Sugere notas que compartilham **tokens distintivos** (≥4 chars, não-stopword EN, `STOPWORDS` :21104-21167) e ainda não linkadas; retorna `{score, sharedTerms[:4]}` (`suggestConnections` :21177-21193). |
| 12 | `init_hub` | `rootPath` | Cria hub; idempotente; "SÓ quando o usuário pedir explicitamente". |

Toda resposta segue envelope MCP `{content:[{type:"text", text: JSON}]}`; erros com `isError:true` + `hint` acionável (`ok`/`err` :21654-21665). Arquivos `.md` symlink ou que resolvem fora do hub são **ignorados** (`safeMemoryFile` :21234-21245).

### 2.5 SKILL.md — a "skill" distribuída

`bridgememory-mcp/SKILL.md` (frontmatter `name: bridgememory`) é o **manual operacional injetado no agente**: tabela das 12 tools, política editorial ("escreva só fatos duráveis e não-óbvios; nunca estado efêmero nem resumo de conversa"), fluxo "search first → título estável → corpo autocontido com `**Why:**`/`**How to apply:**` → wikilinks → `suggest_connections`", e a regra "se `hub_status` retorna `hub: null`, pergunte antes de `init_hub` — nunca crie hub silenciosamente". A pasta `skills/` do harness está **vazia neste snapshot** — a única skill presente no extract é esta (as demais skills da marca vivem no app BridgeMindOne, fora do escopo).

---

## 3. Sistema de swarms (`swarms/1182a86f584ad1/`)

Orquestração multi-agente **100% em filesystem** (a análise F5 do próprio swarm confirma: zero símbolos `swarm*` no binário Rust — watchers e spawn vivem no frontend JS). Um swarm = um **scope dir**:

```
swarms/<scopeId>/
├── SWARM_BOARD.md          board humano/MD lido por todos os agentes
├── agents.json             [{"label":"Coordinator 1","role":"coordinator"}, … 4 builders]
├── prompt-<Agente>-<ts>.md prompt semeado por agente (gerado pelo mission wizard)
├── bin/                    bs-swarm.cjs (323 l.) · bs-mail.cjs (200 l.) · bs-notify.cjs (36 l.)
│                           + shims sh/cmd
├── plan/events/*.json      plano EVENT-SOURCED append-only (83 eventos neste swarm)
├── transcript/*.json       toda mensagem bs-mail (33 neste swarm) — cópia imutável
├── inbox/<Agente>/*.json   mensagens a consumir (destructivo) — aqui só restam 2 p/ @operator
├── status/<Agente>.json    último status reportado por agente
└── nudges/<Agente>.txt     marcador "Message from X" (apagado após consumo)
```

Env injetado no spawn de cada agente: `SWARM_AGENT_NAME` (identidade), `BRIDGESPACE_SWARM_SCOPE_ID` (roteia o hook Claude, §1.1), `BRIDGESPACE_SESSION_ID` (pane).

### 3.1 `bin/bs-swarm.cjs` — plano event-sourced

- **Não há arquivo de estado**: `readState()` = `readEvents().reduce(applyEvent, {goals:[],tasks:[]})` (:183-185) — replay dos `.json` ordenados de `plan/events/`.
- Tipos de evento: `goal_created/goal_updated`, `task_created/task_updated`, `task_note_added` (`applyEvent` :114-181). Escrita com `flag:'wx'` (append-only, falha se existe — :77-79); id `evt-<base36 ts>-<8 hex>`; `actorLabel` = `SWARM_AGENT_NAME`.
- Enums: goal `active|completed|blocked|cancelled`; task `open|assigned|planning|building|review|done|blocked|cancelled` (:11-12).
- Task carrega `ownedFiles` (≤40), `acceptanceCriteria` (≤20), `dependsOn` (≤50), `notes` (últimas 20).
- CLI: `bs-swarm goal create|update`, `task create|update|list [--json] [--owner] [--goal]`, `state` (dump do reduce).
- **Seed**: o app planta `plan/events/0000000000000-seed-primary-goal.json` (`actorLabel:"BridgeSpace"`, goal `goal-primary` com o mission brief completo) antes de subir os agentes.

### 3.2 `bin/bs-mail.cjs` — mailbox inter-agente

- `send --to <Agente|@all|@operator> [--type message|status|escalation|worker_done|swarm_complete] --body "…"` (:49-107).
- **Transcript-first** (:88-94): escreve em `transcript/` ANTES das cópias de inbox — comentário explícito: se o processo morrer entre as escritas, mensagem inbox-only consumida sumiria da UI "permanentemente". `@all` expande via `agents.json`.
- **Nudge**: `nudges/<alvo>.txt` ← `"Message from <from>"` — o watcher do app vê o nudge e **acorda o pane do agente** (injeção no PTY).
- `check [--inject|--consume]` (:109-173): `--inject` imprime `--- BridgeSwarm Inbox ---` (formato para injeção no turno do agente via hook `UserPromptSubmit`, §1.1) e consome; sem flags, só lista.
- Mensagem: `{id:"<ms>-<8hex>", from, to, body, type, timestamp:<unix s>}`.

### 3.3 `bin/bs-notify.cjs` — status por agente

Escreve `status/<SWARM_AGENT_NAME>.json` = `{status,title,body,agent,timestamp}`; comentário (:34): "o swarm monitor cai para detecção de inatividade" se falhar. Status reais do extract: ambos `needs-input`.

### 3.4 Protocolo de orquestração (dos prompts gerados)

`prompt-Coordinator_1-*.md` e `prompt-Builder_1..4-*.md` revelam o protocolo completo — o app gera prompts por role com o mission brief embutido:

- **Timing**: "BridgeSpace lança você (e Scouts) PRIMEIRO. Builders sobem segundos depois, leem o board uma vez e esperam ser acordados" → prioridade #1 do Coordinator é decompor e distribuir **na primeira rodada**.
- **Decomposição**: cada task tem **owned files explícitos, sem sobreposição** (conflitos → `dependsOn`), acceptance criteria, tamanho ~5-15 min; camadas schema→backend→API→UI→testes; cross-cutting vira task "foundation".
- **Filas**: todos os tasks distribuídos round-robin **imediatamente**; "Builder ocioso com fila vazia é wall-clock desperdiçado — Builders auto-avançam pela fila".
- **Scope freeze**: "o breakdown original É a missão — nunca invente tasks"; melhorias vão para "Future work" no `swarm_complete`; done = acceptance criteria passando.
- **Ciclo de status**: `assigned → planning → building → review/done` via `bs-swarm task update --status … --note …`.
- **Escalonamento**: `worker_done` → Coordinator verifica e marca `review`→`done`; `escalation` → desbloqueio/reassign; Builder com 3º `CHANGES_REQUESTED` marca `blocked` em vez de loopar (máx. 2 rodadas de fix).
- **Operador humano**: inbox `@operator`; regra 9 — "toda resposta ao Operator DEVE usar `bs-mail send --to @operator` — output de terminal é invisível".
- **Anti-loop**: regra 10-12 — nunca reportar inbox vazia, nunca "social chatter", bodies ≤5 linhas, após `swarm_complete` parar de pollar e sair. "Inbox vazia + sem task = FIQUE IDLE; o BridgeSpace acorda você".
- **Encerramento**: Coordinator manda `swarm_complete` para `@all` **e** `@operator` (resumo, arquivos, validação, riscos) e sai.

**Evidência viva nos transcripts** (este swarm executou a engenharia reversa do próprio Bridge): fila de 2 tasks para Builder 1 (`transcript/1786046036653-….json`), reatribuição dinâmica F5 B1→B4 (`1786046530236`), `worker_done` de 1 linha de B4 (`1786046203055`), e uma **escalation sofisticada** de B2 reportando loop de notificação ("fui acordado 2x com redesignação de task já done… encerre meu agente ou mande swarm_complete", `1786047877690`) — mostra o modo de falha real: watcher acordando agente sem mensagem nova. O `SWARM_BOARD.md` final registra as 7 tasks DONE com log de trabalho auditável.

---

## 4. Arquivos de runtime e dados

| Arquivo | Formato | Função |
|---|---|---|
| `runtime.session` | 64 chars hex (sha256-like), sem newline | Token de runtime; comparado constant-time pelo MCP gate (§2.1). Rotacionado por sessão do app ("shell de sessão anterior → token mismatch"). |
| `bridgememory.active` | path absoluto (vazio no snapshot) | Hub ativo no painel BridgeMemory; lido via `BRIDGESPACE_ACTIVE_HUB_FILE` como fallback de descoberta. |
| `history.db` | SQLite WAL | 6 tabelas (schema em `schemas/history.db.schema.sql`): `commands` (command/cwd/shell/exit_code/duration/git_branch/session_id/**redacted_at** + índices parciais `WHERE redacted_at IS NULL`), `command_stats` (total/success/distinct_days/dismissed/decay — o "command refinery" de autocomplete), `denylist_patterns` (globs tipo `~/.ssh/**`), `agent_sessions` (session_id, native_session_id, **resume_command**, spawn_command, title, last_prompt, config_dir, transcript_path, pane_id), `meta`, `refinery_schema_history` (migrações refinery). |
| `app-support/…/session.alive.v1.json` | JSON heartbeat | `{pid, release:"bridgespace@3.4.18", last_heartbeat_at_ms, heartbeat_bucket:"alive.heartbeat:15min", last_meaningful_activity, diagnostics:{file_watcher_count, process_rss_bucket, terminal_count}, expected_exit}` — telemetria bucked, não valores brutos. |
| `mobile-bridge-config.json` | JSON | `{"binding":"loopback","port":47421}` — companion mobile só em loopback. |
| `BridgeMindOne/session.json` | JSON | Estado de panes/tabs do app irmão (`schemaVersion:1`). |

---

## 5. Portabilidade para o NexusIDE

Mapeamento para a arquitetura atual (`src/main/orch/`, `src/main/pty/`, renderer):

**P0 — copiar quase verbatim:**
1. **Drop-box de eventos com envelope canônico** (§1): hooks dos CLIs escrevem 1 arquivo JSON/evento em `~/.nexus/agent-hooks/global/` com tmp+rename; o main process faz `fs.watch` e roteia por `sessionId` (pane). Substitui parsing de saída de terminal para "needs-input/idle". Já temos spawn de CLI agents em `src/main/orch/` — falta o caminho de volta. **Cuidados**: não logar stdin bruto (erro do BridgeSpace, §1.1); manter o gate "só notifica se a sessão for nossa" (env injetada no PTY).
2. **Dois namespaces de sessão + `resume_command`**: pane id ≠ conversation id do CLI. Persistir `nativeSessionId`/`configDir`/`transcriptPath` por pane (tabela `agent_sessions` deles é o modelo) para recovery "retomar sessão" pós-crash.
3. **Shell integration via ZDOTDIR loader** (§1.3): OSC 133 + OSC 9;9 com loader que preserva o rc do usuário e gate fast-shell. Direto para `src/main/pty/` e para o histórico/autocomplete de comandos por cwd.

**P1 — adaptar:**
4. **Swarm = scope dir + event-sourced plan + mailbox transcript-first** (§3): o design inteiro é filesystem + watchers — portável 1:1 para um modo "missão" do NexusIDE. Pontos fortes: `bs-swarm` (reduce de eventos, owned files, dependsOn), transcript-first anti-perda, nudge+wake, prompts por role com scope-freeze e anti-loop (regras 10-12 — aprendidas na dor: a escalation de B2 mostra watcher acordando agente à toa; nosso watcher deve acordar **só com inbox não-vazia nova**). A surface IPC deles é 100% frontend; no Electron podemos fazer no main process com mais robustez (locks, single-writer).
5. **BridgeMemory MCP** (§2): 12 tools sobre `.md` com wikilinks — zero infra (sem índice, sem DB), gate por token de sessão com degradação graciosa, descoberta walk-up 64 níveis + fallback de hub ativo. Excelente candidato a MCP próprio (`nexusmemory`?) integrado ao painel do IDE — o grafo de wikilinks vira visualização nativa. Copiar também o SKILL.md editorial (política "só fatos duráveis").
6. **Runtime gate por token em arquivo** (`runtime.session`, comparação constant-time, erro acionável sem derrubar o servidor) — padrão para qualquer MCP privilegiado nosso.

**P2 — inspiração:**
7. `command_stats` com decay/dismiss/frecency (autocomplete que aprende e esquece) + redação dual-layer (`denylist_patterns` + `redacted_at` com índices parciais que **excluem** redigidos da busca).
8. `session.alive.v1.json` com diagnósticos em buckets (RSS "<500MB", contagens) — heartbeat de crash-reporting sem vazar valores.
9. Filtro de subagentes Codex por `session_meta` de rollout (§1.2) — relevante quando formos suportar subagentes sem spam de notificação.

---

## 6. Lacunas e observações

- `skills/`, `claude-hooks/global/`, `claude-hooks/scopes/`, `agent-hooks/global/` vazios no snapshot — drop-boxes são consumidas/limpas pelo app em runtime; o formato dos drop-files é reconstruído pelos writers (`bs-claude-hook.cjs:217-241`, `bs-agent-notify.cjs:495-515`).
- Como os watchers do app são frontend JS (assets Vite), detalhes de debounce/merge transcript+inbox estão fora do harness; o comentário transcript-first (`bs-mail.cjs:88-93`) é a melhor evidência do contrato.
- O token do runtime gate fica **em claro no env** dos configs MCP dos clientes (nota F2 do swarm) — aceitável para gate local, mas não é segredo forte.
- `history.db` não abriu read-only neste snapshot (WAL); schema citado via `schemas/history.db.schema.sql`.
