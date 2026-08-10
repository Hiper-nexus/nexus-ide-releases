# Nexus V2 Clean Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reescrever o produto visual e a autoridade de missão do Nexus como um fluxo único inspirado estruturalmente no BridgeMind, preservando apenas os primitives Electron comprovados e removendo todo legado sem caller no mesmo corte.

**Architecture:** O main process passa a expor uma única fachada `MissionEngine`, responsável por preparar, iniciar, comandar, projetar e concluir missões. O renderer consome snapshots canônicos por uma API IPC estreita e monta um shell novo com launcher, rail persistente, setup em três etapas, board, inspector, terminal workspace, quadro, memória e configurações. PTY, split tree, preload seguro, stores SQLite, receipt físico e gates existentes permanecem como drivers internos; nenhuma superfície antiga permanece após o cutover.

**Tech Stack:** Electron Forge, TypeScript, React, Zustand, Zod, SQLite, Vitest, xterm.js, CSS importado por `styles/global.css`.

## Global Constraints

- Manter Electron; nenhuma migração para Tauri.
- Preservar `contextIsolation`, preload tipado, scope, approval/session/ownership/receipt fences.
- Preservar `layoutWorkspacePath !== persistKey`, scrollback post-fit e o host PTY existente.
- Preservar a ordem worker-decision: persistir/emitir pergunta enquanto `running`, depois escrever `blocked_user`.
- Preservar `missionDriverActiveMode` como gate e `isDispatchWorkProven` como evidência; remover do driver a autoridade concorrente de conclusão.
- Copy de produto em PT-BR; configuração técnica fica em `Avançado`.
- Default visual Pink City próprio do Nexus; `Nexus Dark` continua disponível.
- Componentes de produto têm no máximo 800 linhas e testes co-localizados.
- Cada corte que migra o último caller remove source, export, CSS, teste, flag, IPC e documentação sem uso no mesmo commit.
- Sem aliases, shims visuais, rotas deprecated, stubs, placeholders ou fallback silencioso para a UI antiga.
- Não copiar nome, logo, assets ou código do BridgeMind.
- Não reverter o trabalho não commitado já presente sem demonstrar substituição equivalente.

---

### Task 1: Canonical MissionEngine Contract

**Files:**
- Create: `src/shared/mission-engine-contract.ts`
- Create: `src/shared/mission-engine-contract.test.ts`
- Modify: `src/shared/orch-types.ts`

**Interfaces:** Produz `MissionLifecycleState`, `MissionSnapshot`, `MissionSummarySnapshot`, `MissionReview`, `MissionPrepareRequest`, `MissionEngineCommand` e schemas Zod. Consome `SquadAgent`, `MissionMilestone`, `MissionIntentContract`. Snapshots nunca carregam prompt selado, bearer token, approval secret ou authority seal.

- [ ] **Step 1: Write failing contract tests**

```ts
it('accepts the complete canonical lifecycle', () => {
  for (const state of [
    'draft', 'review_ready', 'starting', 'running', 'blocked_user',
    'blocked_technical', 'recovering', 'stopping', 'failed', 'completed',
  ] as const) expect(missionLifecycleStateSchema.parse(state)).toBe(state);
});

it('rejects renderer authority fields', () => {
  expect(() => missionPrepareRequestSchema.parse({
    objective: 'Revisar o projeto', contextPaths: [], roster: [],
    authoritySeal: 'renderer-controlled',
  })).toThrow();
});

it('requires an answer payload', () => {
  expect(() => missionEngineCommandSchema.parse({
    kind: 'answer-question', missionId: 'm1', questionId: 'q1',
  })).toThrow();
});
```

- [ ] **Step 2: Run:** `npx vitest run src/shared/mission-engine-contract.test.ts`  
Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement strict schemas and inferred types**

```ts
export const missionLifecycleStateSchema = z.enum([
  'draft', 'review_ready', 'starting', 'running', 'blocked_user',
  'blocked_technical', 'recovering', 'stopping', 'failed', 'completed',
]);
export const missionAllowedActionSchema = z.enum([
  'start', 'retry-kickoff', 'answer-question', 'direct', 'stop', 'resume',
]);
export const missionEngineCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('retry-kickoff'), missionId: idSchema }).strict(),
  z.object({ kind: z.literal('resume'), missionId: idSchema }).strict(),
  z.object({ kind: z.literal('stop'), missionId: idSchema }).strict(),
  z.object({ kind: z.literal('direct'), missionId: idSchema,
    targetAgentId: idSchema.nullable(), text: z.string().trim().min(1).max(16_384) }).strict(),
  z.object({ kind: z.literal('answer-question'), missionId: idSchema,
    questionId: idSchema, optionId: idSchema.optional(),
    text: z.string().trim().min(1).max(16_384).optional() }).strict()
    .refine((value) => value.optionId || value.text, 'optionId or text is required'),
]);
```

`MissionSnapshot` inclui `stateReason`, `progress`, `agents`, `edges`, `units`, `question`, `result`, `allowedActions`, `version`, `updatedAt`. `MissionPrepareRequest` aceita somente objetivo, título opcional, paths de contexto, roster e preferências avançadas.

- [ ] **Step 4: Keep `Mission` as the durable internal row**. Documentar em `orch-types.ts` que product UI consome `MissionSnapshot`, nunca `Mission`.
- [ ] **Step 5: Run:** `npx vitest run src/shared/mission-engine-contract.test.ts src/shared/orch-types.test.ts`  
Expected: PASS.
- [ ] **Step 6: Commit:** `git commit -am "feat(mission): define canonical engine contract"` after adding new files.

---

### Task 2: Atomic Lifecycle Transition Primitive

**Files:**
- Create: `src/main/orch/mission-engine-state.ts`
- Create: `src/main/orch/mission-engine-state.test.ts`
- Modify: `src/main/orch/mission-store.ts`
- Modify: `src/main/orch/mission-store.test.ts`
- Modify: `src/shared/mission-intent.ts`

**Interfaces:** Produz `reduceMissionLifecycle(current,event)` e `ScopedMissionStore.transitionLifecycle(id,expectation,patch)`. `status` e `intent_state` são escritos no mesmo statement SQLite; versão/timestamp stale não altera nada.

- [ ] **Step 1: Write reducer and CAS tests**

```ts
expect(reduceMissionLifecycle(running, { kind: 'block-user' })).toMatchObject({
  status: 'blocked', intentState: 'blocked_user',
});
expect(() => reduceMissionLifecycle(running, {
  kind: 'complete', verification: { pending: 1, inFlight: 0, handoffs: 0 },
})).toThrow(/pending work/i);
expect(store.transitionLifecycle(id, staleExpectation, {
  status: 'blocked', intentState: 'blocked_technical',
})).toBeNull();
```

- [ ] **Step 2: Run:** `npx vitest run src/main/orch/mission-engine-state.test.ts src/main/orch/mission-store.test.ts`  
Expected: FAIL.
- [ ] **Step 3: Implement reducer events**: `review-ready`, `start`, `kickoff-accepted`, `block-user`, `block-technical`, `answer`, `recover`, `stop`, `fail`, `complete`. Cada retorno contém o par inteiro.
- [ ] **Step 4: Implement CAS writer**

```ts
transitionLifecycle(
  id: string,
  expectation: { updatedAt: number; intentVersion: number },
  patch: { status: MissionStatus; intentState: MissionIntentState; description?: string },
): ScopedMission | null
```

SQL: `UPDATE missions SET status=?, intent_state=?, description=?, updated_at=? WHERE id=? AND updated_at=? AND intent_version=?`. Emitir change apenas para `changes === 1`.

- [ ] **Step 5: Introduce `missionContentPatchSchema`** for title, description, milestones and intent contract/version. Keep old `update()` only during migration; new code cannot pass lifecycle fields.
- [ ] **Step 6: Run:** `npx vitest run src/main/orch/mission-engine-state.test.ts src/main/orch/mission-store.test.ts src/shared/mission-intent.test.ts`  
Expected: PASS.
- [ ] **Step 7: Commit:** `git commit -m "refactor(mission): make lifecycle transitions atomic"`.

---

### Task 3: Main-Owned MissionEngine Facade

**Files:**
- Create: `src/main/orch/mission-engine.ts`
- Create: `src/main/orch/mission-engine.test.ts`
- Create: `src/main/orch/mission-engine-registry.ts`
- Create: `src/main/orch/mission-engine-admission.ts`
- Create: `src/main/orch/mission-engine-admission.test.ts`
- Create: `src/main/orch/mission-snapshot.ts`
- Create: `src/main/orch/mission-snapshot.test.ts`
- Modify: `src/main/orch/project-domain-store-registry.ts`

**Interfaces:**

```ts
interface MissionEngine {
  prepare(scope: ProjectExecutionScope, request: MissionPrepareRequest): Promise<MissionReview>;
  start(scope: ProjectExecutionScope, input: { missionId: string; reviewSha256: string }): Promise<MissionSnapshot>;
  command(scope: ProjectExecutionScope, command: MissionEngineCommand): Promise<MissionSnapshot>;
  snapshot(scope: ProjectExecutionScope, missionId: string): Promise<MissionSnapshot>;
  list(scope: ProjectExecutionScope): Promise<MissionSummarySnapshot[]>;
}
```

Também produz `evaluateMissionAdmission({hasDispatchAuthority,hasCurrentKickoffReceipt,orchestratorLive})`.

- [ ] **Step 1: Test all eight admission combinations**. Só all-true é admitido; cada falha tem reason code estável.
- [ ] **Step 2: Test snapshot contradictions**: running+no receipt → `blocked_technical`; done+residual plan → `blocked_technical`; open clarify → `blocked_user`; verified terminal plan → `completed`.
- [ ] **Step 3: Run new tests**. Expected: FAIL.
- [ ] **Step 4: Implement pure admission**

```ts
if (!input.hasDispatchAuthority) return { ok: false, code: 'authority-missing' };
if (!input.hasCurrentKickoffReceipt) return { ok: false, code: 'kickoff-receipt-missing' };
if (!input.orchestratorLive) return { ok: false, code: 'orchestrator-not-live' };
return { ok: true };
```

- [ ] **Step 5: Implement snapshot projection** from mission/task/handoff/control-plane/pane stores. Compute `allowedActions` in main. Redact scope-relative paths and authority data.
- [ ] **Step 6: Implement one engine per `ProjectExecutionScope`**. `prepare` owns arm+intent compile+review; `start` revalidates `reviewSha256`, seals and bootstraps; `command` accepts only the strict union.
- [ ] **Step 7: Run:** `npx vitest run src/main/orch/mission-engine*.test.ts src/main/orch/mission-snapshot.test.ts`  
Expected: PASS.
- [ ] **Step 8: Commit:** `git commit -m "feat(mission): add main-owned engine facade"`.

---

### Task 4: Single Start, Kickoff, and Scheduler Admission Path

**Files:**
- Modify: `src/main/orch/renderer-mission-authority.ts`
- Modify: `src/main/orch/mission-orchestrator-bootstrap.ts`
- Modify: `src/main/orch/mission-kickoff.ts`
- Modify: `src/main/orch/mission-scheduler-authority.ts`
- Modify: `src/main/orch/mission-scheduler-production.ts`
- Modify: `src/main/orch/mission-scheduler-dispatch-transaction.ts`
- Modify: `src/main/orch/orchestration-coordinator.ts`
- Modify: each co-located test

**Interfaces:** Consome `MissionEngine.start`, kickoff acceptance e `evaluateMissionAdmission`. Nenhum `running/dispatched` é gravado antes de receipt atual e orchestrator live.

- [ ] **Step 1: Add silent-stall regressions**: approved contract + missing receipt schedules zero workers and projects `kickoff-receipt-missing`; stale session receipt does not authorize dispatch.
- [ ] **Step 2: Run affected tests and confirm old early-return failure**.
- [ ] **Step 3: Route renderer authority through engine**. Approval fences remain; independent lifecycle writes are removed.
- [ ] **Step 4: Make receipt acceptance an engine operation**. Physical paste remains in `mission-kickoff.ts`; timeout/write/session/authority failure becomes visible `blocked_technical` with retry.
- [ ] **Step 5: Replace all scheduler predicates** with the shared admission result, including idle delivery and PREVC entry.
- [ ] **Step 6: Run:** `npx vitest run src/main/orch/mission-kickoff.test.ts src/main/orch/mission-scheduler-authority.test.ts src/main/orch/mission-scheduler-production.test.ts src/main/orch/mission-orchestrator-bootstrap*.test.ts`  
Expected: PASS.
- [ ] **Step 7: Commit:** `git commit -m "refactor(mission): unify kickoff and scheduler admission"`.

---

### Task 5: Single Blocking, Handoff, and Completion Authority

**Files:**
- Modify: `src/main/orch/task-dispatch-handoff-authority.ts`
- Modify: `src/main/orch/task-dispatch-persistence.ts`
- Modify: `src/main/orch/worker-decision-clarify.ts`
- Modify: `src/main/orch/clarify-flow.ts`
- Modify: `src/main/orch/mission-operator-reply.ts`
- Modify: `src/main/orch/handoff-physical-ack-authority.ts`
- Modify: `src/main/orch/task-dispatch-mission-completion-authority.ts`
- Modify: `src/main/orch/mission-drive.ts`
- Modify: `src/main/orch/mission-driver-runtime.ts`
- Modify: `src/main/orch/mission-driver-io.ts`
- Modify: `src/main/orch/mission-completion-invariant.test.ts`
- Modify: each co-located test

**Interfaces:** Blocking chama engine; completion verifier chama `MissionEngine.completeVerified` uma vez; driver sinaliza stall/recovery mas não escreve terminal state.

- [ ] **Step 1: Test blocking order and completion ownership**: clarify before block; answer once/unpark; no ACK means old owner; driver never writes done; verified-plan path alone completes.
- [ ] **Step 2: Run handoff/persistence/driver/completion tests and observe direct-writer failures**.
- [ ] **Step 3: Migrate blocks preserving exact order**

```ts
await emitWorkerDecisionClarify(...); // mission still running
await missionEngine.blockUser(...);   // atomic pair
```

Technical retry and answer paths call engine commands; no raw lifecycle SQL.

- [ ] **Step 4: Consolidate physical handoff ownership**. Only ACK acceptance transfers ownership; failed delivery keeps owner and emits retryable activity.
- [ ] **Step 5: Consolidate completion**. Move terminal CAS to `MissionEngine.completeVerified`; retain `isDispatchWorkProven` and PREVC/evidence checks; remove `completeFromMissionDriver` and driver complete branch.
- [ ] **Step 6: Delete parallel clocks**. Remove `startMissionSchedulerLoop`, `startMissionDriverLoop`, `stopMissionDriverLoop` after `OrchestrationCoordinator` owns cadence; retain reconcile functions.
- [ ] **Step 7: Run:** `npx vitest run src/main/orch/task-dispatch-handoff-authority.test.ts src/main/orch/task-dispatch-persistence.test.ts src/main/orch/task-dispatch-mission-completion-authority.test.ts src/main/orch/mission-drive*.test.ts src/main/orch/mission-completion-invariant.test.ts src/main/orch/mission-driver-runtime.test.ts`  
Expected: PASS.
- [ ] **Step 8: Commit:** `git commit -m "refactor(mission): establish one terminal authority"`.

---

### Task 6: Narrow MissionEngine IPC and Preload API

**Files:**
- Modify: `src/shared/orch-channels.ts`
- Modify: `src/main/orch/orch-ipc.ts`
- Modify: `src/main/orch/orch-ipc.test.ts`
- Modify: `src/preload/preload.ts`
- Modify: `src/preload/preload.test.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/renderer/orch/orch-bridge.ts`
- Modify: `src/renderer/state/orch-store.ts`
- Modify: `src/renderer/state/orch-store.test.ts`

**Interfaces:**

```ts
window.nexus.mission = {
  prepare(request: MissionPrepareRequest): Promise<MissionReview>;
  start(input: { missionId: string; reviewSha256: string }): Promise<MissionSnapshot>;
  command(command: MissionEngineCommand): Promise<MissionSnapshot>;
  snapshot(missionId: string): Promise<MissionSnapshot>;
  list(): Promise<MissionSummarySnapshot[]>;
  onChanged(listener: (items: MissionSummarySnapshot[]) => void): () => void;
};
```

- [ ] **Step 1: Test strict IPC validation, live renderer scope, listener cleanup and absence of public status/intent patch fields**.
- [ ] **Step 2: Run:** `npx vitest run src/main/orch/orch-ipc.test.ts src/preload/preload.test.ts src/renderer/state/orch-store.test.ts`  
Expected: FAIL.
- [ ] **Step 3: Add six channels and main handlers**. Every handler resolves scope in main and calls the scoped engine.
- [ ] **Step 4: Expose narrow preload bridge**. Never expose raw `ipcRenderer`, store patch or workspace authority.
- [ ] **Step 5: Convert renderer store to summaries**. Keep handoffs/todos/squads/pane bindings; replace `Mission[]` with `MissionSummarySnapshot[]`.
- [ ] **Step 6: Run the three focused tests**. Expected: PASS.
- [ ] **Step 7: Run:** `npm run security:renderer-sinks`  
Expected: PASS.
- [ ] **Step 8: Commit:** `git commit -m "feat(mission): expose canonical snapshot bridge"`.

---

### Task 7: Product Navigation, AppShell, Launcher, and WorkspaceRail

**Files:**
- Create: `src/renderer/state/product-navigation-store.ts`
- Create: `src/renderer/state/product-navigation-store.test.ts`
- Create: `src/renderer/components/product/AppShell.tsx`
- Create: `src/renderer/components/product/AppShell.test.tsx`
- Create: `src/renderer/components/product/Launcher.tsx`
- Create: `src/renderer/components/product/Launcher.test.tsx`
- Create: `src/renderer/components/product/WorkspaceRail.tsx`
- Create: `src/renderer/components/product/WorkspaceRail.test.tsx`
- Create: `src/renderer/styles/app-shell.css`
- Modify: `src/renderer/styles/global.css`

**Interfaces:**

```ts
type ProductDestination =
  | { kind: 'launcher' } | { kind: 'terminal' }
  | { kind: 'mission-setup' }
  | { kind: 'mission'; missionId: string; surface: 'board' | 'terminals' }
  | { kind: 'task-board' } | { kind: 'memory' }
  | { kind: 'settings'; section?: SettingsSection };
```

- [ ] **Step 1: Test one destination at a time**, workspace close→launcher, mission→board, terminals retaining id, settings back→previous, and no parallel booleans.
- [ ] **Step 2: Test four launcher actions**, persistent 240px rail, active/recent groups, status words, keyboard focus and accessible names.
- [ ] **Step 3: Run the four new tests**. Expected: FAIL.
- [ ] **Step 4: Implement the discriminated navigation store**, never `panelOpen/boardOpen/drawerOpen/home.visible`.
- [ ] **Step 5: Implement shell, launcher and rail**. `AppShell` slots: rail/header/content/inspector/overlays. Rail never infers lifecycle.
- [ ] **Step 6: Implement `.nexus-shell`, `.workspace-rail`, `.product-header`, `.product-canvas`** for continuous surfaces, 1100×700 minimum and reduced motion.
- [ ] **Step 7: Run new tests**. Expected: PASS.
- [ ] **Step 8: Commit:** `git commit -m "feat(renderer): add Nexus V2 product shell"`.

---

### Task 8: Three-Step Mission Setup

**Files:**
- Create: `src/renderer/state/mission-setup-store.ts`
- Create: `src/renderer/state/mission-setup-store.test.ts`
- Create: `src/renderer/components/mission/MissionSetup.tsx`
- Create: `src/renderer/components/mission/MissionSetup.test.tsx`
- Create: `src/renderer/components/mission/MissionStep.tsx`
- Create: `src/renderer/components/mission/TeamStep.tsx`
- Create: `src/renderer/components/mission/ReviewStep.tsx`
- Create: `src/renderer/components/mission/MissionSetupRosterRow.tsx`
- Create: `src/renderer/styles/mission-setup.css`
- Modify: `src/renderer/styles/global.css`
- Reuse: `MissionAttachmentPicker`, provider/adapter/account stores and roster validation

**Interfaces:** MissionStep produz objetivo/projeto/contexto; TeamStep produz roster validado; ReviewStep chama `prepare`, renderiza `MissionReview`, chama `start` com hash exato; sucesso abre board.

- [ ] **Step 1: Test draft by workspace, `Missão → Equipe → Revisar`, advanced collapsed, no start before review, stale review rejection and board navigation**.
- [ ] **Step 2: Run setup tests**. Expected: FAIL.
- [ ] **Step 3: Implement serializable draft store** keyed by workspace. Never store authority, receipt, live session or snapshot.
- [ ] **Step 4: Implement Mission step** with “O que você quer que a equipe entregue?”, project folder and file context.
- [ ] **Step 5: Implement Equipe step** with coordinator/builders/reviewer defaults and expandable provider/model/effort.
- [ ] **Step 6: Implement Revisar** with delivery, project, team, permissions, warnings and one `Iniciar missão` CTA.
- [ ] **Step 7: Run setup tests plus** `src/renderer/orch/mission-roster-customize.test.ts`. Expected: PASS.
- [ ] **Step 8: Commit:** `git commit -m "feat(renderer): replace mission wizard with three steps"`.

---

### Task 9: Mission Board, Graph, Composer, Question, and Inspector

**Files:**
- Create: `src/renderer/components/mission/MissionBoard.tsx`
- Create: `src/renderer/components/mission/MissionBoard.test.tsx`
- Create: `src/renderer/components/mission/MissionGraph.tsx`
- Create: `src/renderer/components/mission/MissionGraph.test.tsx`
- Create: `src/renderer/components/mission/MissionAgentCard.tsx`
- Create: `src/renderer/components/mission/DirectionComposer.tsx`
- Create: `src/renderer/components/mission/DirectionComposer.test.tsx`
- Create: `src/renderer/components/mission/MissionQuestion.tsx`
- Create: `src/renderer/components/mission/MissionQuestion.test.tsx`
- Create: `src/renderer/components/mission/MissionInspector.tsx`
- Create: `src/renderer/components/mission/MissionInspector.test.tsx`
- Create: `src/renderer/state/mission-inspector-store.ts`
- Create: `src/renderer/state/mission-inspector-store.test.ts`
- Create: `src/renderer/styles/mission-board.css`
- Modify: `src/renderer/styles/global.css`
- Reuse presentation helpers from `MissionResultDetail`, `MissionControlBoard`, `MissionJournalPanel`, `MissionWaveSchedule`

**Interfaces:** Inspector tabs `agent|plan|chat|activity|team|result`. Composer sends `direct`; Question sends `answer-question`; Board consumes only `MissionSnapshot`.

- [ ] **Step 1: Test deterministic coordinator/worker positions, edges, selected agent tab, inspector tabs, blocked question and terminal consistency**.
- [ ] **Step 2: Test `@todos`, target agent, no empty send, untruncated full text, option chips, free text, single submit and pending disable**.
- [ ] **Step 3: Run new tests**. Expected: FAIL.
- [ ] **Step 4: Implement SVG edge layer + CSS agent cards**. No physics or per-frame allocation; motion uses transform/opacity and respects reduced motion.
- [ ] **Step 5: Implement composer/questions**. Retain draft on error; clear blocked UI only after next canonical snapshot.
- [ ] **Step 6: Implement one inspector**. Split focused children below 800 lines; no direct status mutation.
- [ ] **Step 7: Run new tests plus result/control/wave/journal presentation tests**. Expected: PASS.
- [ ] **Step 8: Commit:** `git commit -m "feat(renderer): add canonical mission board and inspector"`.

---

### Task 10: Terminal, Task Board, Memory, and Settings Destinations

**Files:**
- Create: `src/renderer/components/product/TerminalWorkspace.tsx`
- Create: `src/renderer/components/product/TerminalWorkspace.test.tsx`
- Create: `src/renderer/components/product/TaskBoardWorkspace.tsx`
- Create: `src/renderer/components/product/TaskBoardWorkspace.test.tsx`
- Create: `src/renderer/components/product/MemoryWorkspace.tsx`
- Create: `src/renderer/components/product/MemoryWorkspace.test.tsx`
- Create: `src/renderer/components/settings/SettingsWorkspace.tsx`
- Create: `src/renderer/components/settings/SettingsWorkspace.test.tsx`
- Create: `src/renderer/styles/product-workspaces.css`
- Modify: `src/renderer/styles/settings.css`
- Modify: `src/renderer/styles/global.css`
- Reuse: `PaneGrid`, `terminal-host`, `MemoryPanelBody`, settings sections and `settings-nav.ts`

**Interfaces:** Terminal retains existing grid/PTY and optional mission id; Task Board updates todos only; Memory uses local-first body; Settings uses product navigation instead of drawer state.

- [ ] **Step 1: Test terminal continuity Board↔Terminals, task update, memory onboarding, settings fixed rail/search/deep-link**.
- [ ] **Step 2: Run four tests**. Expected: FAIL.
- [ ] **Step 3: Implement TerminalWorkspace without remounting xterm hosts**. Switching only reparents existing hosts; never spawns another PTY.
- [ ] **Step 4: Implement full-page Task Board and Memory**, each with one useful empty-state CTA and no floating duplicate.
- [ ] **Step 5: Refactor settings into a page**. Reuse sections; remove dialog role, focus trap, scrim and Escape close. Keep all existing sections reachable.
- [ ] **Step 6: Run new tests plus existing settings nav/section tests**. Expected: PASS.
- [ ] **Step 7: Commit:** `git commit -m "feat(renderer): add full-page product destinations"`.

---

### Task 11: App Entrypoint Cutover and Caller Migration

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify/create: `src/renderer/App.test.tsx`
- Modify: `src/renderer/components/CommandPalette.tsx` and test
- Modify: `src/renderer/components/AgentNotifications.tsx` and test
- Modify: `src/renderer/components/PaneContextMenu.tsx` and test
- Modify: `src/renderer/lib/progressive-launch.ts`
- Modify: `src/renderer/lib/progressive-launch-apply.test.ts`
- Modify: `src/renderer/voice/jarvis-action-executor.ts`
- Modify: affected shortcut/layout tests

**Interfaces:** `App` renders one `AppShell`; all navigation uses product-navigation store; overlays remain only for hard confirmations, palette, cheatsheet and reachable voice UI.

- [ ] **Step 1: Test boot→launcher, workspace→terminal, new mission→setup, mission→board, board↔terminals, settings deep-link, blocked notification→inspector**.
- [ ] **Step 2: Run App/palette/notification/context/progressive tests**. Expected: FAIL under old booleans.
- [ ] **Step 3: Replace App composition**. Remove mounts of `WorkspaceBar`, `MissionRail`, `HomeDeck`, `OrchestrationPanel`, floating `MemoryPanel`, `OpsBoard`, `MissionKickoffBanner`, `MissionWizard`, `SettingsDrawer`, `OperatorFx`, `MissionEndorphinFx`.
- [ ] **Step 4: Migrate callers**: ⌘N setup; ⌘B task board; ⌘, settings; mission attention to board+inspector; context action to board; progressive launch swarm→setup, board→task board, terminal→terminal.
- [ ] **Step 5: Preserve browser-pane suppression** from destination semantics, not deleted booleans.
- [ ] **Step 6: Run focused tests**. Expected: PASS.
- [ ] **Step 7: Smoke launch** with `npm run start` via process hub; traverse Launcher→Setup→Terminal without relevant console errors.
- [ ] **Step 8: Commit:** `git commit -m "refactor(renderer): cut over to Nexus V2 shell"`.

---

### Task 12: Delete Superseded Product and IPC Paths

**Delete after zero-caller proof:**
- `src/renderer/components/MissionWizard.tsx` and all `MissionWizard*.test.tsx`
- `src/renderer/components/MissionWizardReview.tsx` and tests
- `src/renderer/components/MissionWizardPlanReview.tsx` and tests
- `src/renderer/components/MissionModePicker.tsx` and test
- `src/renderer/components/MissionRail.tsx` and layout test
- `src/renderer/components/OpsBoard.tsx` and tests
- `src/renderer/components/OrchestrationPanel.tsx`
- `src/renderer/components/MissionResultDetail.tsx` and tests
- `src/renderer/components/WorkspaceBar.tsx`
- `src/renderer/components/LaunchScreen.tsx`
- `src/renderer/components/HomeDeck.tsx`
- old `src/renderer/components/MissionComposer.tsx` and test
- `src/renderer/components/MissionKickoffBanner.tsx` and test
- `src/renderer/components/settings/SettingsDrawer.tsx`
- `src/renderer/components/memory/MemoryPanel.tsx`
- `src/renderer/components/MissionEndorphinFx.tsx`
- `src/renderer/components/OperatorFx.tsx` and tests
- `src/renderer/components/Onboarding.tsx`, `src/renderer/state/onboarding-store.ts`, victory callers, and zero-caller renderer IPC
- `src/renderer/components/FilesPanel.tsx` and phantom visibility callers only after contextual Editor owns its tree/open/edit/save behavior; retain the files domain store without panel chrome
- `src/renderer/state/mission-wizard-store.ts` and test
- `src/renderer/state/home-store.ts` and test only after every last-pane/presentation caller is migrated
- `src/renderer/styles/launch-wizard.css`
- `src/renderer/styles/home-deck.css`
- `src/renderer/styles/ops-board.css`
- `src/renderer/styles/mission-kickoff.css`

**Retain and repair before deletion work:** mounted `OrchestrationModeDialog`, `MediaStudioPanel`, and `OperatorProfile`; durable Board/Inspector plan promotion; state-aware mission stop/close/discard/remove controls; Settings squad create/import/edit/export/delete; contextual file tree/editor; shared cause-aware attention routes; modal focus/native-pane suppression; `settings-drawer-section.ts`; reopen/close/rebind/promote/handoff runtime operations.

**Modify:** canonical MissionPrepare/Review for the main-validated ephemeral Pet Studio profile and governed image snapshot; renderer stores/callers; renderer-only mission IPC/channel/preload types; `global.css`; mixed styles containing only deleted selectors.

- [ ] **Step 1: Freeze exact symbol/channel inventory.** Every match is migrated now or proves a retained non-legacy capability. Do not infer safety from an unmounted component.
- [ ] **Step 2: Add Pet Studio prepare profile.** Force `nexus-pet-studio`, exact one-Codex authority, governed snapshot, rendered fence, and native start confirmation. Use Pet-specific navigation that preserves Settings return provenance; every cancel/back/success/reselection/workspace/rail/non-Pet entry invalidates ephemeral context and late prepare work.
- [ ] **Step 3: Restore retained resolvers and capabilities.** Mount Mode, Media, and Operator Profile; make Plan promotion durably reachable; move squad management into Settings and FilesPanel behavior into contextual Editor; migrate intent-shell reopen; expose the existing state-aware mission action matrix; enforce modal focus and browser-pane suppression.
- [ ] **Step 4: Migrate navigation callers.** Last-pane close never changes a non-terminal destination and Terminal stays on PaneVacancy; Settings terminal actions reveal their panes; attention uses the shared cause-to-tab matrix; Jarvis/visibility/preload harnesses use real product destinations and mounted overlays. Preserve a legacy shell until replacement starts.
- [ ] **Step 5: Delete listed legacy UI/stores/styles** only after zero-caller proof. Keep mounted Mode, Media, Operator Profile, files domain store, settings resolver, and runtime helpers.
- [ ] **Step 6: Remove obsolete store fields.** Drop orch panel/board, Settings drawer, home/wizard/files-panel/onboarding phantom state while retaining files domain data and persisted settings.
- [ ] **Step 7: Remove only renderer creation-lifecycle endpoints** for create/immediate-authorize/arm/submit/approve/renderer-bootstrap/renderer-kickoff/bind/rearm/prepare-project/cancel-preparation/prompt-queue after callers and preload harnesses migrate. KEEP `promotePlanLane`, `resumeMissionBootstrap`, `rebindMissionOrchestrator`, `closeMissionRuntime`, main-owned kickoff/bootstrap, and V2-owned removal; re-prove `updateMission` separately.
- [ ] **Step 8: Run:** `npm run typecheck`, focused co-located tests, and `npm run test:changed`  
Expected: PASS.
- [ ] **Step 9: Search production source** for deleted surfaces, store fields, launcher helpers, and removed channels. Expected: zero production matches; retained capabilities have canonical callers.
- [ ] **Step 10: Commit:** `git commit -m "refactor(renderer): remove superseded Nexus product"`.

---

### Task 13: Pink City Default, Nexus Dark Theme, and Accessibility

**Files:**
- Modify: `src/renderer/styles/base.css`
- Modify: `src/renderer/styles/ui-theme.ts`
- Modify: `src/renderer/styles/ui-theme.test.ts`
- Modify: new V2 CSS files
- Modify: `DESIGN.md`
- Create/update: co-located layout/a11y tests for new components

**Interfaces:** Default id `nexus-pink-city`; `nexus-dark` remains selectable; terminal palette stays independently dark unless changed in terminal settings.

- [ ] **Step 1: Test default theme, computed AA contrast, focus-visible behavior, 32/40px targets and reduced motion through rendered styles**.
- [ ] **Step 2: Run theme/a11y tests**. Expected: old dark default fails.
- [ ] **Step 3: Add Pink City at root/default and move dark under `data-theme='nexus-dark'`**. Magenta is selection/live only; CTA stays the clearest neutral action; state remains text+glyph.
- [ ] **Step 4: Update `DESIGN.md` identity, tokens, shell hierarchy and default** while preserving overlay, cross-platform, terminal repaint and security rules.
- [ ] **Step 5: Verify 1100×700, 1280×800, 1400×900** with no horizontal overflow and usable rail/inspector/canvas.
- [ ] **Step 6: Run:** `npx vitest run src/renderer/styles/ui-theme.test.ts src/renderer/components/product/*.test.tsx src/renderer/components/mission/*.test.tsx src/renderer/components/settings/SettingsWorkspace.test.tsx`  
Expected: PASS.
- [ ] **Step 7: Commit:** `git commit -m "feat(design): establish Nexus Pink City product system"`.

---

### Task 14: End-to-End Mission Proof and Release Gates

**Files:**
- Modify: existing real-mission E2E harness files to use `window.nexus.mission`
- Modify: `docs/ARCHITECTURE.md`
- Modify/delete: operational docs referencing removed surfaces/channels
- Create: screenshots in the repository's existing visual-evidence location/naming convention

**Flow:** create→prepare→review→start→receipt→dispatch→output→question→answer→handoff ACK→verified completion→inspect→terminal→reopen→resume.

- [ ] **Step 1: Update real-mission harness** to drive the V2 UI. Disable warmup/TTL only where current E2E already requires stable probe panes.
- [ ] **Step 2: Run every changed co-located test**. Expected: PASS.
- [ ] **Step 3: Run:** `npm run typecheck` and `npm run security:renderer-sinks`. Expected: PASS.
- [ ] **Step 4: Run focused engine/kickoff/scheduler/handoff/completion/driver/IPC/store suite**. Expected: PASS.
- [ ] **Step 5: Launch real Electron app** through process hub; confirm Launcher and no relevant console errors.
- [ ] **Step 6: Execute safe disposable read-only mission**. Observe every lifecycle event; completion cannot precede terminal units and ACKs.
- [ ] **Step 7: Restart and resume**. Same mission snapshot, layout ownership and resumable session ids restore; no duplicate mission.
- [ ] **Step 8: Capture at 1400×900**: Launcher, Missão, Equipe, Revisar, Board, blocked Question, Terminals, Result, Task Board, Memory, Settings. Compare composition to observed BridgeMind without copying assets.
- [ ] **Step 9: Run:** `npm test`, `npm run typecheck`, `npm run security:renderer-sinks`. Expected: PASS.
- [ ] **Step 10: Update `docs/ARCHITECTURE.md`** for MissionEngine, snapshot IPC and renderer topology; delete stale product docs rather than leaving contradictions.
- [ ] **Step 11: Final dead-code audit** with references/imports/TypeScript diagnostics. Delete every orphaned helper, export, fixture, style and flag.
- [ ] **Step 12: Commit:** `git commit -m "feat: deliver Nexus V2 clean cutover"`.
