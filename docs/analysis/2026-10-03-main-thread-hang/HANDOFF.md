# F-764 — Main thread do Nexus trava 90 s+ sob carga de missão: achar a causa e blindar

Pedido do operador. Objetivo: o processo principal do Nexus **nunca** pode ficar
bloqueado a ponto de congelar a UI. Duas frentes, nesta ordem:
(1) achar e corrigir a causa deste travamento com profile real, não com chute;
(2) blindagem estrutural para que nenhum loop/varredura/chamada síncrona volte a
segurar a main thread por mais que um orçamento curto.

Evidências brutas em `docs/analysis/2026-10-03-main-thread-hang/evidence/`.

## 1. O que aconteceu (fatos medidos, 03/10, v0.76.188)

- 11:41:37 a main thread parou (último heartbeat). O watchdog marcou
  `main-thread-hang` 95,8 s. Voltou por ~5 s às 11:43:47 (gravou
  `pty-grid-drift` e um spawn `agy` com `ok:false`) e travou de novo às
  11:43:52 — às 11:47:22 já eram 210 s sem heartbeat. Não é um evento único:
  é bloqueio longo repetido.
- Processo principal (`nexus-ide`) a 100% de CPU, estado R. Renderer a 3,7%
  (ocioso, esperando IPC do main) → UI congelada.
- `sample` do macOS na main thread (dois momentos, `sample-main-1141.txt` e
  `sample-main-1146.txt`): 98% das amostras dentro de **um único**
  `node::InternalMakeCallback` → código JIT (JavaScript). Sem syscalls de I/O.
  Frames nativos que aparecem por baixo: `allocate_managed_buffer`,
  `Uint8Array::New`, `String::WriteOneByte`, `memset`/`memmove`, `mprotect`
  (GC). Padrão de conversão string ↔ Buffer / alocação em loop.
- Último evento do trace antes do primeiro bloqueio: `worker-hung` do pane
  `pane-mushc0a8-1q` (muse, 20 min parado) às 11:41:36.980 — 61 ms antes do
  último heartbeat. Pode ser coincidência; não está provado.
- **Não é falta de RAM**: `kern.memorystatus_vm_pressure_level = 1` (normal).
  Mas a máquina estava carregada: swap 9,2/10 GB, RSS do main caiu de 450 MB
  para 104 MB (páginas comprimidas).
- Carga no momento: 102 processos na árvore do Nexus, ~6 GB RSS, ~15 CLIs de
  agente (4 claude, 4 codex, kimi, grok, 2 muse, 2 devin, mimo, agy). O `agy`
  ficou ~19 min a ~200% de CPU. Ao mesmo tempo, agentes rodavam **dois**
  `npm run typecheck` (`tsc --noEmit --max-old-space-size=4096`, ~720 MB cada)
  e um `vitest`.
- Não deu para ver a stack JS: o fuse `EnableNodeCliInspectArguments` está
  desligado (SIGUSR1 mataria o app) e o watchdog só grava a duração. **Essa
  cegueira é o primeiro defeito a corrigir.**

## 2. Hipóteses (nenhuma confirmada — confirmar com profile antes de mexer)

- **H1 — hot path de PTY no main.** Todo chunk de todos os agentes passa por
  `onSessionData` (`src/main/pty/pty-manager.ts:1090`) e dispara 12 taps
  síncronos via `fireTaps`: `detect/detector.ts:454`,
  `terminal/command-block-tracker.ts:78`, `orch/mcp-server.ts:1842`,
  `orch/pane-registry.ts:972` (+ `devServerScanner`), `orch/pane-pipe.ts:473`,
  `orch/failover.ts:1841`, `orch/paste-ingest.ts:140`,
  `orch/tool-util.ts:793` e `:1084`, `orch/token-speed-tracker.ts:276`,
  `orch/cost-tracker.ts:189`, `remote/remote-output-bus.ts:62`. Com 15 agentes
  e um deles inundando saída, os frames de string/Buffer batem com esse caminho.
- **H2 — tick do delegation-supervisor.** `reconcileDelegationSupervisor`
  (setInterval `DELEGATION_SCAN_MS`) → `notifyHungWorkerPanes` →
  `handoffs.submit` → `onHandoffSubmitted` (`orch/idle-delivery.ts:1311`). O
  início do bloqueio coincide com o `worker-hung`.
- **H3 — regex catastrófica ou varredura O(n²)** sobre janela acumulada
  (buffers do detector, janela do failover, `stripAnsi` em texto grande,
  manifests de detecção).

Bloqueios secundários já visíveis no código (não explicam 90 s, mas seguram o
main por segundos e entram na blindagem):

- `materializeGitWorktree` (`runtime/worktree-cow.ts`) chama `git worktree add`
  e um `git check-ignore` por diretório via `ProcessGitRunner` (síncrono;
  existe `AsyncProcessGitRunner` ao lado). O trace mostra `gitWorktreeMs` de
  2–3 s e `writer-isolation` de até 19,6 s por spawn de worker.
- 37 arquivos em `src/main` usam `spawnSync`/`execSync`/`execFileSync`.

## 3. Entregas

### A. Enxergar primeiro (instrumentação)

1. **Watchdog que captura a stack JS durante o hang.** Na worker do watchdog,
   `inspector.Session` + `session.connectToMainThread()`. Quando o gap passar do
   limiar: `Profiler.enable` + `Profiler.start` por ~3 s e `Profiler.stop`
   (ou `Debugger.enable` + `Debugger.pause` para pegar `callFrames` e
   `Debugger.resume` em seguida). Gravar `logs/main-hang-<ts>.cpuprofile` e as
   frames (função, URL, linha) no marker. Validar em **build empacotado** com o
   fuse de inspect desligado — se o inspector in-process não funcionar ali,
   documentar e propor alternativa (ex.: `Profiler` contínuo de baixa
   frequência no main com dump quando ele voltar a responder).
2. Marker com histórico: `main-hang.ndjson` em append (hoje é sobrescrito e
   perde os hangs anteriores), com últimos eventos do trace, bytes/s de PTY por
   sessão e quais intervals estavam ativos.
3. Métricas contínuas: `perf_hooks.monitorEventLoopDelay` no trace (p50/p99/max
   a cada 30 s) e contabilidade de tempo por tap em `fireTaps` — trace quando um
   tap passar de 50 ms ou um chunk de 100 ms, com o nome do tap.

### B. Reproduzir e corrigir a causa

1. Harness de stress: 15 sessões PTY falsas, uma inundando ≥5 MB/s (simulando o
   `agy`), supervisor rodando, spawns de worker em paralelo. Rodar com profile.
2. Corrigir a função quente que o profile apontar. Registrar a causa real neste
   doc (substituir as hipóteses).

### C. Blindagem estrutural (o "nunca mais")

1. **Hot path de PTY com orçamento:** coalescer chunks por sessão (flush a cada
   16–50 ms) e entregar lote aos taps; taps de análise (detector, failover,
   `stripAnsi`, scanners) saem do main para worker thread ou para o pty-host
   (utilityProcess). O main recebe eventos já detectados.
2. **Backpressure por sessão:** sessão acima de X KB/s → taps de análise passam a
   olhar só o tail limitado; UI segue pelo replay. Trace `pty-flood` com a sessão.
3. **Regex e varreduras limitadas:** toda varredura sobre janela de tamanho fixo
   (padronizar o que o failover já faz com `WINDOW_CHARS`). Teste que roda cada
   regex de detecção/manifest contra 1 MB de entrada adversarial com teto de
   tempo.
4. **Tarefas periódicas com orçamento:** todo `setInterval` do main com guarda de
   reentrância e orçamento por tick (ex.: 20 ms) — estourou, cede com
   `setImmediate` e continua no próximo tick; trace quando estourar.
5. **Zero `*Sync` pesado no main:** worktree/check-ignore para
   `AsyncProcessGitRunner`; regra de lint (`no-restricted-syntax`/import) que
   proíbe `spawnSync`/`execSync`/`execFileSync` em `src/main` fora de uma
   allowlist justificada.
6. **Concorrência de carga pesada:** semáforo no Nexus para comandos pesados
   disparados por agentes do mesmo projeto (ex.: um `typecheck` por vez) e teto
   de workers simultâneos considerando RAM livre/swap.
7. **Main lento não pode ser silencioso:** o renderer pinga o main por IPC; sem
   resposta em 10 s, mostra faixa "Nexus ocupado — capturando diagnóstico" em
   vez de congelar mudo. Sem auto-kill (doutrina do watchdog mantida).

## 4. Critérios de aceite

- Harness de stress no CI: event-loop lag p99 < 100 ms e bloqueio máximo < 1 s,
  sem marker de hang.
- Hang induzido em build empacotado (loop de 40 s no main) gera `.cpuprofile`
  com stack JS legível apontando a função.
- Spawn de worker não bloqueia o main por mais de 100 ms (medido com
  `monitorEventLoopDelay` durante o spawn).
- Lint falha se entrar `*Sync` novo de processo em `src/main`.
- Este doc atualizado com a causa real confirmada pelo profile.

## 5. Causa confirmada (03/10, 12:40) — substitui as hipóteses da seção 2

**H1 + H3, confirmadas.** O main não estava preso numa chamada infinita: estava
atolado numa FILA de mensagens de PTY em que cada uma disparava uma varredura
cara na tap de dados do failover.

Como foi provado (sem stack JS: o app é Developer ID + hardened runtime, sem
`get-task-allow`; `lldb` e injeção estão fora, e só o `sample` da Apple lê
memória):

1. `vmmap` do PID: `0x157dc0000–0x157fcc000` é o blob de builtins do V8
   (mapeado do Electron Framework); `0x150000000–0x157dc0000` é código JIT.
2. Rodando o Electron **oficial 43.7.4** como node com `--log-code`, o blob cai
   no mesmo endereço, então os builtins resolvem por endereço:
   `0x157dda9b0` = `RegExpPrototypeExec`+0x270; também aparecem
   `StringPrototypeSearch`/`RegExpSearchFast` e `RegExpPrototypeTestFast`
   chamados pela mesma função JIT.
3. Em todas as amostras (11:41, 11:46, 12:04, 12:25 — esta com os agentes
   pausados por SIGSTOP), 95–99,5% do tempo está em código JIT **folha**
   chamado por `RegExpPrototypeExec`, espalhado em ~25 KB (vários objetos de
   regex), a partir de UM ponto de chamada de uma função F; F tem um segundo
   `.exec` (0,15%), um `.search` e um `.test`. F é chamada por uma chamada
   indireta que também chama outras funções (o `for (const tap of taps)` do
   `fireTaps`). Não há `uv_run` no caminho: o callback vem de task do Chromium
   (mensagem do pty-host via utilityProcess).
4. Esse formato é exatamente `detectLimit` (`src/main/orch/limit-detector.ts`):
   laço `pattern.re.exec(text)` sobre `PATTERNS`, depois o laço de
   `classifyRateLimitText` (2º `.exec`), `.search(/\s*[:=-]\s*/)` e `.test`.
5. Medido no módulo real (`node --import tsx`): uma janela de 4 KB de tela de
   TUI em branco custava **301 ms**; caixa `│…│` 21 ms; moldura `⎿` 20 ms;
   4 KB de espaço sem quebra 18 ms (1 s com 16 KB). Culpados:
   - `^[\s⎿│]*(?:claude|error:?)?\s*usage limit reached…/im` (e os irmãos
     "reached your … limit" / "hit your … limit"): `[\s⎿│]*` atravessa `\n` e
     disputa os espaços com o `\s*` seguinte; com `/m`, cada `\n` dentro da
     sequência de brancos é outro `^` → cúbico.
   - `\s*[:=]?\s*` nos padrões 401/402/429/5xx (limit-detector, classify,
     failover-handoff) e o prefixo `^[ \t]*[│┃⎿…]?[ \t]*` do classify →
     quadráticos em linha longa de espaço.
   - `candidate.search(/\s*[:=-]\s*/)` → quadrático.
6. Mecânica do travamento: o failover varre a janela de 4 KB a cada chunk
   (debounce de 250 ms pelo relógio de parede). Com o main atrasado, todo chunk
   já passou dos 250 ms → toda mensagem paga uma varredura de ~300 ms. O
   pty-host posta cada chunk do node-pty como mensagem separada, sem lote nem
   backpressure, e TUIs repintam sem parar → a fila cresce mais rápido do que
   esvazia. Pausar todos os agentes por 3 min não destravou (fila de dezenas de
   milhares de mensagens). Bate com a cronologia: travou com ~15 CLIs, voltou
   quando panes saíram (11:51–11:57) e recolapsou ~2 min depois de dois workers
   novos.

**Correção (0.76.191):** padrões reescritos em tempo linear (moldura só de
linha `(?:[^\S\r\n  ]|[⎿│])*` sem sobreposição; `\s*(?:[:=]\s*)?`;
prefixo `^[ \t]*(?:[│┃⎿…][ \t]*)?`; `search(/[:=-]/)`), validados com `recheck`
(safe/linear) e medidos: 4 KB em branco 301 ms → 0,13 ms; 16 KB sem quebra
1012 ms → 0,5 ms. Blindagem: orçamento de 25 ms por varredura no failover —
estourou, a sessão espera 5 s (o texto segue na janela; a varredura final
cobre tudo) e o trace registra `failover-detect-slow`. Watchdog passa a
manter `logs/main-hang.ndjson` (histórico). Testes de regressão com teto de
tempo em entradas adversariais (o código antigo estoura todos).

**O que da seção 3 continua pendente** (não bloqueia a 0.76.191): A.1 captura
de `.cpuprofile` pelo `inspector.Session.connectToMainThread()` na worker do
watchdog (validar no build empacotado com o fuse de inspect desligado); A.3
métricas de event-loop e tempo por tap; C.1/C.2 coalescer chunks por sessão e
tirar as taps de análise do main (o pty-host já é um utilityProcess); C.3 o
mesmo teste de tempo para TODA regex do caminho de PTY (há ~200 quadráticas no
bundle do main, a maioria fora do caminho quente); C.5 lint contra `*Sync`;
C.6 semáforo de comandos pesados; C.7 faixa "Nexus ocupado" no renderer.
