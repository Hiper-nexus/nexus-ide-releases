# Plano item 5 (cadeia/espera) + ressalvas do F-1471 — conferido em rel252 `d3de362d3` (Claude Opus, somente leitura)

Prefixos: `F` = `src/main/orch/failover.ts`, `T` = `failover.test.ts`, `CS` = `failover-cli-switch.test.ts`.

## (b) Conta medida em 100% nunca é escolhida (fazer primeiro)
- Bug: `account-select.ts:91` sem conta ativa devolve `ranked[0]` mesmo esgotada; `:95` com ativa e sem irmã livre devolve a ativa; `pickAvailableForFailover` (`account-store.ts:1265-1327`) só filtra cooldown (`:1275-1278`).
- Mudança: opção `rejectExhausted?: boolean` em `FailoverPickOptions` (`:1240`); com ela, `free` exclui `isHeadroomExhausted(quotaByAccountId.get(id))` quando a janela cheia tem `resetsAt` desconhecido ou > `now`. Essas contas entram em `nextUnblockAtMs` (`:1289-1301`): `resetsAt` da janela cheia; sem reset conhecido, `now + 15 min`. `headroomInputsByAccount` (`account-headroom.ts:193`) passa a levar `updatedAt`. Ligar só nas chamadas `F:1493` e `F:1562` (o spawn de `provider-config-store.ts:1618` mantém "abre na ativa e avisa").
- Testes (`account-store.test.ts`): irmã medida 100% sem cooldown não é escolhida e define nextUnblockAtMs = resetsAt; janela cheia com resetsAt vencido volta a valer.

## (a) Cadeia A→B→C sem pausa quando há irmã com folga medida e fresca
- Hoje: sonda sem resposta → pausa capada de 15 min na mesma conta (`F:3018-3049`, `confirmLimitByProbe`).
- Antes do `setCooldown` de `F:3028`: helper `freshSiblingWithHeadroom(adapterId, current.id, probedAt)` (usa `quotaHeadroomFor`; exige `updatedAt` ≤ 10 min (`REFUTE_FRESH_MS`), todas as janelas < 0,8, nenhuma `confidence:'low'`). O limite precisa ter encerrado o turno: `getSessionState` idle e nenhuma saída depois do hit (`paneSessionLastOutputAt`, critério de `delegation-supervisor.ts:1296`) — texto citado em turno ativo não troca (preserva F-249). Com as duas: cooldown capado de 15 min em A + `performSwitch({..., excludeId: current.id, unconfirmed: true, siblingOnly: true})`. Novo `siblingOnly` em `SwitchRequest` (`F:685`): `planCliSwitch` (`F:814`) segue `none` (texto não confirmado não troca de CLI); guarda `F:1811` vira `(!req.unconfirmed || req.siblingOnly)`.
- Testes: `T` após `:523` "sonda sem resposta + irmã fresca 30% + turno encerrado → troca já para account-b; A só 15 min; sem troca de CLI" (hoje switched:false); variante com saída nova depois do hit não troca; `CS` bloco F-1471 (`:472`) "A→B→C: B bate e a tarefa reabre em C sem pausa".

## (d) Teto do retry por tempo
- Hoje `MAX_SCHEDULED_RETRIES = 8` (`F:139`, usado em `:1405`), piso 30 s (`:1855`) → espera morre em ~4 min.
- Trocar por `MAX_RETRY_WAIT_MS = 24 h`; `SwitchRequest.retryDeadlineAtMs` fixado no primeiro agendamento e propagado por `fireScheduledRetry` (`F:1882`); backoff quando o alvo passou e nada libera: `min(30 s·2^(n-1), 15 min)`; na expiração, recibo `switched:false` + aviso ao Maestro.
- Teste: reescrever `T:1166` (depois de 8×30 s ainda agendado; só depois de 24 h `scheduledRetryAtMs` undefined).

## (c) O retry sobrevive ao reinício
- Hoje `pendingRetries` só em memória (`F:166`); shutdown cancela (`F:3284`); saída da sessão também (`F:3256`).
- Tabela `failover_waits` no DB de `account_cooldown_blocks` (`account-store.ts:177`), chave `pane_id`: `mission_id`, `scope_key`, `adapter_id`, `account_id`, `lineage_id`, `kind`, `retry_at`, `deadline_at`. Gravar em `scheduleFailoverRetry`; apagar no fire, no sucesso ou quando a missão sai de `running`. `tapSessionExit` NÃO apaga quando a saída é shutdown. Rearmar no boot por escopo, no callback `onScope` (o mesmo de `delegation-supervisor.ts:2028`), recalculando `retry_at` pelos cooldowns persistidos.
- DECISÃO DO ORQUESTRADOR (tomada): `shouldSkipLeftoverRemount` (`shared/mission-leftover-isolation.ts:233`) continua valendo — missão leftover-parked NÃO remonta sozinha; o rearm entrega o fato ("conta X libera às HH:MM; o pane P esperava") no Retomar do operador e no recap. Missão running rearma sozinha.
- Teste (`failover.test.ts`): "retry sobrevive a restart" (`shutdownFailover` → `initFailover` com DB em memória → avançar tempo → `performSwitch` na missão viva).

## (e) Poll das contas inativas no Main
- Hoje só o renderer (`quota-store.ts:134-140`, 5 min, janela visível).
- Novo `src/main/quota/mission-quota-poll.ts`: `setInterval` 5 min com `unref` e um único voo; só roda se `listPaneSnapshots().some(p => p.missionId && p.state !== 'exited')`; chama `requireQuotaService().snapshot(Date.now())` NÃO forçado (`quota-service.ts:415`, TTL 60 s `:53`, backoff 5 min, limite de concorrência). Iniciar em `main.ts:872` depois de `initQuotaService`; parar em `shutdownQuotaService`.
- Testes `mission-quota-poll.test.ts`: sem missão nenhuma chamada; com missão 1 por tick; tick com anterior em voo não empilha.

## (f) Retry na mesma conta com sessão viva vira "continue"
- Hoje com `crossAccount=false` (`F:1617`) o pane de missão no renderer cai no `emitFailover switched:true` genérico (`F:1818`) e o renderer ignora; headless respawna com sessão nova (`F:1642`).
- Logo após `F:1617`: se `!crossAccount && req.attempt > 0 && authority.missionId` e a sessão está viva (idle/busy), `nudgeTransientContinue` (`F:2386`) e `return`; recibo `nudged`. Prompt neutro (`TRANSIENT_CONTINUE_PROMPT`, `F:222`).
- Teste `T` bloco `:1080`: "retry volta à própria conta: injectPrompt na mesma sessão, nenhum switched:true".

## (g) Ressalvas da revisão final do F-1471
1. Writer sem pane em dupla falha: hoje `F:1405` pula o retry com `paneGone` e `:1456` manda resume manual. Novo mapa `pendingTaskReopens` por `paneId`, com o handle (guardado na falha, `F:2645`), não cancelado por `tapSessionExit`; no fire: novo pick com `rejectExhausted` → `reopenTaskOnSiblingAccount` com o handle, ou o plano de troca de CLI. `hasPendingFailoverRecovery` (`F:1159`) consulta esse mapa. Teste: reescrever `CS:697` (espera `scheduledRetryAtMs` definido e, depois do timer, `reroute` com `sameAdapter`).
2. Supervisor/corrida: em `delegation-supervisor.ts:1335`, `forgetPaneTaskReroute` ANTES de `requestPaneClose` (handle em local, re-registro se o close falhar); depois do await (`:1337`) reconfere `hasPendingFailoverRecovery` e aborta. Teste em `delegation-supervisor-start.test.ts`: retry de failover disparando durante o close não gera dois `reroute`.
3. Marcação antes do heal/prepare: mover `siblingReopens.add` e `forgetConfirmedPaneLimit` (`F:1242-1245`) para o início de `performSwitch` (`F:1461`), antes de `healClaudeSecondaryBeforePin` e `prepareFailoverAccount`, quando `authority.missionId`; liberar em try/finally. Separar o dedupe de `F:1225` em `switchInFlight` e `reopenInFlight`. Teste: com prepare pendente, `hasPendingFailoverRecovery` true.
4. Teto 3/h: `switches.push(now)` (`F:1241`) só depois de `outcome.ok`; mutex por `lineageId` checado junto com `F:1230`. Testes `CS`: recusa não consome o teto; duas reaberturas concorrentes da mesma linhagem → um só `reroute`.
5. `missionOwnsPane` null: em `F:1812`, `=== true` vira `!== false`; com null, `refuseMissionPaneSwitch(req, next, 'o Nexus não conseguiu ler a missão')` em vez do recibo genérico de `F:1818`; catch em `F:1178`. Teste `CS`: store lança → `switched:false` e Maestro avisado (hoje switched:true).

## Ordem que evita conflito
(b) → (g) → (a)/(f)/(d) → (c)/(e). O F-1473 (resume nativo entre contas) e o F-1482 (pedido em voo) vão ser integrados na release/0.76.252 em paralelo e mexem em `performSwitch`, `reopenTaskOnSiblingAccount`, `PaneTaskRerouteRequest` e no pack — quando o orquestrador avisar, rebaseie sobre a release atualizada e resolva.
Os testes "que falham hoje" foram deduzidos do código pelo planejador; confirme o RED você mesmo.
