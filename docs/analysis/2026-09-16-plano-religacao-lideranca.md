# Plano executável: religação da liderança única

Data: 2026-09-16. Escopo: Main, renderer, gates e teardown da liderança de
missão. Este plano executa o inventário de
`docs/analysis/2026-09-16-lideranca-unica-religacao.md`; não transforma role,
cache ou nome de agente em autoridade.

## 1. Estado atual em `main`

- O motor `MissionLeadership` já está em
  `src/main/orch/mission-leadership.ts:220-388`. A leitura única é
  `resolveMissionLeader(scope, missionId): MissionLeader | null` (`:264-285`),
  com `(sessionId, paneId, source, proven)`; conflitos passam por
  `assertSingleLeader` (`:288-293`).
- A escrita é `applyLeadership` (`:295-388`), com origins
  `spawn|adopt|respawn|promote|create`, validação de escopo/liveness e
  transação `A → C → D`, rollback de runtime e evento F pós-commit.
- O singleton/adaptador real está em
  `src/main/orch/mission-leadership-runtime.ts:73-266`. Ele consulta stores,
  sessões físicas, gate e `orchPanes`; a transação usa o
  `ProjectRuntimeManager`/SQLite (`:165-178`) e `rebindOrchestratorSession`
  (`:181-190`). O próprio cabeçalho registra que os callers ainda não foram
  religados.
- A base entregue tem 68 testes de liderança (engine, invariantes, runtime e
  rollback) cobrindo liveness, escopo, split-brain, A/C/D, compensação e
  ausência de tokens em claims/eventos.
- F-563 já entregou `isolatedWriter` em `tools-panes.ts:400,875-885`:
  worktree/branch próprias, `executionMode=isolated_worktree` e liberação no
  exit. A Via Rápida ainda sela escritor como `same_checkout` em
  `mission-fast-lane.ts:1043`; portanto o fan-out está disponível, mas ainda
  precisa ser alcançado pelo despacho.

## 2. Pré-requisitos de contrato, nesta ordem

Cada item é bloqueante para iniciar a onda indicada. “Pronto” significa código,
teste focado verde, `typecheck` verde e `security:renderer-sinks` verde.

### a) A e C na mesma conexão/transação

Implementar/confirmar que `setDurableLeader` (A), `replacePaneLeader` (C) e
efeitos de rebind compartilham o `transaction(() => ...).immediate()` do mesmo
`ProjectRuntimeManager`; listeners não podem publicar estado intermediário.

**Pronto quando:** falha em qualquer passo deixa missão e `missionPanes`
exatamente como antes, sem evento F e sem gate promovido.

**Teste que prova:**
`src/main/orch/mission-leadership-runtime.rollback.test.ts:96-115` força
falha em `replaceRuntimeLeader` e lê A/C diretamente no SQLite; manter também
`:117-136` para a falha em C. Complementar com
`mission-leadership-runtime.test.ts:130-151`.

### b) Decisão de produto para promote/adopt sobre líder vivo

Registrar a decisão antes da onda 6/7. Recomendação segura: **recusar** se
existir líder vivo; permitir somente uma operação explícita de handoff que
primeiro revogue/demova o anterior e prove a transição na mesma transação.
Hoje o engine rejeita predecessor não-`exited` (`mission-leadership.ts:319-325`),
mas `renderer-mission-authority.ts:773-807` ainda permite a promoção em etapas.

**Pronto quando:** há uma regra única para `adopt` e `promote`, com erro
acionável e sem caminho que aceite `ctx.role`/`missionPanes.role` isoladamente.

**Teste que prova:**
`mission-leadership.test.ts:207-242` (vivo versus exited, adopt/promote) e
`renderer-mission-authority.test.ts` cobrindo a recusa/hand-off escolhida.

### c) Spawn/respawn e predecessor comprovadamente exited

Separar “sessão registrada exited” de “árvore ainda não removida”. O resolver
deve permitir a decisão de `spawn/respawn` quando o predecessor está
comprovadamente `exited`; a cerca física continua exigindo prova de término
antes de criar outro processo (`pty-manager` não perde sua função).

**Pronto quando:** `exited` não bloqueia por liveness lógica, mas
`unverifiable/unknown/busy/idle/spawning` continua bloqueando e não há dois
processos físicos.

**Teste que prova:** `mission-leadership.test.ts:207-242`,
`mission-leadership-runtime.test.ts:115-153,193-218` e o teste da cerca física
referido por F-563 (`src/main/pty/pty-manager.test.ts:3131,3678`).

### d) `origin: 'create'` no `nexus_mission_create`

O enum real já inclui `create` em `mission-leadership.ts:9-13`; falta religar
`tools-domain.ts:259-287` para usar essa origem somente quando não existe
qualquer sessão/pane anterior e o alvo foi autorizado pela criação. Não
reinterpretar criação de missão em pane de usuário como `spawn`.

**Pronto quando:** criação nova chama `applyLeadership(..., {origin:'create'})`,
criação sobre A/C/D existente é recusada, e rollback remove A/C/D parcial.

**Teste que prova:** adicionar/ajustar teste co-local de
`tools-domain.ts` junto de `tools-domain-mission-authority.test.ts`; usar também
`mission-leadership.test.ts:307-310` para a recusa de sessão anterior.

### e) `releaseLeadership` para teardown

Antes de trocar leitores de teardown, expor no engine a operação de release
com CAS: `clearDurableLeaderIfMatches`, `releasePaneLeader`, captura/restauro
de runtime e evento `mission-leadership-released` já estão no contrato de
ports (`mission-leadership.ts:149-154`), mas precisam de uma API pública
ordenada e de adapter implementado.

**Pronto quando:** liberar o líder esperado é idempotente; liberar uma sessão
stale não apaga sucessor; processo físico só é terminado pelo teardown próprio.

**Teste que prova:** `mission-leadership-runtime.test.ts` e
`mission-runtime-termination.test.ts`; incluir CAS stale, replay de evento e
rollback de D.

### f) erro tipado de split-brain sem leitores engolirem

Usar `MissionLeadershipError`/`code='split_brain'` (`mission-leadership.ts:23-46`)
como contrato estável. `gate.ts:484-500` deve distinguir identidade de
capability; `mcp-server.ts:1289-1296` não pode converter divergência em
`null`; `idle-delivery.ts:177-214,1134-1178` deve recusar/registrar bloqueio,
sem seguir como se fosse ausência transitória.

**Pronto quando:** split-brain chega ao caller como erro tipado, nenhum `catch`
o transforma em líder ausente/saudável, e o único retry é explícito após
reconciliação.

**Teste que prova:** `mission-leadership.invariants.test.ts:253-281`,
`mission-leadership-runtime.test.ts:130-151,210-218`, `gate.test.ts`,
`mcp-server-governed-profile.test.ts` e `idle-delivery.test.ts`.

## 3. Oito ondas do inventário

Todos os gates abaixo são obrigatórios em cada onda:
`npx vitest run <testes focados>`, `npm run typecheck` e
`npm run security:renderer-sinks`.

| Onda | Arquivos e linhas do inventário | Testes co-localizados | Gate obrigatório | Tamanho / execução |
|---|---|---|---|---|
| 1 — leitores puros | `mission-fast-lane.ts:2879-2903`; `civilian-pronto.ts:527-529`; `civilian-delivery-completion.ts:858-860,1310-1320`; `mission-engine-production.ts:1025-1100,1132-1137` | `mission-fast-lane*.test.ts`, `civilian-pronto.test.ts`, `civilian-delivery-completion.test.ts`, `mission-engine-production.test.ts` | V+T+S | M (4 grupos, 1–2 dias). Pode dividir 1a fast-lane/engine e 1b civilian em worktrees disjuntas; integrar antes da 2. |
| 2 — mirror/UI | `orch-store`, `layout-store`, `orch-bridge.ts:778-789`, `mission-pane-presentation.ts`, `mission-last-pane-notify.ts`, failover/restore do renderer | `orch-store*.test.ts`, `layout-store.test.ts`, `orch-bridge-*.test.tsx`, `mission-pane-presentation.test.ts`, `mission-last-pane-notify.test.ts`, `failover-decision.test.ts`, `restore-agents-gate.test.ts` | V+T+S | G (muitos mirrors e IPC, 2–3 dias). Série após contrato; subgrupos renderer podem correr em worktrees separadas, mas merge/teste é único. |
| 3 — gates/leitores de autorização | `gate.ts:484-500,608-645`; `mission-intent-gate.ts`; `mcp-dispatch.ts`; `mcp-server.ts:1279-1301`; `tools-panes.ts:615-631`; `tools-domain.ts`; `tools-handoff.ts`; `clarify-flow.ts`; `idle-delivery.ts`; gates de review | `gate.test.ts`, `mission-intent-gate.test.ts`, `mcp-dispatch-security.test.ts`, `mcp-server-governed-profile.test.ts`, `tools-panes-*.test.ts`, `tools-domain-*.test.ts`, `clarify-flow.test.ts`, `idle-delivery.test.ts`, `mission-independent-review-gate.test.ts` | V+T+S | G (segurança, 2–4 dias). 3a gates MCP e 3b delivery/review podem correr em paralelo; ambos dependem da 1 e do contrato f. |
| 4 — bootstrap/spawn | `mission-fast-lane.ts:1062-1069`; `mission-fast-lane.ts:235-251`; `tools-panes.ts:875-885`; `mission-pane-store.ts:235-251` | `mission-fast-lane-pane-binding.test.ts`, `mission-fast-lane.test.ts`, `tools-panes-isolated-writer.test.ts`, `mission-pane-store.test.ts` | V+T+S | G (efeito físico + A/C, 2–3 dias). Série após 3; não paralelizar com 5. |
| 5 — respawn | `mission-fast-lane.ts:1841-1884`; `mission-runtime-termination.ts:231-257,686-695`; failover main-owned; cerca PTY | `mission-fast-lane-respawn-redelivery.test.ts`, `mission-runtime-termination.test.ts`, `failover-continuity.test.ts`, `failover-decision.test.ts`, `pty-manager.test.ts` | V+T+S | G (prova de exit, 2–3 dias). Série após 4; rollback exige preservar pane/sessão anterior até o novo líder estar aplicado. |
| 6 — adoção | `mission-fast-lane.ts:2175-2189,2390-2398`; `renderer-mission-authority.ts:672-713,750-844`; `adopted-orchestrator-reflect.ts` | `mission-fast-lane-resume-guard.test.ts`, `renderer-mission-authority*.test.ts`, `adopted-orchestrator-reflect.test.ts` | V+T+S | G (2–4 dias). Série após b, 4 e 5; só pode paralelizar testes de UI com leitura main, não o commit. |
| 7 — promote/recovery | `renderer-mission-authority.ts:773-807`; `mission-pane-store.ts:395-525`; `mission-reopen.ts:291-323`; `handoff-delivery-runtime-recovery.ts`; `delegation-supervisor.ts:475-498` | `mission-pane-store.test.ts`, `mission-reopen.test.ts`, `delegation-supervisor.test.ts`, `idle-delivery.test.ts`, criar teste co-local de `handoff-delivery-runtime-recovery.ts`, `mission-leadership-runtime.rollback.test.ts` | V+T+S | GG (maior risco, 3–5 dias). Série obrigatória após 6; A/C/D/E/F devem ter uma única ordem de commit. |
| 8 — remoção de legados/teardown | chamadas externas a `setOrchestratorSession`/`rebindOrchestratorSession`; `mission-runtime-termination`; caches B; `tools-domain.ts:259-287`; `nexus_mission_create` | suíte de liderança, `mission-runtime-termination.test.ts`, `tools-domain-mission-authority.test.ts`, regressão focada de cada caller removido | V+T+S | M/G (2–3 dias). Última e serial; só apagar primitive quando release e `origin:create` estiverem cobertos. |

### Dependências e paralelismo

Ordem de integração: **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8**. Worktrees separadas
são aceitáveis apenas para os subgrupos explicitamente disjuntos de 1 e 3,
e para testes/renderer isolados de 2 e 6; nenhum trabalho paralelo pode
alterar o mesmo store, método de liderança ou contrato. Onda 7 é o ponto de
convergência: não iniciar 8 com qualquer leitor legado ainda ativo.

## 4. Riscos e rollback por onda

| Onda | Risco principal | Rollback operacional |
|---|---|---|
| 1 | Leitor escolher líder live não provado ou fabricar pane/sessão. | Reverter apenas o caller ao reader anterior; manter o resolver e comparar `(sessionId,paneId)` no log de teste. |
| 2 | Renderer fechar pane stale ou pintar dois líderes antes do Main. | Desligar o listener/replay novo e voltar a mirror derivado; nunca apagar storage ou sessão física. |
| 3 | Gate permissivo, split-brain engolido ou handoff entregue à sessão errada. | Fail-closed no gate/delivery, sem retry automático; reativar caller anterior somente para missões legacy sem A. |
| 4 | Spawn entre A/C deixar missão sem líder ou promover worker. | Reter reserva, fechar somente tentativa não ligada e restaurar A/C pela transação; não criar segundo pane. |
| 5 | Respawn concorrer com predecessor exited/unverifiable. | Parar watcher/first-wave, preservar predecessor e exigir prova PTY; reabrir missão só por Retomar. |
| 6 | Adoção local confirmar antes de autoridade física/durável. | Remover apenas projeção F local, manter pane vivo e marcar adoção recusada; não rebaixar A manualmente. |
| 7 | Promote/recovery parcial gerar A≠C≠D≠E≠F. | Acionar rollback A/C/D; se notificação F falhar, manter commit durável e replayar evento, nunca eleger outro líder. |
| 8 | Remover primitive antes de release/create e quebrar teardown/reopen. | Reintroduzir somente o caller/adapter removido; manter primitives de storage até a próxima release validada. |

## 5. Relação com o fan-out `isolatedWriter`

Liderança única e fan-out são complementares: o líder resolvido é o único
coordenador que roteia tarefas, recebe handoffs e integra branches; cada
`isolatedWriter` permanece `role:'worker'`, com `executionScope.rootRealPath`
próprio e sem poder promover-se. A liderança resolve **quem coordena**; o
isolamento resolve **onde cada escritor pode modificar**.

O fluxo seguro é: líder único aplica/valida a decisão → despacho aloca
worktrees disjuntas para writers → workers entregam commits/handoffs → líder
integra em ordem de dependência → `tapSessionExit` libera a worktree. A onda 4
deve tornar esse fluxo alcançável pela Via Rápida, corrigindo o selo
`same_checkout` de `mission-fast-lane.ts:1043` conforme F-563, sem permitir
que dois writers alterem o checkout de coordenação.

Critério final de religação: todos os leitores escolhem o par retornado por
`resolveMissionLeader`; os quatro escritores de eleição chamam
`applyLeadership` exatamente uma vez (`spawn`, `respawn`, `adopt`, `promote`),
criação usa `create`, teardown usa `releaseLeadership`, e split-brain falha
fechado com rollback verificável.
