# Swarm Board — Swarm 1 — 2026-08-06

> Shared coordination hub. Read before starting. Update after completing.
> Structured UI state is authoritative: use `bs-swarm goal` and `bs-swarm task` commands for goals/tasks.

**Goal:** MISSÃO: Engenharia reversa do app BRIDGE (BridgeSpace/BridgeMind/BridgeMemory/BridgeBoard/BridgeVoice) — DE DENTRO PARA FORA — para entender COMO ele opera, pra portar mecânicas pro nosso produto. O Bridge é um app Tauri COMPILADO: NÃO há source. Vocês vão dissecar a partir dos artefatos legíveis.

WORKING FOLDER: /Users/cleofasrocha/.bridgespace  (artefatos legíveis do Bridge)
LEIAM TAMBÉM (caminhos absolutos):
- /Applications/BridgeSpace.app/Contents/Info.plist e Contents/MacOS/bridgespace-tauri (binário — use `strings`)
- /Applications/BridgeVoice.app
- ~/Library/Application Support/io.bridgemind.bridgespace/
- ~/Library/Logs/io.bridgemind.bridgespace/bridgespace-tauri.log

REGRAS (rígidas):
1. READ-ONLY sobre tudo do Bridge. Só ESCREVEM documentação em ./bridge-reverse-swarm/ (criem a pasta). Nada de editar binário, DB, configs ou código de qualquer app.
2. É app compilado: muita coisa é INFERÊNCIA de strings/binário/logs. Toda afirmação cita a fonte (arquivo:linha, ou `strings <bin>` + termo, ou schema SQL). Em dúvida, marquem "lacuna:".
3. Saída em PORTUGUÊS DO BRASIL.
4. Paráfraseiem mecânica/arquitetura — NUNCA reproduzam código proprietário verbatim do server.cjs ou dos binários.
5. Cuidado com dados sensíveis: NÃO exponham conteúdo de comandos/secrets do history.db — descrevam só estrutura/tipos.

FRENTES (cada agente assume UMA; escreve sua seção em ./bridge-reverse-swarm/<frente>.md citando fontes; marca lacunas):

F1 — App Tauri & superfície IPC: Info.plist (bundle id, schemes, ATS, capabilities); `strings` no bridgespace-tauri → plugins Tauri (clipboard/dialog/http/shell/notification/global-shortcut/updater/deep-link/single-instance/sentry), crates Rust (portable_pty, russh, refinery, ring/rustls, reqwest); comandos IPC invoke (terminal_*, record_agent_session, swarm*, bridgespace-mcp-proxy, mobile_bridge, bridge_agent_voice). Use o log p/ confirmar comportamento runtime.

F2 — BridgeMemory MCP: leiam server.cjs (22K linhas) e SKILL.md. Mapeiem: transporte (stdio), as ~12 tools (nome/params/efeito/linha), modelo de hub (.bridgememory/ + Markdown sem frontmatter, H1=título, [[wikilinks]]), descoberta walk-up + fallback, runtime gate (token constant-time), persistência/busca (full-scan por chamada, sem índice), graph ops (find_backlinks/list_orphans/suggest_connections).

F3 — Hooks & integração com agentes: bin/bs-claude-hook.cjs e bs-agent-notify.cjs (o que cada um faz por evento, qual canal usa p/ notificar a app); claude-hooks/global/*.json e agent-hooks/global/ (formato dos eventos); shell integration (OSC 133 + OSC 9;9 via override de ZDOTDIR preservando o .zshrc do usuário). Fluxo: hook dispara → drop-box JSON → app consome.

F4 — Modelo de dados & runtime: history.db (rode `sqlite3 .schema` — commands, agent_sessions, command_stats, denylist_patterns, meta, refinery_schema_history; descreva cada coluna semanticamente, NÃO valores); o "command refinery" (command_stats com decay/dismiss/success); redação dual-layer (denylist + redacted_at); runtime.session, bridgememory.active, App Support (session.alive.v1.json heartbeat, auth_credentials.enc + auth_storage.key, mobile-bridge, shell-integration).

F5 — Swarm / missões: `strings`/assets → swarmMailboxInit, swarmMailWatcher, swarmPlanWatcher, swarmScopeMigration, swarmSessionResume, spawnSwarmAgent; pane virtual (swarm-pane-*); vars injetadas (SWARM_AGENT_NAME, BRIDGESPACE_SWARM_SCOPE_ID); mission wizard (Working Folder + Mission Brief com @ + Context Files). Mecânica de orquestração entre agentes.

F6 — Linha de produtos & UI/UX: quem é quem (BridgeMind=marca, BridgeSpace=host, BridgeVoice=STT satélite, BridgeMemory=subsystem, BridgeBoard=workspace kanban, Mobile Bridge=companion); UI/UX conceitual (workspace types, pane, swarm, mission, context files); overlay JS próprio (__bridgeInspector/__bridgePicker/__bridge_modal, title-set hack, microinterações) — o "visual de luxo".

ENTREGÁVEIS:
- ./bridge-reverse-swarm/MAPA_DO_BRIDGE.md — documento-mestre consolidado, com sumário, índice, as 6 frentes, tudo citado.
- ./bridge-reverse-swarm/<frente>.md para F1–F6, cada um com (a) visão geral, (b) componentes mapeados com fonte, (c) padrões portáveis, (d) lacunas.

CHECKLIST DE CONCLUSÃO:
[ ] MAPA_DO_BRIDGE.md legível e completo.
[ ] 6 docs de frente com fonte em cada afirmação.
[ ] Toda afirmação cita fonte (arquivo:linha / strings+termo / schema); lacunas marcadas e listadas no topo do MAPA.
[ ] Lendo só o MAPA, alguém explica: o que cada subsistema do Bridge faz, como faz, onde, e o que vale portar.

COORDENAÇÃO: um agente INTEGRADOR consolida o MAPA no fim (resolve sobreposição, garante links). Os demais são DONOS de uma frente cada. Reportem progresso por frente.

---
📎 CONTEXT FILES — marque com @ no Step 1

SKILL.md
bin/bs-claude-hook.cjs
bin/bs-agent-notify.cjs

(server.cjs tem 22 K linhas — melhor os agentes lerem via ferramenta do que anexar inteiro; o Info.plist é binário/plist, também melhor via strings/leitura.)

🐝 SWARM (Step 2) — 7 agentes

┌───────────────┬────────┬──────────────────────────────────────────────────┐
│    Agente     │ Frente │                     Dono de                      │
├───────────────┼────────┼──────────────────────────────────────────────────┤
│ tauri-surface │ F1     │ Info.plist + strings binário + log               │
├───────────────┼────────┼──────────────────────────────────────────────────┤
│ mcp-auditor   │ F2     │ server.cjs + SKILL.md                            │
├───────────────┼────────┼──────────────────────────────────────────────────┤
│ hooks-auditor │ F3     │ bin/bs-*.cjs + claude-hooks/ + shell-integration │
├───────────────┼────────┼──────────────────────────────────────────────────┤
│ data-model    │ F4     │ history.db (sqlite3) + App Support               │
├───────────────┼────────┼──────────────────────────────────────────────────┤
│ swarm-auditor │ F5     │ assets swarm + vars + mission wizard             │
├───────────────┼────────┼──────────────────────────────────────────────────┤
│ product-ui    │ F6     │ linha de produtos + overlay JS + UI              │
├───────────────┼────────┼──────────────────────────────────────────────────┤
│ integrador    │ —      │ consolida MAPA_DO_BRIDGE.md                      │
└───────────────┴────────┴──────────────────

---

## Task Breakdown

> Coordinator: fill this table. Each task must list owned files — no overlaps between tasks.
> Status lifecycle: OPEN → ASSIGNED → PLANNING → BUILDING → REVIEW → DONE

> Pasta de saída (ÚNICO lugar onde se escreve): `/Users/cleofasrocha/bridge-reverse-swarm/`
> Tudo do Bridge é READ-ONLY. Toda afirmação cita fonte. Saída em pt-BR. Nada de código verbatim. Nada de valores do history.db.

| ID | Task | Owner | Owned Files | Depends On | Status |
|----|------|-------|-------------|------------|--------|
| task-mshxodn6-bd7ea16c | F1 — App Tauri & superfície IPC (Info.plist, strings do binário, plugins/crates, comandos invoke, log runtime) | Builder 1 | bridge-reverse-swarm/F1-tauri-ipc.md | — | **DONE** — review do Coordinator foi revertido: o símbolo existe (confirmado via `nm`, mangling Rust v0) |
| task-mshxodop-0039c9e5 | F2 — BridgeMemory MCP (server.cjs + SKILL.md: stdio, ~12 tools, hub, walk-up, gate, full-scan, graph ops) | Builder 2 | bridge-reverse-swarm/F2-bridgememory-mcp.md | — | **DONE** |
| task-mshxodqf-50b6788e | F3 — Hooks & integração com agentes (bs-claude-hook.cjs, bs-agent-notify.cjs, claude-hooks/, shell integration OSC) | Builder 3 | bridge-reverse-swarm/F3-hooks-agentes.md | — | **DONE** (verificado pelo Coordinator) |
| task-mshxods5-8ae13e44 | F4 — Modelo de dados & runtime (schema history.db, command refinery, redação dual-layer, App Support) | Builder 4 | bridge-reverse-swarm/F4-dados-runtime.md | — | **DONE** (verificado pelo Coordinator) |
| task-mshxodu9-c6de07ec | F5 — Swarm / missões (swarm* watchers, spawnSwarmAgent, pane virtual, vars injetadas, mission wizard) | **Builder 4** (reatribuída de B1) | bridge-reverse-swarm/F5-swarm-missoes.md | — | **DONE** (verificado pelo Coordinator) |
| task-mshxodw2-7745caf0 | F6 — Linha de produtos & UI/UX (quem-é-quem, workspace/pane/mission, overlay JS, title-set hack) | **Builder 4** (reatribuída de B3) | bridge-reverse-swarm/F6-produto-ui.md | — | **DONE** (verificado pelo Coordinator) |
| task-mshxodxz-eee85a77 | INTEGRADOR — consolida MAPA_DO_BRIDGE.md (sumário, lacunas no topo, índice, resumo das 6 frentes, portáveis priorizados) | **Builder 3** (reatribuída de B4) | bridge-reverse-swarm/MAPA_DO_BRIDGE.md | F1–F6 ✅ todas done | **DONE** (verificado pelo Coordinator) |

### ✅ Checklist de conclusão da missão

- [x] `MAPA_DO_BRIDGE.md` legível e completo — 426 linhas, 6/6 links relativos resolvem
- [x] 6 docs de frente com fonte em cada afirmação — F1 (516 l.) · F2 (457 l.) · F3 · F4 · F5 · F6
- [x] Toda afirmação cita fonte; **42 lacunas deduplicadas** listadas no topo do MAPA
- [x] Lendo só o MAPA dá pra explicar cada subsistema — estrutura "O que faz / Como opera / Onde vive / O que vale portar" por frente
- [x] Varredura de sensíveis limpa: 0 credenciais, 0 tokens, 0 fingerprints, 0 conteúdo de comando; 0 código verbatim
- [x] READ-ONLY preservado: nada do Bridge foi editado (`sqlite3 -readonly` no history.db em WAL)

---

## Coordinator 1

**Role:** coordinator
**Status:** ACTIVE
**Assigned Task:** orquestração + verificação de aceite
**Owned Files:** SWARM_BOARD.md
**Progress:**
- Criou `/Users/cleofasrocha/bridge-reverse-swarm/`; 7 tarefas criadas e distribuídas em fila pelos 4 Builders (B1: F1→F5 · B2: F2 · B3: F3→F6 · B4: F4→INTEGRADOR).
- INTEGRADOR fica BLOCKED até F1–F6 em done; Coordinator libera por bs-mail.

---

## Builder 1

**Role:** builder
**Status:** DONE
**Assigned Task:** task-mshxodn6-bd7ea16c — F1 App Tauri & superfície IPC (F5 foi reatribuída ao Builder 4)
**Owned Files:** bridge-reverse-swarm/F1-tauri-ipc.md
**Progress:**
F1 concluída. Superfície IPC extraída do manifesto ACL embutido no binário (`strings` linha 8646, capability única `trusted-main`): **177 comandos**, validados byte-a-byte (concatenação da lista == trecho do binário). Tauri 2.10.3 / runtime wry, 12 plugins com versão pinada, 200 crates com versão (portable-pty 0.8.1, russh 0.61, refinery 0.8.16, rusqlite 0.32.1, cpal, notify, minisign-verify, ml-kem). Layout de módulos Rust recuperado de paths de panic (`src/terminal/commands.rs`, `src/mobile_bridge.rs`, `src/history/redaction.rs`…). CSP + endpoints do updater (2 hosts, 1 chave minisign) + 25 env vars mapeadas. Comportamento confirmado no log runtime (renderer-recovery 176×, backpressure, restore).
**Achado que delimita F5:** zero símbolos/comandos `swarm*` no Rust → orquestração é 100% frontend (bate com o F5 do Builder 4).
**Observação fora de escopo (não corrigir, app é read-only):** o log JSONL tem escritas concorrentes sem lock — linhas entrelaçadas caractere a caractere, JSON corrompido.

---

## Builder 2

**Role:** builder
**Status:** DONE
**Assigned Task:** task-mshxodop-0039c9e5 — F2 BridgeMemory MCP
**Owned Files:** bridge-reverse-swarm/F2-bridgememory-mcp.md
**Progress:**
F2 concluída. Chave do achado: o bundle esbuild preservou os comentários de caminho de módulo, então o código próprio do Bridge isola-se em `server.cjs:21015-22013` (~999 linhas de 22.013 — o resto é zod + MCP SDK vendorizados). 12 tools mapeadas com params/efeito/linha. 190 citações; 74 verificadas programaticamente; 11 lacunas.

---

## Builder 3

**Role:** builder
**Status:** WAITING
**Assigned Task:** —
**Owned Files:** —
**Progress:**
<!-- Builder 3 updates here -->

---

## Builder 4

**Role:** builder
**Status:** F4+F5+F6 DONE; idle
**Assigned Task:** F4/F5/F6 done
**Owned Files:** F4-dados-runtime.md ; F5-swarm-missoes.md ; F6-produto-ui.md
**Progress:**
- F4 done (aprovada)
- F6 done (aprovada)
- F5 done (reatribuida do B1)


---

## Completed Work Log

| Task | Agent | Summary | Files Changed |
|------|-------|---------|---------------|
| F1 — App Tauri & superfície IPC | Builder 1 | Superfície IPC extraída do **manifesto ACL embutido no binário** (`strings` L8646, capability única `trusted-main`): **177 comandos invoke**, validados byte-a-byte (concatenação da lista == trecho do binário) e taxonomizados em 13 famílias. Tauri **2.10.3**/wry + 12 plugins com versão pinada + **200 crates com versão** (portable-pty 0.8.1, russh 0.61 + russh-sftp, refinery-core 0.8.16, rusqlite 0.32.1, ring/rustls, cpal/coreaudio, notify, minisign-verify, **ml-kem** = preparo pós-quântico). Layout de módulos Rust recuperado de paths de panic. CSP + updater (2 hosts / 1 chave minisign `18E33E88795A0725`) + protocolos `bsmedia:`/`asset:`/`ipc.localhost` + 25 env vars (incl. 5 kill-switches `DISABLE_*` + `SAFE_MODE`). Comportamento confirmado no log: `renderer-recovery` 176×, backpressure PTY→UI, terminal-restore com bucket. 13 padrões portáveis, 9 lacunas. **Delimita F5:** zero símbolo/comando `swarm*` no Rust → orquestração 100% frontend. | bridge-reverse-swarm/F1-tauri-ipc.md |
| **MAPA_DO_BRIDGE.md v1.1** | Builder 3 (integrador) | Documento-mestre: sumário executivo, **42 lacunas deduplicadas** (não somadas) com premissas refutadas separadas e 1 lacuna resolvida (`ssh_save_profile` = pool internado, não ACL), tabela de veredito das lacunas cruzadas de F2, **nota de método `[str]` vs `[sym]`**, as 6 frentes em formato "O que faz / Como opera / Onde vive / O que vale portar", e padrões portáveis priorizados P0→P2. | bridge-reverse-swarm/MAPA_DO_BRIDGE.md |
| F1 — App Tauri & superfície IPC | Builder 1 | Superfície IPC estabelecida como **fato, não inferência**: manifesto ACL embutido (capability única `trusted-main`) = 177 comandos em 13 famílias; Tauri 2.10.3/wry, 12 plugins pinados, ~200 crates com versão (portable-pty 0.8.1, russh 0.61, refinery 0.8.16, rusqlite 0.32.1, ml-kem pós-quântico). Módulos Rust recuperados de paths de panic. 12 lacunas. **Corrigiu o Coordinator** sobre `[str]` vs `[sym]` e fechou uma lacuna extra (pool de strings internadas em str:8104 ≠ comandos). | bridge-reverse-swarm/F1-tauri-ipc.md |
| F2 — BridgeMemory MCP | Builder 2 | Transporte stdio/NDJSON, 12 tools com params/efeito/linha, hub `.bridgememory` com H1=título e wikilinks, walk-up 64 níveis + fallback, gate constant-time que **degrada graciosamente**, busca full-scan por chamada (`index.json` não é índice), órfão = sem entrada nem saída resolvível. 11 lacunas, 190 citações, 74 auto-conferidas. **Achado:** esbuild preservou paths de módulo → código proprietário isolado em ~1k de 22k linhas. | bridge-reverse-swarm/F2-bridgememory-mcp.md |
| F5 — Swarm / missões | Builder 4 | Orquestração BridgeSwarm mapeada com **evidência viva** (o agente rodou dentro do próprio swarm): scope dir por missão, mailbox em filesystem com transcript-first + consume destrutivo + nudge, plano event-sourced append-only (`plan/events` → reduce), status file com fallback de inatividade, env injetado e spawn. 5 lacunas. **Derrubou premissa do enunciado:** `swarm-pane-*` não existe no binário (0 hits) — confirmado pelo Coordinator. | bridge-reverse-swarm/F5-swarm-missoes.md |
| F3 — Hooks & integração com agentes | Builder 3 | Dispatcher Claude + adaptador genérico normalizando eventos de CLIs num envelope canônico (`sessionId` do pane vs `nativeSessionId` retomável), drop-box atômica (tmp+rename, 1 arquivo/evento), gate por `BRIDGESPACE_SESSION_ID`, canal de swarm (mail transcript+inbox, status/<agente>.json) e OSC 133/9;9 com loader ZDOTDIR reversível. 6 lacunas. **Achado de privacidade:** o diagnóstico do hook grava `stdinRaw.slice(0,200)` — 200 chars do prompt bruto em log (`bs-claude-hook.cjs:197`); NÃO portar assim. Verificado pelo Coordinator. | bridge-reverse-swarm/F3-hooks-agentes.md |
| F6 — Linha de produtos & UI/UX | Builder 4 | Quem-é-quem dos 6 produtos com evidência (BridgeSpace v3.4.18 host, BridgeVoice v2.8.2 satélite STT, BridgeMemory subsystem com gate de assinatura, BridgeBoard = feature kanban e **não** app), UI conceitual (workspace/pane/browser sidebar/swarm/handoff/detached panels), overlay JS `__bridge_*` com tokens de estilo, title-set hack chunked como back-channel página→host. 5 lacunas. Verificado pelo Coordinator via plutil + strings. | bridge-reverse-swarm/F6-produto-ui.md |
| F4 — Modelo de dados & runtime | Builder 4 | Schema completo do history.db descrito semanticamente (6 tabelas), command refinery (decay/dismiss/prune/rebuild/frecency), redação dual-layer (denylist + `redacted_at` com índices parciais), runtime.session/bridgememory.active, App Support (heartbeat, auth, mobile-bridge, shell-integration). 8 lacunas marcadas. Verificado independentemente pelo Coordinator via `sqlite3 -readonly`. | bridge-reverse-swarm/F4-dados-runtime.md |
| F4 — Modelo de dados & runtime | Builder 4 | Schema history.db + refinery + runtime/App Support documentados | bridge-reverse-swarm/F4-dados-runtime.md |
| F6 — Linha de produtos & UI/UX | Builder 4 | Quem-é-quem + overlays JS + title-set + microinterações | bridge-reverse-swarm/F6-produto-ui.md |
| F5 — Swarm / missões | Builder 4 | Scope on-disk + mailbox + event plan + spawn/env | bridge-reverse-swarm/F5-swarm-missoes.md |
| F2 — BridgeMemory MCP | Builder 2 | Servidor MCP stdio (NDJSON), `bridgememory-mcp` v0.2.0. Código próprio isolado em `server.cjs:21015-22013` (~999 de 22.013 linhas; resto é zod+MCP SDK vendorizados) via comentários de módulo preservados pelo esbuild. Tabela das 12 tools (params/efeito/linha). Hub = `.bridgememory/` + Markdown sem frontmatter, H1=título, `[[wikilinks]]`; `index.json` é só metadado — **não** é índice de busca. Descoberta walk-up (teto 64 níveis) + fallback pelo arquivo de hub ativo, com `source` na resposta. Gate de token constant-time que **degrada graciosamente** (falha não derruba o processo: tools respondem erro acionável). Busca full-scan por chamada com scoring explicável (+5 título/+1 ocorrência com teto 5/+3 verbatim) e fallback all→any. Grafo derivado: órfão = sem entrada E sem saída resolvível (link quebrado não conta). 11 lacunas. Gate confirmado ao vivo via `hub_status`. **Nota de segurança:** o token de runtime fica em claro no `env` dos configs dos clientes — valor NÃO reproduzido no doc. | bridge-reverse-swarm/F2-bridgememory-mcp.md |
