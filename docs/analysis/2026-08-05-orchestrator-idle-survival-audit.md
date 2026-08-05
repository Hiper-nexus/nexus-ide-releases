# Auditoria: sobrevivência do orquestrador ocioso (medo: "ele dorme e morre")

**Data:** 2026-08-05 · **Veredito: o mecanismo temido NÃO existe no Nexus.** O modelo já é o do Overclock (push, sem espera em processo, sem ceifa de ocioso), com DOIS gaps reais de severidade menor, ambos já especificados.

## Os 5 pontos do modelo Overclock × Nexus (file:line)

| # | Overclock | Nexus | Veredito |
|---|---|---|---|
| 1 | Orquestrador nunca espera em processo; delegou → encerra o turno | Prompt de kickoff proíbe polling explicitamente ("não faça polling…", `src/shared/mission-dispatch-kickoff.ts:233,245,254,343`); waits de pane são transitórios e CAPADOS por chamada (`PANE_WAIT_TIMEOUT_CAP_MS`, `src/main/orch/tools-panes.ts:61` — ~35s) | ✅ equivalente |
| 2 | Wake é PUSH (handoff digitado no input do orquestrador) | Outbox durável de handoffs + entrega no idle do Maestro: `handoff-delivery-outbox.ts:9` (reconcile 1s), `idle-delivery.ts` (`onHandoffSubmitted`), injeção via lane orquestrada (`mission-kickoff.ts:1102` → `orchWriteSession`) | ✅ push |
| 3 | Stop-hook impede worker de parar sem handoff | Pós-hoc, não pré-exit: saída sem handoff vira bloqueio nomeado `worker-no-handoff` (`mission-block-cause.ts`) + `TASK_DISPATCH_MISSING_RUNTIME_REASON` + reroute P0-4 | ⚠️ GAP-2 (P2) |
| 4 | Losslessness: resultado coletável depois (handoff_list) | Outbox é DURÁVEL (submit grava antes de qualquer enqueue); crash → `recoverAcceptedSchedulerHandoffDelivery`; 2 tentativas (`MAX_HANDOFF_DELIVERY_ATTEMPTS`, `handoff-delivery-policy.ts:2`) e depois CTA visível `[NEXUS_HANDOFF_REBIND_BLOCKED]` com Retomar | ✅ lossless |
| 5 | Heartbeat fallback longo, nunca poll | Reconcile main-owned de 1s sobre o outbox (main é quem olha, não o orquestrador — custo zero de contexto) | ✅ |

## Nenhum ceifador alcança orquestrador ocioso (eixo c — o medo em si)

- **Idle timer de sessão só marca ESTADO**, nunca mata: `pty-manager.ts:715-725` (`session.state = "idle"` + emit; zero kill).
- **stall-watchdog é worker-only por construção**: `stall-watchdog.ts:73` (`if (c.role !== 'worker') return false`), `:99`, `:165`, `:315`.
- **TTL de hoje (568c1324) é "TTL de WORKER pós-handoff"** — orquestrador fora do alvo (o bug do chefe ceifado é do OVERCLOCK, anti-requisito).
- **delegation-supervisor só age com ZERO delegação** (kickoff que nunca criou task/worker): `delegation-supervisor.ts:19-22` e o guard `if (progress.workerPanes > 0 || progress.tasks > 0) return 0` — Maestro com trabalho delegado é intocável por ele, ocioso por horas.
- **login-stuck-watchdog**: só login. **Replacement exclusivo**: só quando NOVA missão spawna orquestrador concorrente (by design).

## Gaps reais

| Gap | Severidade | Estado |
|---|---|---|
| **GAP-1 — revival não é isento de spawn-cap**: recuperação de pane morto conta pane MORTO contra o orçamento vivo; a plataforma pode NEGAR a recuperação do próprio chefe (lição width_cap de 05/08, no Overclock). Não é ceifa — é recusa de ressurreição | **P1** | JÁ especificado como P1-0 slice 4 no dossiê (`nexus_pane_revive` cap-exempt; `countLiveMissionWorkerSlots`, `pane-limits.ts`) — implementar no ciclo |
| **GAP-2 — sem garantia pré-exit de handoff no worker** (equivalente do Stop-hook): a detecção é pós-morte. Cobertura atual (bloqueio nomeado + reroute + outbox durável) torna a perda visível e recuperável, não silenciosa | **P2** | Spec curto: gancho de exit no adapter do worker que, sem handoff registrado, injeta prompt final "entregue o handoff (done/blocked) antes de sair"; 1 tentativa, depois segue o fluxo atual |

## Classe announce-without-dispatch — coberta, com prova de campo (05/08 22:19Z)

Orquestrador que ANUNCIA a próxima ação e encerra o turno sem despachar parece idle saudável por fora. O Nexus já re-dispara: o mission-driver detecta "missão sem progresso há 10 min" e ENFILEIRA um handoff de recuperação durável entregue no idle do Maestro (mesma lane push). **Provado ao vivo na missão mission-3be48989**: handoff "Recuperação de orquestração (sistema Nexus)" submitted 22:19Z → o Maestro acordou, selou o plano de 8 tasks e despachou t1 (heartbeat fresco no runtime.sqlite3 minutos depois). Cobertura existente = watchdog re-fire; nenhum P0 novo.

## Resposta direta ao medo

"O orquestrador fica parado tempo demais e morre" — **não no Nexus**: parado = sessão idle sem timer letal; o handoff chega por push quando ele está idle; se o app cair, o outbox re-prova a entrega na volta; se o PANE dele morrer por causa externa, `respawnWithResume`/reopen recuperam com contexto (receita purge+resume validada 9x em 05/08). O risco real e já ranqueado é o GAP-1: a recuperação poder ser negada por contagem de cap — P1-0 slice 4.
