# Campanha 0.50 — Fase A: evidência das missões reais

Data: 2026-08-17 (noite). Fonte: leitura read-only dos `runtime.sqlite3` reais
do app empacotado (`~/Library/Application Support/NexusIDE/project-runtime/`)
das duas missões que o usuário reportou. Nenhuma escrita.

## Missão 1 — HiperGO "code review por etapa" (mission-865956d2)

36 HORAS de wall-clock (16/08 10:00 → 17/08 22:40). Journal com 5.529 eventos.

### Achados

**A1 — Mortalidade de worker: 13 de 20 panes nunca completaram UM turno.**
`observer.session_spawned` ×30 vs `observer.turn_ended` ×17. Onze panes com
1 spawn e 0 turnos ("nasceram mortos"); dois panes respawnados 6× cada
(pane-msvt8lha-4: 6 spawns/1 turno; pane-msvub3yc-6: 6 spawns/0 turnos).
Roster multi-adapter (glm-5.3, codex gpt-5.6-sol, deepseek-v4-pro, kimi-k3) —
não é adapter específico.

*Gap de observabilidade:* o journal não tem NENHUM evento explicando por que
um worker morreu entre spawn e primeiro turno. `task_dispatch_queue` está
VAZIA (fast-lane é PULL via `nexus_pane_spawn` do Maestro; as tabelas do
pipeline guiado são schema morto convivendo no DB). O diagnóstico hoje é
impossível: não há lifecycle de worker (boot/erro/exit) no journal.

**A2 — Maestro ocioso em 15 episódios (25, 31, 54 min…).**
`chef_idle_awaiting_workers` ×246. O watchdog de 30 min (0.32.29) é paliativo:
o problema é o Maestro esperar workers que nascem mortos e não aprender
com a mortalidade (respawn 6× do mesmo pane com o mesmo resultado).

**A3 — O trabalho FOI entregue e a missão morreu "blocked" mesmo assim.**
handoff-1c5341ac (17 22:35, status success): *"Consolidei e revalidei os
sete code reviews no HEAD atual"* — a consolidação final PRONTA. Delivery
attempt `accepted` às 22:35. O ack do orquestrador nunca veio (quit do
operador 22:38) → missão termina blocked com "Handoff não entregue. Clique
em Reabrir…". **O usuário lê FALHA onde houve sucesso.** Este é o núcleo da
queixa "missão não vai do início ao fim": ela foi, mas o desencaixe
entrega→ack→conclusão na janela de shutdown fabrica um bloqueio falso.

**A4 — handoff de progresso `stalled` por 16h** (handoff-3c009643, 17 06:29,
nunca consumido) sem escalonamento nem descarte.

**A5 — delivery attempts mostram retry failed→accepted** funcionando (2
tentativas), mas a primeira falha não vira evento de journal — invisível.

## Missão 2 — saasbarbearia "tennant tesoura de ouro" (mission-ea2dc9c0)

Journal 662 eventos. Orquestrador TRABALHANDO no fim (tool_call Bash, 5
sessões spawnadas, 2 turnos completos). Terminou blocked_user por quit do
operador (runtime-closed, design correto).

**A6 — sentinela de HEAD disparou 8× `external-head-change`** durante a
missão. Os commits subsequentes no repo (git log: "fix(ui): contraste
reprovado…" nos últimos 53 min, autor cleofasvolarehost) são trabalho de
missão/agente no mesmo_checkout. Ou a sentinela não atribui o commit do
próprio worker da missão (falso positivo custando turno do Maestro para
"revalidar"), ou o usuário tinha processo paralelo no mesmo repo — em ambos
os casos o aviso é ruído não-acionsável 8× seguidas.

## Achados sistêmicos (transversais)

**A7 — Sem log persistente do main no app empacotado.** stdout do Finder é
descartado; não existe main.log. Pós-mortem depende 100% do DB — e o DB não
registra lifecycle de worker (A1). Qualquer investigação noturna começa cega.

**A8 — schema morto no runtime DB** (tabelas do pipeline cerimonial
removido ainda presentes) — confunde diagnóstico e infla migrações.

## O que isto implica para as fases seguintes

- **B (Overclock/bridge):** comparar o pane_spawn prompt-at-birth +
  fallback mecânico multi-CLI deles com nosso PULL; a mortalidade A1 é onde
  o modelo deles não deixa worker morrer invisível.
- **C (Orca upstream):** teardown safety / agent-hooks / observabilidade de
  lifecycle que a comunidade já consolidou.
- **D (auto-teste):** o harness PRECISA reproduzir o padrão A1 (worker
  nasce morto) e o A3 (quit na janela do ack) — são os dois bugs que fazem
  o usuário dizer "não vai do início ao fim".
- **Fixes candidatos diretos (0.50):**
  1. Lifecycle de worker no journal (spawn→boot→primeiro_turno→exit com
     causa) — mata A1/A7.
  2. Reconcile de shutdown: handoff success+accepted no boot seguinte vira
     consumo/conclusão, não block (mata A3).
  3. Handoff stalled com TTL + descarte escalonado (mata A4).
  4. Sentinela de HEAD atribui commits do próprio checkout da missão como
     internos (mata A6).
  5. Teto de respawn por pane com troca de rota após N mortes sem turno
     (mata a parte "6× o mesmo pane" de A1/A2).
  6. Drop do schema morto (A8).
