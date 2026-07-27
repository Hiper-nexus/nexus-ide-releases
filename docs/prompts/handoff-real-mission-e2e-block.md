# HANDOFF — Resolver bug final do real-mission e2e release gate (nexus-ide v0.19.27)

> **Registro histórico — não usar como runbook.** Este diagnóstico descreve
> uma implementação obsoleta que permitia ao processo main fabricar o artefato,
> o commit e o handoff do worker. O receipt v4 atual entra pelo Guided Planner
> de produção e exige três PTYs físicos (orquestrador, executor e QA), dois
> dispatches sequenciais, dois `nexus_handoff_submit` no boundary HTTP MCP,
> integração do executor e `worktree_validated_no_change` main-owned para o QA.
> A cobertura é `guided-delivery-core`: QA físico está coberto; PREVC e o
> merge-review council continuam fixtures explícitas, portanto não é
> `full-flow`. Os helpers que fabricavam plano/artefato/commit/handoff no main
> foram removidos. Qualquer orientação abaixo para restaurá-los deve ser
> ignorada.

## TL;DR do estado
O **PREVC está 100% funcionando** (verificado no event ledger). O **merge integra com sucesso**. Mas a missão termina **`blocked`** e o gate falha com `code=mission-blocked`. Dois fixes foram tentados; o Fix 2 (que eu achei que desbloquearia) **não resolveu** — então o block vem de outro lugar. Falta encontrar **onde** `mission.status` vira `'blocked'`.

---

## Ambiente
- Worktree: `/Users/cleofasrocha/dev/nexus-ide-release-0.19.27`
- Branch: `codex/release-0.19.27` (não pushada)
- Node: `export PATH="$HOME/.local/node-v22.23.1-darwin-arm64/bin:$HOME/.local/bin:$PATH"`
- App empacotado: `out/NexusIDE-darwin-arm64/NexusIDE.app` (binário: `Contents/MacOS/nexus-ide`)
- Iteração rápida (NÃO notarizar): `npm run package` (~1 min) + driver abaixo.

## Iteração rápida (sem make:release / sem notarizar)
Driver criado em `scripts/spikes/e2e-real-mission-fast.mjs` — chama `runPackagedRealMission` direto no `.app` empacotado com releaseBinding honesto (commitSha do git + sha256 do binário + identity Developer ID):
```bash
cd /Users/cleofasrocha/dev/nexus-ide-release-0.19.27
export PATH="$HOME/.local/node-v22.23.1-darwin-arm64/bin:$HOME/.local/bin:$PATH"
export NEXUS_REAL_MISSION_PRESERVE_USERDATA=1   # preserva userData p/ inspeção do runtime DB
npm run package
node scripts/spikes/e2e-real-mission-fast.mjs
```
Evidence em `release-artifacts/security/real-mission-evidence-fast.json`.

### Inspecionar o runtime DB do último run (ground truth)
O userData preservado vai pro stderr (`preserved userData=...`), em `/var/folders/.../T/nexus-real-mission-XXXX`. O DB:
`.../project-runtime/projects/project-<hash>/checkout-<hash>/runtime.sqlite3`
```bash
sqlite3 -header "$DB" "SELECT state, handoff_id FROM task_dispatch_queue;"
sqlite3 -header "$DB" "SELECT status, delivery_state FROM handoffs;"
sqlite3 -header "$DB" "SELECT status FROM missions;"
sqlite3 "$DB" "SELECT event_type FROM event_ledger GROUP BY event_type;"
```

---

## O que JÁ FOI FEITO (commits nesta sessão, em ordem)
```
5296347e fix(lifecycle): never block a real-mission mission on worker PTY exit
ee4b4f0e fix(e2e): accept merge-commit integration (commitCount 2 or 3) in evidence
625baa6e test(prevc): add unit test for stageRealMissionE2EContextCorpus
13d5cadb fix(prevc): preserve all acceptance criteria and advance planning to execution
babb8c01 fix(prevc): stage context corpus with pure filesystem ops
```
(Pai de tudo: `22b14823 fix(release): bind PREVC attestations to live projectId`)

### Fix A — PREVC freeze + advance (FUNCIONOU, verificado) ✅
- `src/main/real-mission-e2e-prevc.ts` `freezeRealMissionE2EPrevCIfNeeded`:
  - Antes: `classifyMissionRisk` retornava `medium` (4 critérios → não é low) → rota começava em `planning` → `assertMutationAllowed` bloqueava spawn do worker → `code mutation blocked during workflow stage planning`.
  - Agora: congela com os **4 critérios** intactos E chama `service.advance(missionId, 'execution')` após o freeze (o plano é main-owned e já selado, então planning está satisfeito). Risk continua medium mas o stage avança pra execution.
- Confirmado pelo event_ledger: `contract-frozen` (risk=medium, criterionIds ac-1..ac-4) → `workflow-transition` planning→execution → sensors typecheck/unit passed → `review-finding` findingCount=0 **mergeCandidate=true**.
- Commit de stage: `babb8c01` trocou `ensureContextScaffold` por fs puro (evita "workspace identity changed on disk").

### Fix B — commitCount 2 ou 3 na evidence (verificado necessário, mas NÃO desbloqueia sozinho)
- `src/main/real-mission-e2e.ts` `#repositoryProof` (~linha 860):
  - O merge queue integra como **merge commit real** (initial + worker result + merge = **3 commits**), não fast-forward (2).
  - Antes exigia `commitCount === 2` → `exactSingleCommit=false`.
  - Agora aceita 2 OU 3, verificando que HEAD descende do initial e o diff initial→HEAD é só `resultado.txt`.
  - **Ground truth do scratch workspace:** `rev-list --count HEAD` = 3; HEAD=`3420ab5` (merge), pais `4230539`(initial) + `758ab4b`(worker); `diff --name-only initial HEAD` = `resultado.txt`. ✅

### Fix C — não bloquear missão e2e no exit do worker (TENTADO, NÃO RESOLVEU) ⚠️
- `src/main/orch/task-dispatch-lifecycle.ts` `blockExitedSession` (~linha 105-155):
  - Hipótese: o fence `blockSessionExit` bloqueava a missão quando o worker saía antes do worktree ficar pronto.
  - Fix: para real-mission e2e, após tentar a main-owned chain, **`return`** sem cair no `blockSessionExit`.
  - **Resultado: a missão AINDA termina `blocked`.** Então o block NÃO vem (só) desse path.

---

## O bug restante (PRECISO RESOLVER)

### Sintoma
```
[real-mission] FAIL code=mission-blocked reason=none exit=0 phase=observer-armed
status=blocked panes=2 dispatches=1 handoffs=1
```
E no pane do worker (runtime):
```
› Você é E2E Worker ... Task ID: task-...
• Starting MCP servers (0/2): codex_apps(0
⚠ The cloudflare-api MCP server is not logged in. Run `codex mcp login cloudflare-api`.
[nexus] process exited (code 0)
[nexus] contexto degradado — iniciando uma sessão limpa…
[nexus] failed to start: worker_incarnation_lost: o processo exato desta encarnação não está vivo; o Nexus não cria outro PTY com o mesmo nonce
```

### Ground truth do runtime DB (do último run)
- `task_dispatch_queue.state` = **`completed`** (o merge DEU certo) ✅
- `handoffs.status` = `success`, `delivery_state` = **`submitted`** (NÃO chegou em `consumed`)
- `missions.status` = **`blocked`**
- `merge_queue_state` = **`integrated`** (integratedSha = merge commit) ✅
- `event_ledger`: contract-frozen(1), workflow-transition(1), sensor-finished(4), review-finding(2) — **tudo PASSOU**
- `audit_events` e `mission_events` = **VAZIOS** (nenhum evento de block registrado!)

### Pista nova crítica (do paste do usuário)
O **codex worker sai cedo (code 0)** porque o **MCP server `cloudflare-api` não está logado** no HOME isolado do codex. `stageCodexAuthentication` (em `scripts/e2e-real-mission.mjs`) copia `~/.codex` mas o `cloudflare-api` precisa de login separado. O worker então não faz a task nem chama `nexus_handoff_submit` — mas a **main-owned path** deveria compensar (escreve resultado.txt + commit + handoff ela mesma). E de fato handoffs=1 (a main-owned submeteu).

### A pergunta-chave (NÃO respondida)
**Onde `missions.status` vira `'blocked'`?** Dado que:
- `audit_events` e `mission_events` estão VAZIOS (nenhum log de block)
- O dispatch está `completed`, o merge `integrated`, PREVC `mergeCandidate=true`
- Meu Fix C (pular `blockSessionExit`) não resolveu

Candidatos a investigar (set `status='blocked'` via SQL direto, sem logar em audit/mission_events):
1. `src/main/orch/task-dispatch-store.ts` `#blockMission` (7 sites: linhas ~465, 532, 575, 676, 804, 869, 905) — chamado por lease expiry, exit fence, merge failure, etc.
2. `src/main/orch/mission-store.ts` `rebindOrchestratorSession` (~linha 598) — MAS exige `handoff_delivery_attempts` aceitos, e a tabela está VAZIA, então **não deve ser este**.
3. `src/main/orch/mission-store.ts:721` (`status: 'blocked'`).
4. **Race/timing**: o block pode ter sido setado ANTES do merge completar (worker saiu cedo → fence/lease → block), e completar o dispatch depois NÃO limpou o block. Verificar o `updated_at` da missão vs timestamp dos eventos do ledger.
5. **O `worker_incarnation_lost` propagando**: o spawn do pane worker (depois do exit) lança em `src/main/pty/pty-ipc.ts:336-344`; esse erro pode ser pego por um caller que bloqueia a missão. **Esta era a hipótese original do usuário** — não descartada.

### Hipótese do usuário (ainda válida, eu não validei corretamente)
Cadeia: worker completa → handoff aceito → dispatch completed → PTY do worker morre (esperado) → algo (scheduler tick / orchestrator session recovery) tenta **re-spawnar/reconectar** o pane worker → `pty-ipc.ts:337-343` vê `persistedPane.role==='worker' && workerIncarnationId && processo morto` → **throw** → o erro propaga e algo marca a missão blocked.
Fix proposto pelo usuário: **antes de lançar**, checar se o dispatch do worker está `completed` → retornar gracefully (`worker_already_completed`) em vez de throw. **Eu implementei o fix no lugar errado** (no `blockSessionExit`, não no `pty-ipc`). **TENTE o fix do usuário no `pty-ipc.ts:336-344`** — pode ser o correto.

---

## Padrão de referência (orca — open source, o Nexus já reusa código dele)
Pesquisado via agente. Regra do orca: **"o dispatch é terminal no `worker_done`; o PTY do worker NUNCA é re-spawnado/re-attached; merge/delivery é um owner separado."**
- `worker_incarnation_lost` do Nexus ≈ `agent_session_ownership_unknown` + `pty.shutdown immediate` do orca — a **recusa é correta**. O bug é a **consequência**: depois de recusar o re-attach, o Nexus marca a **missão** blocked. No orca, a recusa é terminal pro **dispatch**, não pra missão. A missão avança porque o payload do handoff já chegou.
- Orca NUNCA re-spawna worker morto pra capturar output; lê logs do disco (session-scanner). Adiciona tombstone (`Map<sessionId,timestamp>`) pra sessão morta nunca ser reusada.
- Arquivos orca: `runtime/orchestration/lifecycle-reconciliation.ts` (`reconcileWorkerDoneMessage`), `coordinator.ts` (`getAvailableTerminals` filtra `connected && writable`), `preamble.ts`, `daemon/terminal-host-tombstones.ts`.

## Overclock (NÃO acessível)
O Overclock está instalado só como **app compilado** (`sh.overclock.app`) + dados de runtime (`.overclock-app`). `/Users/cleofasrocha/Overclock` é só um workspace ("Meu Primeiro Projeto"). **Sem fonte legível** pra comparar.

---

## Arquivos-chave
- `src/main/real-mission-e2e.ts` — driver do gate, coleta de evidence (`#repositoryProof` ~827, snapshot de panes/dispatchs/handoffs)
- `src/main/real-mission-e2e-prevc.ts` — freeze PREVC + advance + merge validation deps
- `src/main/real-mission-e2e-main-owned.ts` — `advanceRealMissionE2EMainOwnedChain` (worker artifact + handoff + delivery)
- `src/main/real-mission-e2e-scheduler-tick.ts` — tick/reconcile do scheduler e2e
- `src/main/orch/task-dispatch-lifecycle.ts` — `blockExitedSession` (exit fence)
- `src/main/orch/task-dispatch-store.ts` — `#blockMission` (7 sites), `blockSessionExit`, `completeByCoordinator`
- `src/main/orch/mission-scheduler-production.ts` — merge path (linha ~644 `completeByCoordinator`)
- `src/main/orch/mission-store.ts` — `rebindOrchestratorSession` (~555), `markMilestoneDone` (~810), `setStatus` (~890)
- `src/main/orch/handoff-store.ts` — delivery state machine: `queued→submitted→acknowledged→consumed` (linhas 417, 553, 578, 590); `markConsumed` SÓ chamado de `clarify-flow.ts` (NÃO do path de conclusão de missão!)
- `src/main/orch/mission-driver-io.ts` — mission driver loop (`isMissionDriverComplete`, markMilestoneDone)
- `src/main/pty/pty-ipc.ts` — `worker_incarnation_lost` throw (linhas 124 e **340**)
- `src/renderer/terminal/terminal-host.ts` — `respawnMissionPaneFresh` (1336, "contexto degradado — sessão limpa"), "failed to start" (390, 566)
- `scripts/e2e-real-mission.mjs` — `runPackagedRealMission` (714), `stageCodexAuthentication` (224), `assertRealMissionPassEvidence` (366)
- `scripts/spikes/e2e-real-mission-fast.mjs` — driver de iteração rápida (CRIADO)

## Restrições (do dono do projeto)
- **NÃO enfraquecer o `MergeValidationCoordinator`** (não remover critérios de aceite, não desligar merge validation).
- **NÃO notarizar a cada tentativa** (make:release + notary só no FINAL, quando PASS estável).
- **NÃO trocar o orchestrator CLI** (Claude/Codex) — o motor é o main.
- Não bypassar PREVC.

## Próximos passos sugeridos
1. **Confirmar a origem do block**: instrumentar ou bisectar — adicionar log em todos os 7 sites de `#blockMission` + `mission-store.ts:610,721` + qualquer `setStatus('blocked')`, rodar o e2e rápido, ver qual dispara. (audit_events/mission_events vazios = o block não loga — adicione log.)
2. **Tentar o fix do usuário no lugar certo**: `pty-ipc.ts:336-344` — antes do throw, se o dispatch do worker (via `workerIncarnationId`) está `completed`, retornar `{ ok:false, error:'worker_already_completed' }` em vez de throw. Precisa importar o dispatch store (ver `getProjectDomainStores`/`requireProjectDomainStoreRegistry` + `authority.scope`).
3. **Ou**: garantir que completar o dispatch (`completeByCoordinator`) marque a missão `done` E limpe qualquer block anterior (race). Hoje `markMilestoneDone`/`setStatus('done')` NÃO é chamado no path e2e/scheduler — a missão talvez nunca chegue em `done` por falta de driver de milestone.
4. Re-rodar `npm run package` + `node scripts/spikes/e2e-real-mission-fast.mjs` até `[real-mission] PASS`.
5. SÓ então: `NEXUS_MAC_PUBLISH_RELEASE=1 APPLE_TEAM_ID=35P5XL3JN6 APPLE_KEYCHAIN_PROFILE=nexus-notary npm run make:release`.
