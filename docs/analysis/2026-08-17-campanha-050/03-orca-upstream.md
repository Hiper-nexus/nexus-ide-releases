# Campanha 0.50 — Fase C: Orca upstream (stablyai/orca)

Data: 2026-08-18. Repo correto: `github.com/stablyai/orca` (MIT, 47.5k stars,
release diária — v1.4.184 em 17/08). Mesma stack (Electron + node-pty +
better-sqlite3). Já portamos: tui-agent-config, trust-presets, agent-hooks,
teardown safety — todos continuam lá.

Últimos 3 meses: 136 releases. Temas: daemon de terminais desacoplado,
orquestração/federation, campanha "truthful liveness", hang-watchdog em
worker thread, perf.

## Top 10 para portar (mapeado nas nossas fases A/B)

1. **Settlement idempotente de worker_done** (PRs #8030, #6317, #13927) —
   settle só pelo assignee certo (pane key + incarnation), `BEGIN IMMEDIATE` +
   compare-and-set (`UPDATE ... WHERE status='dispatched'`), replay
   pós-restart devolve `{settled, duplicate:true}` em vez de criar block.
   → **mata B1/A3** (handoff aceito-não-ackado no shutdown vira block
   falso). Esforço M. Arquivos: `orchestration/lifecycle-reconciliation.ts`,
   `worker-report-settlement.ts`.

2. **Circuit breaker de dispatch** (PR #13927) — `DISPATCH_CIRCUIT_BREAK_FAILURES
   = 3`; worker sumido conta; <3 → retry, ≥3 → `circuit_broken` com erro
   legível (fim do respawn loop). Guard de drift roda ANTES para não queimar
   budget. → **mata A1/A2** (13/20 mortos + 6× respawn do mesmo pane).
   Esforço P (lógica) / M (wiring). `dispatch-circuit-breaker.ts`,
   `worker-terminal-recovery.ts`.

3. **Liveness tri-state: live / exited / UNVERIFIABLE** (PRs #13928, #12574,
   #12578) — quando o daemon não consegue reportar, o veredito é
   `unverifiable`: "nunca colapse 'não sei' em 'morto'". → **mata a família
   deadlock cerca×fast-lane** (sessão fica no mapa até prova física; a cerca
   conta ANY session). Esforço M.
   `worker-terminal-process-liveness.ts` (~60 linhas).

4. **Log NDJSON do main + bundle de diagnóstico** — `userData/logs/
   main.trace.ndjson` com redactor, heartbeats (`renderer_memory`),
   breadcrumbs; bundle zippado p/ bug report. Foi o que diagnosticou a issue
   #7742 em produção. → **mata A7/B2** (zero log no empacotado). Esforço M —
   maior ganho por linha. `observability/{logs-directory,local-file-sink,
   instrumentation,tracer,redactor,bundle}.ts`.

5. **Heartbeat por dispatch com staleness warn-only** (PRs #4858, #8514) —
   cadência 5 min, hung = 2× cadence, AVISA nunca auto-faila; heartbeat
   gravado por dispatchId (atrasado de dispatch completo não mascara novo).
   → cobre A2 (36h muda). Esforço P/M.

6. **Reconcile de boot de workers legados** (PRs #11271, #12896, #13708) —
   startup lista dispatches `starting/ready/…/stop_unknown` e reconcilia um
   a um: terminal existe → re-anexa; sumiu → recovery do item 2. UMA passada
   SQL determinística, não poll. Esforço M.

7. **Hang watchdog da main thread em worker thread** (PRs #11488, #11344) —
   marker file em disco + telemetria; só no empacotado. → família keychain
   (main pendurada, timers mortos, IPC vivo). Esforço P. 7 arquivos pequenos.

8. **Harness e2e de sobrevivência** — Playwright+CDP no Electron real;
   build `--mode e2e` expõe `window.__store`, mas **assert SEMPRE no DOM**
   (regra escrita após tautologias passarem verde!); specs repro numeradas
   por issue + stress (`dead-terminal-stress.spec.ts`); suítes
   `win-crash-survival`, `win-update-survival`. → **blueprint da Fase D**.
   Esforço M.

9. **Invariante de dispatch único + gates que re-bloqueiam por tick** (PRs
   #12584, #12988, #13376) — decision gate pendente re-bloqueia a task a
   cada tick (restaura invariante em vez de confiar em evento); abandon é
   first-class (`disposition: abandoned/already_abandoned/stale`);
   `closeQuestionsForDispatch` no abandon. → famílias "elicitation não
   respondida trava" e "merge entry presa 22min". Esforço M/G.

10. **Daemon de PTY fora do main** — terminais sobrevivem a quit/update;
    protocolo de posse de endpoint (bind→link→provar morte→rename atômico);
    regras em `daemon/AGENTS.md` ("never collapse can't-tell into dead",
    "no sweeper"). → resposta arquitetural ao "grant nunca sobrevive a
    restart". Esforço **G** — pós-0.50; portar primeiro a SPEC do protocolo.

**Menções:** `durable-file-write.ts` + `quit-teardown-deadline.ts`
(durabilidade no caminho de quit — P, liga direto no B1); `pty-descendant-
termination.ts` (kill em árvore, M); `agent-awake-service.ts` (impede sleep
do SO com agente trabalhando, staleness 2h — P, missões noturnas).

## Issues deles que espelham as nossas dores

- #14854 (open): agente em prompt interativo indistinguível de trabalhando.
- #14905 (open): `orphaned:true` indistinguível de crash, sem exit cause.
- #11006: PTY vivo tratado como morto no disconnect → respawn duplicado.
- #9030/#9878: rows mortas por 30min pós-restart do daemon.
- #7742: crash de renderer orfã PTYs — diagnosticado pelo main.trace.ndjson.
