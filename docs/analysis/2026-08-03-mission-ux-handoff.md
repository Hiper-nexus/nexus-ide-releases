# Handoff — Pacote de UX das missões (5 sintomas)

**Data:** 2026-08-03
**Branch:** `feat/mission-wave-pack`
**Plano completo:** `~/.claude/plans/splendid-soaring-volcano.md` (aprovado pelo operador)
**Evidência:** bancos SQLite reais em `~/Library/Application Support/NexusIDE/project-runtime/.../runtime.sqlite3` (ler com `file:...?mode=ro`)

Cinco dores do operador: (1) boot "travado" sem feedback até o pane abrir;
(2) prompt inicial gordo; (3) squad de 4 agentes abre só 2 panes; (4) missão
fecha sem veredito ("Motivo não registrado"); (5) "Recuperação automática em
andamento" para sempre. Decisão do operador no sintoma 3: **warm-up read-only
dos reviewer/QA na onda do executor + cronograma de ondas visível**.

---

## FEITO (commits desta sessão)

### A. Veredito nos 4 caminhos silenciosos (sintoma 4) — completo e testado
- `src/shared/mission-block-cause.ts`: helper puro `appendMissionVerdict`
  (idempotente por marcador, teto 65.536) + 4 códigos novos
  (`driver-block-human`, `agent-status-block`, `exclusive-replacement`,
  `runtime-closed`) com COPY PT-BR e RULES antes de `dispatch-failed`
  (causas técnicas citadas no veredito ainda vencem).
- `mission-driver-apply.ts` / `mission-driver-io.ts`: port `blockHuman`
  (patch `user` + veredito na description; learnings mantido).
- `tools-domain.ts`: `nexus_mission_set_status` blocked/failed com note agora
  espelha o veredito na description (`[NEXUS_AGENT_STATUS_BLOCK]`); o throw do
  gate de e2e continua ANTES de qualquer escrita.
- `exclusive-orchestrator-replacement.ts` e `mission-runtime-termination.ts`:
  demote carrega veredito (`<!-- nexus:exclusive-orchestrator-replacement -->`,
  `<!-- nexus:runtime-closed -->`) em vez de block seco.
- Testes: `mission-block-cause.test.ts`, `mission-driver-runtime.test.ts`,
  `exclusive-orchestrator-replacement.test.ts` (fake ganhou `update`).

### B. Telemetria de progresso do bootstrap (sintoma 1) — ESQUELETO apenas
- `shared/mission-intent-projection.ts`: union +`bootstrap_progress`/
  `kickoff_accepted` e `BOOTSTRAP_PROGRESS_STEPS`.
- `mission-event-emit.ts`: `emitBootstrapProgress(scope, missionId, step,
  detail?)` — ring de intent + journal `custom` (única superfície que o
  renderer já assina via `orch:missionEvents.recent`), contador por
  (missão,step) p/ idempotency, nunca lança.
- `mission-orchestrator-bootstrap.ts`: dep opcional `emitProgress` no
  `MissionOrchestratorBootstrapDeps` + wiring em `productionDeps`.
  **Nenhum ponto de emissão ainda** (falta abaixo).

---

## PENDENTE (ordem de execução do plano)

### Incremento 2 — terminar o sintoma 1
1. Pontos de emissão em `#bootstrap` via `this.#deps.emitProgress?.(...)`:
   `authority_checked` (após os `#authorized*Snapshots.set`), `subscription_auth`
   (antes do warm), `plan_baseline` (após try/catch de `ensureMissionPlan`),
   `squad_sealed` (após cheque de `squadRevisionHash`), `prevc_freeze` (antes
   do `void ensureMissionPrevc`), `runtime_checked` (após
   `const runtime = approvedRuntime`), `drift_retired` (após os retirement
   ifs), `attachments_verified` (após validação de anexos), `pane_spawned`
   (após spawn ok), `kickoff_submitted`/`kickoff_accepted` (após
   `submitKickoff`). Nunca awaited; emissão já é try/catch.
2. Renderer: `src/renderer/components/pane-vacancy-progress.ts` novo e puro
   (`bootstrapStepLabel(step)` PT-BR); `PaneVacancy.tsx` (`PaneVacancyBody`)
   com `useEffect`+interval 5s fazendo poll de
   `window.nexus.orch.missionEventsRecent({missionId, limit:30})` filtrando
   `payload.kind==='bootstrap_progress'`, headline `"‹etapa› · há Ns"`;
   `paneVacancyIntent` ganha param opcional `progress` — fallback byte a byte
   na copy atual (`pane-vacancy-intent.ts:62-65`). Testes:
   `pane-vacancy-progress.test.ts`, `pane-vacancy-intent.test.ts`, emissão em
   `mission-orchestrator-bootstrap.test.ts` (ordem + emissão falhando não
   quebra o bootstrap).

### Incremento 3 — enxugar kickoff standard (sintoma 2)
`src/shared/mission-dispatch-kickoff.ts`: colapsar `standardStateLines`+
`standardSequenceLines`+`standardEscalationLines` (:124-207) num
`standardConductLines` **preservando as frases-contrato assertadas** em
`mission-dispatch-kickoff.test.ts:44-103`; escada de design (:216-217) só com
input novo `uiMissionObjective` (classificador `isUiMissionText` em
`shared/mission-work-kind.ts`); `promotedPlanBlock` sem `JSON.stringify`
ilimitado (contagem+SHA+≤8 nomes, teto 1.024); `reusableSquadInstructions` cap
2.048. Callers: `mission-orchestrator-bootstrap.ts` (montagem do prompt),
`mission-kickoff.ts:733`, `renderer/orch/mission-launcher.ts:188`. Meta
regressão: standard < 2,4KB sem promoted plan. NÃO mexer em roundtable/lanes/
`mission-scheduler-task-prompt.ts`/`guided-mission-prompt.ts`.

### Incremento 4 — recovery "para sempre" (sintoma 5)
Em `MissionOrchestratorBootstrapRecovery.#pass`: `RECOVERY_ATTEMPT_TIMEOUT_MS
= 120_000` com race (timeout conta attempt e persiste razão — fix do H9);
`withMissionLifecycleLock(..., { acquireTimeoutMs: 30_000 })` (waiter desiste,
holder segue); bloco SUBSTITUÍVEL `<!-- nexus:recovery-attempt -->` na
description (dep opcional `persistAttemptOutcome`); races: warm keychain 10s
(:898-899), `acp-mission-spawn.ts:140-141` 60s, `acp-harness-driver.ts:365-370`
10s; dead-graph estrutural via `terminalOperationalFailureReason` (não
retryable); UI: `parseRecoveryAttemptBlock` em `shared/mission-recovery-policy.ts`,
`MissionRail.tsx:534-537` abre diagnóstico com "tentativa N/8", botões
"Forçar retomada" (`resumeMissionBootstrap`) / "Encerrar execução"
(`closeMissionRuntime`, com confirmação). NÃO mudar backoff/max attempts nem o
reconciler.

### Incremento 5 — cronograma de ondas na UI (sintoma 3, parte transparência)
`src/shared/mission-task-schedule.ts` (item + `computeTaskWaveHints` BFS);
IPC somente leitura `orch:missions.taskSchedule` (padrão `missionPanesList`
`orch-ipc.ts:1908`, zod `.strict()`, nunca expõe detail selado); UI
`MissionWaveSchedule.tsx` no detalhe da missão + sublinha do rail "Onda N ·
X ativo(s)" com copy do single-writer.

### Incremento 6 — warm-up read-only reviewer/QA (sintoma 3, parte panes)
Flag `feature.mission.warmupAdvisories` (default on após verde, kill-switch);
domínio `guided-warmup` em `guided-task-kind.ts:9-22`; `guidedWarmupDetail` em
`guided-mission-prompt.ts` (padrão `guidedAdvisoryDetail` :370-405); planner
(seção advisories :405-411) cria warmups `dependsOn: []` ownership vazia;
receipt v2 **aditivo** em `guided-mission-plan-authority.ts:196,378` (≤1
warmup opcional por reviewer/QA; ausente = receipts antigos válidos); decidir
entrada em `FENCED_READ_ONLY_LANE_KINDS` (`physical-handoff-git.ts:116-122`,
teste de cobertura obriga); atualizar `guided-mission-planner-recovery.test.ts`,
`guided-mission-work-graph.test.ts`, scheduler onda mista. Resultado: 4 panes
na onda 1 no caso do operador, single-writer intacto.

---

## Cautelas de ambiente

- **Sessão paralela** trabalha no mesmo branch (wave-pack: planner/topologia,
  NÃO commitado no momento deste handoff). Antes de editar
  `guided-mission-planner.ts`/`guided-mission-plan-authority.ts`:
  `git status`/`git log`; aplicar só adições por cima do estado alheio.
- **Nunca** `rebuild:electron`/`package`: `node_modules` compartilhado com o
  app instalado do operador (troca ABI quebra o app empacotado).
- Verificação: `npm run typecheck` + `npx vitest run <área>`; ao vivo só
  `npm start` (dev isolado) ou CDP somente leitura no app do operador.
- Pré-release: `npm run e2e:real-mission` + inspeção do prompt do Maestro.
