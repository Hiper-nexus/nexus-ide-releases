# F4 — Orquestração (squads / missões / handoffs)

> Engenharia reversa do NexusIDE — frente F4. Data: 2026-08-06.
> **Âncora:** working tree de 2026-08-06 ~16:45, sobre `HEAD` da sessão (`254ddab4` no início do swarm; outra sessão commitou `bc2c7416`/`6dd48830` durante o trabalho). Todas as citações abaixo foram **re-conferidas contra o working tree** após esses commits — ver §5.
> **Escopo declarado:** `src/main/orch/` tem **288 módulos não-teste** (`ls -1 src/main/orch/*.ts | grep -v '\.test\.' | wc -l` = 288; total `.ts` incluindo testes = 559, medido 2026-08-06 ~16:55 — o número sobe enquanto outra sessão commita). **Não** use `grep -v test`: ele derruba 3 arquivos não-teste cujo nome contém a substring (`agent-attestation-gate.ts`, `agent-attestation-lookup.ts`, `guided-mission-planner-test-harness.ts`) e devolve 285. Este doc traça **um golden path** e cita **só** o que ele toca. Superfície não coberta está listada em §5 como lacuna, não silenciada.

---

## 0. Resumo (10 linhas)

1. Uma missão não nasce de um comando: nasce de uma **escada de autoridade** com 5 degraus IPC distintos — `arm → submitIntent → approveIntent → bootstrapOrchestrator → kickoffSubmit` (`src/shared/orch-channels.ts:32,34,36,41,52`).
2. O renderer **nunca** carrega autoridade. Ele manda `missionId` e o main lê todo campo de runtime dos próprios stores (`orch-channels.ts:38-41`).
3. A aprovação passa por **diálogo nativo do SO** e por uma *fence*: se qualquer coisa mudou enquanto o diálogo estava aberto, o approve morre com `approval_stale` (`orch-ipc.ts:2111-2118`).
4. O squad é um **preset zod-validado** (`src/shared/orch-types.ts:117-163`): até 32 agentes, cada um com `cli`, `category`, `effort`, `allowedSkills`, `allowedTools`, `persona`, `ownsPlanDocs`.
5. Persistência **por checkout**, não global: `<userData>/project-runtime/project-<hash>/checkout-<hash>/runtime.sqlite3` (`src/main/runtime/project-runtime-manager.ts:222`, base em `src/main/main.ts:436`).
6. O skill-gate é duplo e **assimétrico**: server-side é a autoridade (`gate.ts:122-140` + `mcp-dispatch.ts:637`), client-side é feedback (`hooks-gen.ts:91-110`). Só o server-side é confiável.
7. Três listas moldam o gate: `ALWAYS_ALLOWED` (5 tools), `REQUIRES_EXPLICIT_ALLOW` (7 tools de alto impacto) e `ORCHESTRATOR_DENIED_TOOLS` (13 tools de escrita) — `gate.ts:73-104`.
8. Handoff é **linha durável em SQLite** entregue no PTY do orquestrador **só quando ele fica idle** (`tools-handoff.ts:76-96` → `idle-delivery.ts:1057`).
9. `status` e `artifacts` do handoff são explicitamente **metadados não confiáveis**; só `evidenceIds` emitidos pelo próprio Nexus satisfazem o receipt (`tools-handoff.ts:77-83`, a frase exata em `:81`).
10. `docs/orchestration.md:54-55` está **desatualizado** no mesmo ponto que a auditoria de hooks — ver §3.6 e [F3](./F3-hooks-lifecycle.md).

---

## 1. Trace ponta-a-ponta

### Passo 0 — onde tudo é persistido

| # | Passo | Onde |
|---|---|---|
| 0.1 | Main aponta o `ProjectRuntimeManager` para `<userData>/project-runtime`. | `src/main/main.ts:436` |
| 0.2 | O diretório real é derivado por **digest** de `projectId` e `(projectId, checkoutId)` — nunca pelo caminho legível. | `src/main/runtime/project-runtime-manager.ts:206-216` |
| 0.3 | O banco da missão é `.../project-<projectKey>/checkout-<checkoutKey>/runtime.sqlite3`. | `project-runtime-manager.ts:222` (e `:454`) |
| 0.4 | Antes de abrir, valida que o arquivo é regular e **não é symlink** — senão `ProjectRuntimeFault('unsafe_storage')`. | `project-runtime-manager.ts:226-233` |

> **Consequência operacional:** não existe “o banco do Nexus”. Existe **um banco por checkout**. Depurar missão pelo `nexus.db` global é olhar o lugar errado — o mesmo projeto aberto em dois worktrees tem dois `runtime.sqlite3` independentes.

### Passo 1 — o preset de squad

| # | Passo | Onde |
|---|---|---|
| 1.1 | `agentCategorySchema` fixa as categorias: `orchestrator`, `scout`, `executor`, `reviewer` (+ demais). | `src/shared/orch-types.ts:25-31` |
| 1.2 | `squadAgentSchema` é um `z.preprocess` que **migra presets antigos**: agente sem `cli` recebe o mapeamento de `providerId`, com fallback `'claude'`. | `orch-types.ts:57-69` |
| 1.3 | Campos por agente: `id`, `agentName`, `category`, `cli`, `providerId?`, `model?`, `effort?` (string livre — nova capacidade de CLI não exige release do Nexus), `ownsPlanDocs?`, `allowedSkills` (null = irrestrito, máx 128), `allowedTools` (idem), `persona?`. | `orch-types.ts:70-113` |
| 1.4 | `squadSchema`: `id`, `name`, `createdAt` (aceita epoch-ms **ou** ISO, normalizado para string), `builtin`, `orchestratorInstructions` (≤ 64 KiB), `nativeInstructions?`, `runtimeSourceSquadId?` + `runtimeSourceSquadRevisionHash?` (sha256, **main-owned**), `agents[]` (máx 32). | `orch-types.ts:117-149` |
| 1.5 | `superRefine` rejeita `agent.id` duplicado dentro do squad. | `orch-types.ts:150-162` |
| 1.6 | Arquivo de squads: `{ squads: [...] }`, máx 64, ids únicos. | `orch-types.ts:167+` |
| 1.7 | Salvar/exportar/importar pelo IPC `orch:squads.save` / `.export` / `.import`. | `src/shared/orch-channels.ts:83,85,86` |

> `runtimeSourceSquadId` + `runtimeSourceSquadRevisionHash` são a **linhagem imutável** do snapshot de runtime: o renderer pode *pedir* um snapshot a partir de um squad-fonte, mas só o main valida e persiste esses dois campos (`orch-types.ts:136-140`).

### Passo 2 — armar, declarar intenção e aprovar

| # | Passo | Onde |
|---|---|---|
| 2.1 | `orch:missions.arm` cria a **casca** da missão sem pane de orquestrador (intent-first). | `orch-channels.ts:31-32`; handler `src/main/orch/orch-ipc.ts:2048` |
| 2.2 | `orch:missions.submitIntent` registra a intenção do operador. | `orch-channels.ts:34`; handler `orch-ipc.ts:2057` |
| 2.3 | `orch:missions.approveIntent` — o degrau caro. Valida payload por zod e exige um **workspace scope vivo** do renderer chamador. | `orch-ipc.ts:2075-2080` |
| 2.4 | Aquece o cache de auth de subscription **antes** da leitura de prontidão: um Keychain AGY frio leria como “precisa login” e reprovaria um roster saudável. | `orch-ipc.ts:2082-2085` |
| 2.5 | Monta o *candidate* de aprovação a partir do sender. | `orch-ipc.ts:2086-2089` |
| 2.6 | Consome o grant de revisão de plano do wizard — **single-use**, para um grant válido nunca autorizar dois approves. | `orch-ipc.ts:2093-2097` |
| 2.7 | Prepara a substituição exclusiva de orquestrador (um orquestrador por vez). | `orch-ipc.ts:2098-2101` |
| 2.8 | **Diálogo nativo do SO**. Sem `approvalReviewSha256` → `user_denied`. | `orch-ipc.ts:2102-2110` |
| 2.9 | **Fence:** recalcula o candidate e compara. Mudou intenção, anexos, squad ou runtime enquanto o modal estava aberto → `approval_stale`. | `orch-ipc.ts:2111-2118` |
| 2.10 | Aplica a substituição exclusiva com `expectedFence`, revalida o scope e só então grava a aprovação. | `orch-ipc.ts:2119-2131` |

> O scope vivo é revalidado **três vezes** no mesmo handler (`:2078`, `:2111`, `:2121`). Não é redundância: entre elas há um `await` de diálogo nativo, janela em que o renderer pode trocar de workspace ou morrer.

### Passo 3 — materializar o orquestrador

| # | Passo | Onde |
|---|---|---|
| 3.1 | `orch:missions.bootstrapOrchestrator` — o renderer manda **só** `missionId`; todo campo de runtime vem dos stores do main. | `orch-channels.ts:37-41`; handler `orch-ipc.ts:2134` |
| 3.2 | `bootstrapMissionOrchestratorForScope` cria o pane físico do orquestrador. | `src/main/orch/mission-orchestrator-bootstrap.ts:2470` |
| 3.3 | O spawn passa pelo hook de decoração do MCP: bearer por pane, `NEXUS_MCP_URL/TOKEN`, `NEXUS_GATE_URL/TOKEN`, `NEXUS_HOOK_URL`. | `src/main/orch/mcp-server.ts:707-716` (ver [F3 §1.C](./F3-hooks-lifecycle.md)) |
| 3.4 | Bootstrap travado tem caminho de retomada sancionado: `orch:missions.resumeBootstrap` e patches `blockedBootstrapResumePatch`. | `orch-channels.ts:42-43`; `mission-orchestrator-bootstrap.ts:2935` |
| 3.5 | Detecção de necessidade de recuperação e conferência de autoridade de runtime. | `mission-orchestrator-bootstrap.ts:551`, `:601` |

### Passo 4 — kickoff (o handshake que prova que o orquestrador acordou)

| # | Passo | Onde |
|---|---|---|
| 4.1 | `orch:missions.kickoffSubmit` recebe o pedido do renderer, validado por `rendererMissionKickoffRequestSchema`. | `orch-channels.ts:52`; schema `src/main/orch/mission-kickoff.ts:665` |
| 4.2 | O prompt canônico de kickoff é **construído pelo main**, não aceito do renderer. | `mission-kickoff.ts:712` (`buildCanonicalMissionKickoffPrompt`) |
| 4.3 | `runMissionKickoffAcceptance` roda a aceitação: espera o pane sair de idle e confirmar turno físico. | `mission-kickoff.ts:295` |
| 4.4 | Três janelas temporais nomeadas: `BOOT_IDLE_WINDOW_MS = 60_000`, `ACCEPTANCE_WINDOW_MS = 30_000`, `KICKOFF_PHYSICAL_TURN_CONFIRM_MS = 4_000`. | `mission-kickoff.ts:66`, `:81`, `:89` |
| 4.5 | Falha vira **enum fechado** (`MissionKickoffFailureReason`) + marcador, nunca prompt ou output do provider no receipt. | `mission-kickoff.ts:94`, `:111`, `:275` |
| 4.6 | Continuação exata: o kickoff sabe distinguir retomada legítima de re-spawn. | `mission-kickoff.ts:137`, `:168` (`hasExactMissionKickoffContinuation`) |

### Passo 5 — dispatch de task e criação do worker

| # | Passo | Onde |
|---|---|---|
| 5.1 | O plano selado vira fila durável na tabela **`task_dispatch_queue`**. | `src/main/orch/task-dispatch-claim-authority.ts:524` (INSERT), `:381` (SELECT) |
| 5.2 | `claimTaskDispatch(binding, input)` é a porta única de claim: valida `missionId`, `taskId`, `workerId`, `leaseOwner` e `intentVersion` por schema antes de tocar SQL. | `task-dispatch-claim-authority.ts:59-70` |
| 5.3 | O claim atualiza a linha com lease (`UPDATE task_dispatch_queue`). | `task-dispatch-claim-authority.ts:482` |
| 5.4 | Concorrência é limitada por cap efetivo + ladder adaptativo, com telemetria de schedule/conflito/violação. | `src/main/orch/mission-scheduler.ts:112`, `:333`, `:391`, `:463-492` |
| 5.5 | A onda de tasks é escolhida por conjunto pronto + disjunção de ownership. | `mission-scheduler.ts:521` (`computeReadySet`), `:668` (`selectDisjointWave`) |
| 5.6 | Criação de worktree é **serializada** — dois workers não criam worktree ao mesmo tempo. | `src/main/orch/mission-scheduler-dispatch-transaction.ts:81` |
| 5.7 | Falha de dispatch é persistida com motivo, e há classificação de erro retryable vs espera de capacidade. | `mission-scheduler-dispatch-transaction.ts:218`, `:120`, `:131` |

### Passo 6 — handoff

| # | Passo | Onde |
|---|---|---|
| 6.1 | O worker chama `nexus_handoff_submit({status, summary, artifacts?, evidenceIds?})`. Só `status` e `summary` são obrigatórios. | `src/main/orch/tools-handoff.ts:76`, schema `:84-96` |
| 6.2 | A própria descrição da tool declara o contrato de desconfiança: *“Status and artifacts are untrusted delivery metadata and never complete a mission. Only evidenceIds already issued and bound by Nexus can satisfy the worker stop receipt.”* | `tools-handoff.ts:77-83` (a frase “untrusted delivery metadata” em `:81`) |
| 6.3 | O handler exige um **receipt de efeito físico** da invocação MCP antes de qualquer coisa. | `tools-handoff.ts:98` (`requireHandoffMcpEffectIntent`) |
| 6.4 | Falha ao ler a autoridade da missão **nega** (não degrada): `handoff_origin: mission authority unavailable`. | `tools-handoff.ts:106-109` |
| 6.5 | Sem missão atual com contrato de dispatch aprovado → `handoff_origin: current approved mission unavailable`. | `tools-handoff.ts:110-112` |
| 6.6 | Hash do payload bruto + estado de intenção efetivo (contagem de tasks e de panes worker) alimentam `canSubmitMissionHandoff`. | `tools-handoff.ts:113-126` |
| 6.7 | A tool é sempre permitida, independentemente de allowlist — `handoff_submit` está em `ALWAYS_ALLOWED`. | `src/main/orch/gate.ts:73-79` |
| 6.8 | Submetido, o handoff entra na entrega ociosa: `onHandoffSubmitted`. | `src/main/orch/idle-delivery.ts:1057` |
| 6.9 | A entrega acontece no PTY do orquestrador **quando ele fica idle**, nunca no meio de uma resposta. Pendências são reentregues por `redeliverPendingHandoffs`. | `idle-delivery.ts:1089`; init em `:887` |
| 6.10 | Existe também o caminho legado por stream do PTY: `### NEXUS_HANDOFF v1` parseado com ANSI-strip. | `src/main/orch/pty-stream-handoff.ts:88`, `:362-407` |
| 6.11 | O orquestrador confirma com `nexus_handoff_ack`; há ainda `nexus_worker_heartbeat`. As 4 tools do grupo são montadas em `buildHandoffTools`. | `tools-handoff.ts:430-437` |

### Passo 7 — seal / completar

| # | Passo | Onde |
|---|---|---|
| 7.1 | `completeMissionFromVerifiedTaskPlan` é a porta de conclusão. | `src/main/orch/task-dispatch-mission-completion-authority.ts:924-936` |
| 7.2 | Ela **não conclui**: delega a `verifyCompletedTaskPlanAuthority` e só emite mudança se a verificação passar. | `task-dispatch-mission-completion-authority.ts:928-934` |
| 7.3 | Chamada única a partir do store de dispatch. | `src/main/orch/task-dispatch-store.ts:1239` |
| 7.4 | O prompt do orquestrador nomeia explicitamente o que a conclusão exige: worker atual, handoff `success` com evidência confiável e handoff aceito para a sessão atual do orquestrador — `status=done` direto é recusado. | `src/main/orch/tools-domain.ts:409-411` |
| 7.5 | Invariantes nomeados no mesmo lugar: `task_plan_immutable` e `task_dispatcher_authority`. | `tools-domain.ts:905` e `:830` |

---

## 2. Inventário

| Componente | Arquivo:linha | Responsabilidade |
|---|---|---|
| Canais IPC de orquestração | `src/shared/orch-channels.ts:19-111` | Nomes livres de dependência (squads/missões/handoffs/todos/panes/MCP info). |
| Registro dos handlers | `src/main/orch/orch-ipc.ts:1844-2134+` | `ipcMain.handle`/`.on` de toda a superfície. |
| Broadcast de mudança | `orch-ipc.ts:1566-1583`, `:1700` | `missionsChanged`, `handoffsChanged`, `todosChanged`, `squadsChanged`. |
| Schema do squad | `src/shared/orch-types.ts:25-170` | zod: categorias, agente, squad, arquivo de squads. |
| Runtime por checkout | `src/main/runtime/project-runtime-manager.ts:206-233` | Diretório por digest + `runtime.sqlite3` + guarda anti-symlink. |
| Aprovação com fence | `orch-ipc.ts:2075-2131` | Diálogo nativo + fence + substituição exclusiva. |
| Bootstrap do orquestrador | `src/main/orch/mission-orchestrator-bootstrap.ts:2470`, `:2588`, `:2824` | Criar / parar antes de promoção de plano / reiniciar depois. |
| Kickoff | `src/main/orch/mission-kickoff.ts:66-89`, `:295`, `:712` | Janelas, aceitação, prompt canônico main-owned. |
| Claim de dispatch | `src/main/orch/task-dispatch-claim-authority.ts:59` | Única porta de claim sobre `task_dispatch_queue`. |
| Scheduler | `src/main/orch/mission-scheduler.ts:112-668` | Cap, ladder adaptativo, ready set, onda disjunta, telemetria. |
| Transação de dispatch | `src/main/orch/mission-scheduler-dispatch-transaction.ts:81-218` | Worktree serializado, classificação de erro, persistência de falha. |
| Tools de handoff | `src/main/orch/tools-handoff.ts:76-437` | `submit`, `list`, `ack`, `worker_heartbeat`. |
| Entrega ociosa | `src/main/orch/idle-delivery.ts:887-1089` | Fila por autoridade, entrega no idle, reentrega de pendentes. |
| Parser legado de stream | `src/main/orch/pty-stream-handoff.ts:88`, `:362-407` | `### NEXUS_HANDOFF v1` com ANSI-strip. |
| Autoridade de conclusão | `src/main/orch/task-dispatch-mission-completion-authority.ts:924` | Conclusão só com plano de task verificado. |
| Gate (allowlists) | `src/main/orch/gate.ts:73-179` | 3 conjuntos + `canonicalToolName` + role boundary. |
| Dispatch MCP | `src/main/orch/mcp-dispatch.ts:637`, `:675` | Enforcement server-side por role e por read-only. |
| Toolset | `src/main/orch/tools.ts:38-58+` | Composição de ~20 famílias de tools. |
| Tools de preview/browser | `src/main/orch/tools-browser.ts:60`, `:211-241` | `preview_start/stop` + 10 tools `nexus_browser_*`. |
| Journal de eventos | `src/main/orch/mission-event-journal.ts` | Append-only com cursor/ACK — ver [`../../MISSION-EVENTS.md`](../../MISSION-EVENTS.md). |

### 2.A — Skill-gate duplo (as três listas)

| Lista | Conteúdo | Arquivo:linha | Semântica |
|---|---|---|---|
| `ALWAYS_ALLOWED` | `handoff_submit`, `handoff_list`, `handoff_ack`, `worker_heartbeat`, `toolsearch` | `gate.ts:73-79` | Passam **independente** de qualquer allowlist. Sem isso um worker gated não teria como entregar. |
| `REQUIRES_EXPLICIT_ALLOW` | `remote_spawn`, `remote_cli_detect`, `remote_tmux_list`, `remote_bridge_status`, `agent_spec_write`, `catalog_install`, `cron` | `gate.ts:88-96` | **Inverte o default.** `allowedTools: null` significa “irrestrito” para tools comuns, mas estas exigem grant nominal — um agente prompt-injetado não as herda. |
| `ORCHESTRATOR_DENIED_TOOLS` | 13 tools de escrita (`file_write`, `editor_*`, `git_add/commit/push/pull/branch_*`, `terminal_kill`, `image/video/audio_generate`) | `gate.ts:98-104` | Fronteira de papel: o orquestrador coordena, não implementa. Exceção nominal: `image_generate` com `petStudioMediaAuthority` (`gate.ts:151-155`). |
| `ORCHESTRATOR_DENIED_NATIVE_TOOLS` | `task`, `bash`, `edit`, `write`, `notebookedit` | `gate.ts:106-108` | Mesma fronteira aplicada às tools **nativas da CLI**, vistas pelos hooks. |

**As duas metades:**

1. **Server-side (autoridade real).** `mcp-dispatch.ts:637` chama `isToolAllowedForRole(role, ctx.allowedTools, …)`; `:675` aplica `isToolAllowedForReadOnlyContext`. Roda no processo main, sobre o bearer do pane. **Nada contorna.**
2. **Client-side (feedback).** O hook `pretool` consulta `POST /gate/pretool` e faz `exit 2` (`hooks-gen.ts:104` → `mcp-server.ts:402-449`). Serve para o agente **ver** a recusa dentro da CLI, e só existe em HOME efêmero. Detalhe completo em [F3 §1.C](./F3-hooks-lifecycle.md).

`canonicalToolName` normaliza o namespace: `nexus_pane_spawn` ≡ `pane_spawn` (`gate.ts:113-119`). `isHookToolAllowed` ainda desembrulha o prefixo `mcp__nexus__` que os hooks do Claude usam (`gate.ts:173-177`).

### 2.B — Tools de preview e browser com screenshot

| Tool | Arquivo:linha | Efeito |
|---|---|---|
| `nexus_preview_start` / `nexus_preview_stop` | `tools-browser.ts:60` (+ par) | Sobe/derruba o preview do workspace. |
| `nexus_browser_open` / `navigate` / `read` / `inspect` | `tools-browser.ts` (grupo) | Abre e lê um pane de browser **de propriedade** do agente. |
| `nexus_browser_click` / `fill` / `hover` / `press` / `scroll` / `wait` | `tools-browser.ts` (grupo) | Interação. |
| **`nexus_browser_screenshot`** | `tools-browser.ts:211-241` | Captura PNG **com metadados de URL redigidos** (`:212`). |

O caminho do screenshot é o mais instrutivo do grupo:

1. `authorizeBrowserPane(ctx, paneId, 'read')` — o agente precisa **possuir** o pane (`:220`).
2. `assertReviewSurfaceCurrent(ctx, reviewAuthority)` **antes** da captura (`:221`).
3. Captura com `signal` de abort e `assertCurrentAuthority` propagados da invocação (`:222-230`) — autoridade revogada no meio aborta.
4. `assertReviewSurfaceCurrent` **de novo depois** da captura (`:232`).
5. Se a URL capturada não bate com a superfície de review, **lança**: *“automated design-review screenshot came from another URL”* (`:233-237`).
6. Só então registra a inspeção no review automatizado (`:238`).

Ou seja: o screenshot não é “tirar foto”, é **prova ligada a uma superfície de review específica**, com verificação antes e depois.

---

## 3. Não-óbvio / armadilhas

### 3.1 — `<userData>/project-runtime` é o único lugar que importa para depurar missão

O banco vive em `<userData>/project-runtime/project-<digest>/checkout-<digest>/runtime.sqlite3` (`project-runtime-manager.ts:206-222`). Os nomes são **digests**, não caminhos legíveis: não dá para achar por `ls` sem calcular o hash. Em dev, `userData` é o `.dev-user-data` do worktree, não `~/Library/Application Support/NexusIDE` — abrir o banco errado é o erro clássico de investigação. Consultar `task_dispatch_queue.last_error` no banco errado devolve “nada”, o que parece “sem erro”.

### 3.2 — A fence de aprovação é uma janela real, não paranoia

Entre `:2102` (abre o diálogo nativo) e `:2110` (retorno) há um `await` de duração humana. Nesse intervalo o operador pode trocar de squad no wizard, anexar arquivo ou o renderer pode morrer. Por isso o candidate é **recalculado** e comparado por fence (`orch-ipc.ts:2111-2118`), e o workspace scope é revalidado três vezes. Uma implementação ingênua (validar uma vez, abrir modal, aplicar) autorizaria um squad diferente do que o operador viu.

### 3.3 — `effort` é string livre por decisão explícita

`effort` é `z.string().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/)` e **não** um enum (`orch-types.ts:80-86`). O comentário no código dá o motivo: *“CLI-owned capability: new levels (for example Codex `ultra`) must not require a Nexus release.”* A validação real acontece no spawn, contra o adapter. Quem procurar a lista de valores válidos no schema não vai achar — ela não existe ali de propósito.

### 3.4 — `allowedTools: null` **não** significa “tudo”

É a armadilha semântica mais perigosa do gate. `null` significa “irrestrito **para tools comuns**”. As 7 tools de `REQUIRES_EXPLICIT_ALLOW` continuam negadas (`gate.ts:128-135`), porque alcançam fora do sandbox: SSH para host arbitrário, mutação de `~/.claude/agents`, abertura da ponte de rede, instalação de catálogo, cron. Um agente com prompt injetado e allowlist default **não** as herda.

### 3.5 — `status: 'success'` no handoff não conclui nada

A descrição da tool diz literalmente que `status` e `artifacts` são *untrusted delivery metadata* (`tools-handoff.ts:81`; a descrição completa em `:77-83`). A conclusão exige `evidenceIds` já emitidos e ligados pelo Nexus. O prompt do orquestrador repete a exigência em outras palavras (`tools-domain.ts:409-411`): worker atual + handoff de sucesso com evidência confiável e atual + handoff aceito para a sessão atual do orquestrador; `status=done` direto é recusado. Um worker “bem-intencionado” que escreve um resumo bonito e declara sucesso não move a missão.

### 3.6 — `docs/orchestration.md` está desatualizado no Stop-gate

`docs/orchestration.md:52-55` afirma: *“workers gated recebem `$HOME` efêmero … com hooks Claude (PreToolUse/PostToolUse/Stop) que consultam `POST /gate/*`. **O Stop-gate bloqueia a saída sem handoff (máx. 3 tentativas)**.”*

As três primeiras afirmações conferem (`hooks-gen.ts:296-320`). A última **não**: o commit `5ac0fd58` (2026-08-06) tornou o `stop` desacoplado e fail-open (`hooks-gen.ts:69-90`). A política das 3 tentativas continua existindo em `gate.ts:630`, mas o veredito não chega ao cliente. Análise completa em [F3 §3.4](./F3-hooks-lifecycle.md). O mesmo doc também diz “24 tools” (`docs/orchestration.md:4,24`) enquanto `buildToolset` compõe ~20 famílias (`tools.ts:38-58+`) — o smoke empacotado de 2026-08-04 já reportava **142 tools** ([`../2026-08-04-analise-profunda-orquestracao-panes.md`](../2026-08-04-analise-profunda-orquestracao-panes.md):29).

### 3.7 — A entrega de handoff tem um bug documentado com nome e linha

[`../2026-08-04-analise-profunda-orquestracao-panes.md`](../2026-08-04-analise-profunda-orquestracao-panes.md) §2 (F2) descreve `flushQueue` dropando filas em silêncio quando duas autoridades compartilham `sessionId` após rebind. A própria auditoria marca o item como **feito** em §0 e §5. Não re-verifiquei a correção linha a linha — ver lacuna em §5.

### 3.8 — Criação de worktree é o gargalo serializado

`runWorktreeCreateSerialized` (`mission-scheduler-dispatch-transaction.ts:81`) força ordem estrita na criação de worktrees. Quem observar “5 workers aprovados, 1 nascendo por vez” está vendo o design, não um travamento. Isso interage com o `effectiveConcurrencyCap` (`mission-scheduler.ts:112`) e o ladder adaptativo (`:391`): o cap nominal não é o paralelismo observado.

### 3.9 — `.context/` é política, não runtime de missão

`.context/` na raiz tem `config/`, `docs/` e `nexus/` (com `policy.json`, `sensors.json`, `invariants/`, `sensors/`, `attestations/`). É a superfície de **política e atestação**, não o estado das missões — esse vive no `runtime.sqlite3` (§1 passo 0). Confundir os dois leva a procurar missão em arquivo.

### 3.10 — Alvo móvel durante esta auditoria

Outra sessão commitou em `main` **enquanto** este documento era escrito: `bc2c7416` (16:30) tocou `src/main/orch/mcp-server.ts` e `6dd48830` (16:25) tocou `src/main/main.ts`; o working tree seguia sujo em `mcp-consent-policy.ts`, `mission-event-emit.ts`, `tools-domain.ts` e `mission-intent-projection.ts`. Todas as citações deste doc foram re-conferidas por `sed` **após** esses commits. Quem reler daqui a semanas deve reancorar antes de confiar nos números.

---

## 4. Essencial vs incidental

**Essencial:**

- A escada de 5 degraus IPC (`orch-channels.ts:32,34,36,41,52`). Colapsá-la em “criar missão” destrói a separação entre intenção declarada e autoridade concedida.
- A fence de aprovação (`orch-ipc.ts:2111-2118`) — sem ela, o approve autoriza algo que o operador não viu.
- `bootstrapOrchestrator` receber **só** `missionId` (`orch-channels.ts:38-41`): é o que mantém a autoridade fora do renderer.
- As três listas do gate (`gate.ts:73-104`), em particular a inversão de default de `REQUIRES_EXPLICIT_ALLOW`.
- `ALWAYS_ALLOWED` conter `handoff_submit` (`gate.ts:74`): sem isso um worker gated não teria como entregar e a missão travaria por construção.
- A desconfiança declarada de `status`/`artifacts` + exigência de `evidenceIds` (`tools-handoff.ts:77-83`) — é o que separa “o agente disse que terminou” de “terminou”.
- Entrega de handoff **só no idle** (`idle-delivery.ts:1057`, `:1089`): injetar no meio de uma resposta corrompe o turno do orquestrador.
- `claimTaskDispatch` como porta única sobre `task_dispatch_queue` (`task-dispatch-claim-authority.ts:59`).
- Persistência por checkout + guarda anti-symlink (`project-runtime-manager.ts:206-233`).
- A dupla verificação de superfície no screenshot (`tools-browser.ts:221` e `:232`) — sem ela, um screenshot de outra URL viraria evidência de review.

**Incidental:**

- O `z.preprocess` de migração de `providerId → cli` (`orch-types.ts:57-69`): compatibilidade com presets antigos, descartável quando não houver mais nenhum.
- `createdAt` aceitar epoch-ms **ou** ISO (`orch-types.ts:121-124`): concessão a exports históricos.
- O parser legado `### NEXUS_HANDOFF v1` (`pty-stream-handoff.ts:362-407`): caminho de compatibilidade para CLI sem MCP; o caminho canônico é a tool.
- `nativeInstructions` (`orch-types.ts:131-134`): preservado “as-is”, sem semântica no motor.
- Os limites numéricos (32 agentes, 64 squads, 128 skills/tools, 64 KiB de instruções): defensivos e ajustáveis, não estruturais.
- Telemetria de schedule/conflito/violação (`mission-scheduler.ts:463-492`): observabilidade, não autoridade.

---

## 5. Lacunas

- lacuna: **cobertura declarada.** `src/main/orch/` tem 288 módulos não-teste (medido 2026-08-06 ~16:55); este doc cita ~20. Ficaram fora, entre outros: PREVC e `mission-drive*`, `mission-degradation`, `mission-freeze-authority`, `mission-event-*` (além do contrato já documentado em `MISSION-EVENTS.md`), `plan-promotion-authority`, `worker-handoff-{contract,enforcement,ttl}`, `handoff-delivery-{outbox,policy,runtime-recovery}`, `final-validation-handoff`, `mission-operator-reply`, `route-*`, `catalog*`, `skill-mirror`, `context/*`. Cada um merece uma frente própria.
- lacuna: não li `verifyCompletedTaskPlanAuthority` (chamada em `task-dispatch-mission-completion-authority.ts:928`). **É a função que realmente decide se uma missão termina** — o que documentei é o wrapper. Sem ela, a afirmação “conclusão exige receipt verificável” está apoiada na descrição da tool e no prompt do orquestrador, não no verificador.
- lacuna: não tracei quem chama `claimTaskDispatch` — ou seja, **onde o worker físico é efetivamente spawnado** a partir do claim. O elo `claim → spawn de PTY do worker` está inferido pelo nome dos módulos, não lido.
- lacuna: `server/` (com `drizzle/`, `Dockerfile.relay`, `dist-relay/`) não foi aberto. O briefing o lista em F4, mas o golden path de missão que tracei é **inteiramente main-process + SQLite local**. Falta determinar se `server/` participa da orquestração de missão ou é só o relay remoto/OMP.
- lacuna: `.context/nexus/{policy.json,sensors.json,invariants/,sensors/,attestations/}` foram listados mas não lidos. Não sei quais invariantes são carregados em runtime nem por qual módulo.
- lacuna: não verifiquei se a correção do bug F2 de `idle-delivery.ts:825-845` (drop mudo de fila em multi-match) está de fato no working tree — a auditoria de 2026-08-04 marca como feito, e eu confiei nela em §3.7.
- lacuna: não contei as tools reais de `buildToolset()`. `docs/orchestration.md` diz 24, o smoke de 2026-08-04 diz 142, e `tools.ts:38-58+` compõe ~20 famílias. O número correto exige executar o build.
- lacuna: `nexus_handoff_ack` e `nexus_worker_heartbeat` foram identificados em `tools-handoff.ts:430-437` mas não li seus handlers. O ACK é o que fecha o ciclo de entrega — documentei que existe, não como decide.
- lacuna: a interação entre `effectiveConcurrencyCap`, o ladder adaptativo e `runWorktreeCreateSerialized` não foi medida. Não sei qual é o paralelismo real observado com N tasks prontas. Contexto relacionado na memória do projeto: paralelismo real segue pendente por ownership não-disjunto no plano guiado.
- lacuna: o schema real das tabelas (`task_dispatch_queue`, `handoffs`, `mission_events`) foi lido só por fragmentos de SQL nos módulos. Não abri as migrações em `src/main/persistence/` nem um banco real.

---

## 6. Auditorias relacionadas

- [`../2026-07-23-golden-path-orch.md`](../2026-07-23-golden-path-orch.md) — o fechamento sênior que nomeia os invariantes deste caminho (`route_task` com reserva durável, selagem main-owned de roster/plano/ownership/worktree/incarnation, kickoff e handoff com prova observável, revogação imediata do bearer no encerramento). **Ainda válido como contrato**; o que mudou desde então está em §3.6.
- [`../2026-08-04-analise-profunda-orquestracao-panes.md`](../2026-08-04-analise-profunda-orquestracao-panes.md) — bugs F1/F2/F3 (lock leak, drop mudo de fila, colisão de scope identity), todos marcados como corrigidos em §0; dívidas estruturais abertas (~23-25 gates pré-PTY, `node_modules` compartilhado). Fonte do número de 142 tools no smoke empacotado.
- [`../2026-08-02-deadlock-handoff-ack.md`](../2026-08-02-deadlock-handoff-ack.md) — o deadlock `queued↔idle` resolvido por pull-ACK, citado como prova em `2026-08-04:124`. *(não lido nesta frente — referência de superfície)*
- [`./F3-hooks-lifecycle.md`](./F3-hooks-lifecycle.md) — a metade client-side do skill-gate e o estado real do Stop-hook.
- [`../../MISSION-EVENTS.md`](../../MISSION-EVENTS.md) — contrato do journal append-only (cursor, ACK, idempotência, `ScopedStoreCorruptionError` fail-closed). **Confere** com a existência de `src/main/orch/mission-event-journal.ts` e dos canais `orch:missionEvents.*` (`orch-channels.ts:70-73`).
- [`../../orchestration.md`](../../orchestration.md) — visão de produto da Fase 2d. **Desatualizado em 2 pontos verificados** (§3.6): o Stop-gate bloqueante (`:54-55`) e a contagem de 24 tools (`:4`, `:24`).
- [`../../SKILLS.md`](../../SKILLS.md) — *(não lido nesta frente; o vocabulário de skill deste doc vem de `allowedSkills` em `orch-types.ts:107-112` e de `isSkillAllowed` em `mcp-server.ts:411-415`)*.
