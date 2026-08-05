# PTY Supervisor: fix do loop fail-closed (Etapa 1, P1) + rewrite Rust (Etapa 2, P2)

**Data:** 2026-08-05 · **Status:** spec pronto para implementação · **Contexto:** é o irmão NATIVO da família quit-hang corrigida hoje no lado Electron (76d405d1 `fix(pty): escalação SIGTERM→SIGKILL limitada na prova de término` + a78dbc21 `fix(lifecycle): quit com deadline global e backstop app.exit`).

## Evidência de campo (2026-08-05, esta máquina)

Diagnóstico completo feito ao vivo durante o gate da 0.26.0:

- **10 processos `nexus-pty-supervisor` zumbis**, cada um a ~12-16% CPU constante:
  - 8 órfãos do gate E2E (ppid=1, sem filhos, stdio revogado, binário deletado junto com o tmp dir do gate);
  - **2 da release instalada anterior, vivos desde 04/08 09:25 — 1d8h de CPU queimada** com `/Applications/NexusIDE.app` nem rodando.
- **`sample(1)` no pid 2554 confirmou o local exato do spin**: main thread em `terminate_and_prove_responsibility_group` → `inventory_owned_processes` → `responsibility_get_pid_responsible_for_pid` (libquarantine), alternando com `nanosleep` de 20ms.
- **SIGTERM é ignorado na prática** (testado nos 2 zumbis de 04/08): o handler só seta `shutdown_signal`, que leva ao MESMO loop de prova sem saída. **Só SIGKILL resolveu.**
- O diálogo "Aguardando a finalização segura dos serviços" (`src/main/app-shutdown-ui.ts:32`) visto no screenshot do gate é o sintoma app-side do mesmo invariante.

### Causa-raiz (código)

`native/darwin-pty-supervisor/main.c`:

- **linhas 1336-1341** — design explícito: *"No timeout permits the supervisor to exit without proof… remaining alive fail-closed"*;
- **linha 1369** — a escalação é `for(;;)` cuja ÚNICA saída é `prove_group_empty_twice` (duas varreduras completas e vazias da tabela de processos inteira, separadas por 60ms, tick de 20ms — daí os ~15% CPU);
- **linhas 1357-1363** — inventário `incomplete` (qualquer pid inconsultável na varredura, ex.: race com processos efêmeros desta máquina cheia de agentes) mantém o processo vivo PARA SEMPRE.

O fail-closed é correto enquanto o app responsável está vivo e vai re-tentar. Ele vira defeito quando **o responsável morreu**: ninguém mais consome a prova, e o supervisor queima CPU eternamente.

---

## Etapa 1 (P1, pequena): timeout + escalação no main.c — espelhando 76d405d1

O fix Electron-side introduziu `escalateDarwinSupervisorTermination` (`src/main/pty/pty-host-core.ts`): SIGTERM → grace → SIGKILL → grace final → settle fail-closed **sempre resolve**, preservando "tempo decorrido não é prova" (o recibo exato ainda vence se chegar dentro das janelas). A Etapa 1 aplica a mesma filosofia DENTRO do supervisor.

### Mudanças

1. **Deadline global de prova** — novo `PROOF_DEADLINE_MS` (default 30_000; override por env `NEXUS_SUPERVISOR_PROOF_DEADLINE_MS` para testes). Começa a contar ao entrar em `terminate_and_prove_responsibility_group` (main.c:1343).
2. **Detecção de morte do responsável** — `kqueue`/`EVFILT_PROC` (`NOTE_EXIT`) no `anchor->responsible_pid` armado no início do modo supervisor; alternativa barata: checar `getppid() == 1` + `process_still_exists(responsible_pid)` a cada iteração do loop de prova. Responsável morto ⇒ encurtar o deadline restante para `TERM_GRACE_MS` (1,5s): não há mais quem consuma a prova.
3. **Comportamento ao estourar o deadline**, decidido pelo estado observado:
   - filho direto já colhido **e** as últimas N (=5) varreduras não viram NENHUM alvo vivo (apenas `incomplete` por pids inconsultáveis) ⇒ **exit com código sentinela novo `NEXUS_EXIT_PROOF_DEGRADED`** — distinto de sucesso (0): o stage0/host sabe que a prova é degradada, nunca a confunde com recibo canônico (mesmo contrato do `proofFromDarwinObservation` de 76d405d1: `rootExited=true, descendantsExited=false`);
   - existe alvo vivo identificado ⇒ continuar SIGKILL no cohort, mas com **backoff exponencial** no tick (20ms → dobra → teto 2s) em vez do spin de 20ms — elimina os ~15% de CPU mesmo no pior caso, e ainda persegue o alvo.
4. **Log estruturado do desfecho** em stderr (uma linha: motivo, alvos restantes, inaccessible_count) — hoje o "inventory incomplete" some no stdio revogado.

### O que NÃO muda (contrato)

- Exit `0` continua significando **prova canônica completa** — nenhum caminho novo retorna 0.
- A semântica fail-closed permanece enquanto o responsável vive e o deadline não estourou.
- `src/main/pty/pty-host-core.ts` (76d405d1) já trata saída não-canônica via `isProvenExit`; adicionar o mapeamento explícito de `NEXUS_EXIT_PROOF_DEGRADED` na tabela de recibos do host (`pty-host-entry.ts`) e no predicado do client.

### Testes

- Já existem ganchos `NEXUS_TEST_PRE_TERMINATION_PROOF_HOLD_MS` / `NEXUS_TEST_TRACED_AUTH_HOLD_MS` (main.c:80-86) e a suíte `scripts/darwin-pty-supervisor.test.mjs` + `src/main/pty/darwin-pty-supervisor.test.ts`.
- Novos casos: (a) cohort não-provável simulado (filho que spawna neto detached e morre) → supervisor sai com `PROOF_DEGRADED` dentro do deadline; (b) responsável morto → saída em ≤ TERM_GRACE_MS + margem; (c) alvo vivo real → SIGKILL com backoff, CPU do supervisor < 2% (assert via `ps -o %cpu` no teste de smoke); (d) recibo canônico ainda vence dentro do deadline (regressão do caminho feliz).

**Tamanho: S/M (1 arquivo C + mapeamento de sentinela no host + testes). Sem mudança de protocolo stage0.**

---

## Etapa 2 (P2): rewrite do supervisor em Rust

### Motivação

- Memory-safety num binário que roda disclaimed com autoridade de assinatura;
- **Mandato multi-plataforma do produto** (macOS/Windows/Linux — ver memória do projeto): o main.c é Darwin-only; a prova de cohort precisa de equivalentes por OS;
- Manutenibilidade: 2.381 linhas de C com FFI CoreFoundation/libquarantine.

### Escopo

Mesmo contrato observável do binário C (é o critério de aceite):

| Superfície | Contrato a preservar |
|---|---|
| CLI | `supervise`, `supervise-authenticated`, `supervise-*-smoke`, `inventory`, `provider-probe`, `__run-disclaimed*` (main.c:2347-2380) |
| Stage0 | wrapper perl -T intocado; mesmo handshake de argv |
| Prova | cohort por (responsible_pid, responsible_unique_id); duas varreduras vazias separadas = recibo; exit codes existentes + `PROOF_DEGRADED` da Etapa 1 |
| Assinatura | mesmo identifier/team; ad-hoc no dev, Team no empacotado; validação de cdhash selada |
| Plataformas novas | Windows: Job Objects (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` + query de membros = prova); Linux: `PR_SET_CHILD_SUBREAPER` + cgroup v2 (`cgroup.procs` vazio = prova) |

### Critérios de entrada (não começar antes de)

1. Etapa 1 estável em produção por **2+ releases** sem zumbi novo (verificável: sweep de supervisores órfãos no gate — ver `2026-08-05-release-gate-reforma.md` §3);
2. **Suíte de conformidade de protocolo** extraída do binário C (golden tests: cada modo CLI, cada exit code, transcript de prova) rodando contra AMBAS as implementações;
3. CI multi-OS ativa (o port Linux/Windows sem CI é letra morta).

### Riscos

- FFI de APIs privadas (`responsibility_get_pid_responsible_for_pid` / libquarantine) — mesmo risco do C, mas re-validar comportamento por versão de macOS;
- Assinatura/notarização de binário Rust no pipeline `make-release.mjs` (hoje assume o artefato do `build-darwin-pty-supervisor.mjs`);
- Tamanho: +2-3 MB vs C (aceitável; irrelevante perto do baseline de `electron-slim`);
- Regressão sutil de semântica fail-closed — mitigada pela suíte de conformidade (critério 2).

**Tamanho: L. Não iniciar dentro do ciclo 0.26.x.**
