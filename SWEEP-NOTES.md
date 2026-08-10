# Varredura de deleção do motor cerimonial (2026-08-10)

Remoção física do motor de missão cerimonial, substituído pela Via Rápida
(`src/main/orch/mission-fast-lane.ts`). Caminho único: o env
`NEXUS_CEREMONIAL_MISSIONS` morreu; `missionFastLaneEnabled()` retorna `true`.

## Itens da lista que NÃO foram deletados (caller vivo inesperado — regra 3)

- **`task-dispatch-physical-handoff-authority.ts`** — o caminho MCP de handoff
  (`handoff-store.ts` → `task-dispatch-handoff-authority.ts`) usa
  `assertPhysicalTaskHandoffAuthority` na transação física do
  `nexus_handoff_submit` com dispatch legado. O caminho de handoff é KEEP
  explícito do brief; o módulo ficou como dependência mínima dele.
- **`mission-worker-spawn-authority.ts`** — `assertReleaseQualifiedMissionWorkerSpawn`
  é usado por `cli-context-draft-reviewer.ts` e `tool-util.ts`
  (`spawnPaneAndMaybePrompt`, que tem callers vivos: `tools-panes` e
  `cli-automated-reviewer`). Os helpers de CLI advisory migraram para
  `shared/mission-advisory` (origem real; o re-export do scheduler morreu).
- **`login-stuck-watchdog.ts`** — não era só do scheduler: `orch-ipc.ts` e
  `pty/pre-spawn-probe.ts` usam. Segue como participante do coordinator.
- **`mission-orchestrator-exit-policy.ts`** — `mission-store.ts` e
  `tool-util.ts` usam (`sanitizeMissionOrchestratorExitOutput` etc.).
  Só o *lifecycle* (vigia de exit) morreu.
- **Merge queue (`runtime/merge-queue*.ts`, `merge-stall-watchdog.ts`)** — o
  motor de merge vive DENTRO do `worktree-runtime-registry` (vivo:
  `nexus_worktree_create/get`, `nexus_merge_status` em tools-context,
  `resolveIntegratedMission` no context-workflow via `main.ts`). Deletados
  apenas os órfãos reais: `merge-task-finalizer`, `merge-validation-coordinator`
  (ficou órfão quando os tools de merge cerimoniais saíram do tools-context) e
  `runtime/guided-greenfield-baseline`.
- **Família worktree (`worktree-manager*`, `worktree-contract`, etc.)** — infra
  compartilhada com callers vivos fora de missão: `context/git-binding`,
  `orientation-service`, `sqlite-workflow-state-stores`, `pty-manager`
  (`linked-worktree-git-paths`), `main.ts` (`worktree-pty-sweep`).
- **`pty-stream-handoff.ts` / `pty-stream-mission-control.ts`** — wired no
  `mcp-server.ts` (vivo). Em fast lane o transporte por marcador de PTY exige
  dispatch vinculado e portanto nunca dispara; ficou como lane legado inerte
  (zero dependência de módulo deletado).
- **`task-dispatch-store.ts` / `task-dispatch-codec.ts` /
  `task-dispatch-persistence.ts` / `task-dispatch-handoff-authority.ts` /
  `task-dispatch-authority.ts`** — o suite de stores continua expondo
  `taskDispatches` (projeção do engine, idle-delivery, tools-handoff
  `heartbeat`, control-plane do renderer leem linhas legadas). Os MÉTODOS
  cerimoniais do store (claim/route/complete*/reroute*/waiver/fanout) foram
  removidos junto com os módulos de autoridade que os sustentavam.
- **`prevc-reviewer-profile.ts` / `mission-degradation.ts` /
  `guided-task-kind.ts`** — usados por gate/mcp-server/mission-event-emit
  (infra viva de revisão automatizada e eventos).

## Cadeia de release (adendo do item 9)

- O gate do candidato (`scripts/release-candidate-gate.mjs`) roda o **smoke
  empacotado** (`smoke-packaged-app.mjs --app`) contra o app extraído do ZIP
  selado e grava `packaged-smoke-report.json` (schema 1) amarrando
  versão/commit/sha do ZIP/identidade. Receipt do candidato agora é
  `schemaVersion: 5` com `artifacts.packagedSmoke` e
  `verification.packagedSmoke`.
- `publish-release.mjs` e `release-security-gate.mjs` validam o relatório de
  smoke no lugar da evidência real-mission (asserts de coerência mantidos:
  digest selado, binding exato, manifesto schema 3 com
  `releaseArtifacts.packagedSmoke`).
- `scripts/e2e-real-mission*.mjs`, `scripts/test-support/real-mission-evidence.mjs`
  e `scripts/release-fast-lane.mjs` (waiver que reusava evidência de baseline —
  premissa morta) foram deletados. `package.json`: `e2e:real-mission` removido;
  `release:candidate` → `smoke-packaged-app.mjs`.
- O preflight de provedores do gate morreu junto (sondava o roster da missão
  cerimonial; o smoke não usa provedores).

## Observações operacionais

- Suítes que abrem SQLite (better-sqlite3) não rodam neste shell — ABI do
  node_modules compartilhado é do Electron (trap conhecida; falha idêntica em
  suítes não tocadas, ex.: `task-store.test.ts`). Nada disso é regressão da
  varredura.
- Sessão paralela ativa no mesmo worktree durante a varredura: os commits
  `633f3660` (design context), `40d35768` (personalização inline) e
  `7d1bd1bd` (limpeza de testes) são dela; `633f3660` carregou junto as
  deleções staged dos shims e2e desta varredura (index compartilhado).
- `mission_set_status done` de missão standard com squad continua fail-closed
  (recusa genérica main-owned); o desvio específico de plano selado morreu com
  o plano selado.
- Handoffs aceitos aguardando ACK: o outbox não re-prova mais autoridade de
  scheduler (não há dispatch durável) — mantém o estado e não re-entrega.
