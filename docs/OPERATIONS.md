# Operations

## Contract

Local-first desktop ops: project runtime SQLite, feature flags, mission driver modes (shadow/active), smoke packaging.

## Ownership

- Main bootstrap: `src/main/main.ts`
- Project runtime: `src/main/runtime/project-runtime-manager.ts`
- Feature flags: `src/main/feature-flags/`
- Doctor: `src/main/runtime/nexus-doctor.ts`

## Error flow

DB open failure → degraded mode for legacy global DB; project runtime fails closed.
Migration failure → transactional rollback + fault code.

## Limits

WAL busy_timeout 5s; LRU open runtimes; flag overrides file 0600.

## Espelho legível de missão

O SQLite continua sendo a fonte canônica. Para diagnóstico sem consulta ao
banco, cada missão aberta é projetada em
`<project-runtime>/missions/<mission-id>/`:

- `BOARD.md`: estado humano de milestones, workers, handoffs e eventos recentes;
- `status.json`: resumo estável para automação local;
- `events.jsonl`: últimos 100 eventos, somente com campos permitidos.

A projeção é derivada, nunca ingerida de volta. Escritas são atômicas, os
arquivos usam modo `0600`, diretórios usam `0700`, symlinks/escape são recusados
e texto autorado por agentes passa por redação antes de sair do SQLite. Ao
reabrir um scope após restart, arquivos ausentes são reconstruídos. Falha no
espelho é registrada, mas não invalida a mutação canônica da missão.

## Migration

See `INITIAL_PROJECT_MIGRATIONS` through `014-mission-events-command-blocks`.

## Rollback

Disable flags; restore `.bak` for MCP hub configs; leave empty new tables.

## Soak antes de default-on (política)

Lição da wave de 2026-07-13 (intent-first + mission driver): as bordas de uma
feature autônoma aparecem em horas — 6 dos 9 fixes noturnos corrigiam defaults,
segundas portas de entrada, ordem de efeitos e estado global novo, não lógica.

Regras para qualquer capability que **muta estado sem clique humano** (driver
ativo, recovery, auto-merge, journal ACK, novos gates):

1. **Nasce fail-safe.** O default do módulo puro é observação/negação
   (`defaultDriveConfig.mode === 'shadow'`, flags `defaultEnabled: false`).
   Ativação é decisão de runtime/settings, nunca constante de módulo.
2. **O default é pinado por teste.** Se o default mudar, um teste falha e a
   mudança vira decisão revisada (ex.: `mission-drive.test.ts` trava shadow;
   `src/shared/feature-flags.test.ts` trava default-off;
   `src/shared/settings-types.test.ts` trava os defaults de produto das orch
   settings).
3. **Um ciclo de soak entre merge e default-on.** Feature nova roda ≥1 ciclo
   de dogfood em shadow/flag-off com journal/telemetria ligados antes do flip.
   O flip de default é um commit próprio, pequeno, com changelog.
4. **Inventário de entradas.** Antes do default-on, listar TODAS as portas que
   alcançam o efeito (MCP dispatch, PTY spawn, IPC renderer, voz, cron) e
   confirmar que cada uma atravessa o mesmo gate — a wave vazou pelo spawn PTY
   (`9fb20ae`) exatamente por pular este passo.
5. **Orçamento reserva antes do efeito.** Budget/slot é reservado e persistido
   antes do side effect (`reserveEffectfulSpend`, `reserveWorkerSpawnSlot`),
   nunca contabilizado depois.

## Metrics

Startup/shutdown via existing perf IPC; mission driver tick counters.

## Doctor: execução multi-PC

O bootstrap deriva a promessa de execução compartilhada dos backends reais:
sem lease e sem sync, a instalação é single-device e as ausências são warnings.
Se qualquer backend compartilhado estiver configurado, o Doctor exige o par
lease+sync e mantém a ausência complementar como blocker.

## How to test

```bash
npx vitest run src/main/runtime/project-runtime-manager.test.ts
npm run typecheck
```
