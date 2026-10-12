# T3 Code × Nexus: por que um não trava e o outro trava

Fonte: `pingdotgg/t3code` (MIT, © 2026 T3 Tools Inc.), clone local em 12/10/2026
(HEAD do `main`). Metodologia de orçamento já colhida em
`docs/perf-budgets.md` (QLT-01). Proveniência de cópias colhidas:
`third_party/provenance/t3code-26285ab.json`.

## Tese

O T3 não é mais rápido por magia de framework. Ele é mais rápido porque
**não deixa o Electron main ver o mundo**: tudo é limitado por default,
incremental, com backpressure por ACK, e com efeitos fora do caminho de
decisão. O Nexus trava quando o Main analisa cada chunk de PTY, multiplica
panes sem teto rígido e paga I/O no caminho quente.

## Arquitetura (a raiz)

| | T3 Code | NexusIDE |
|---|---|---|
| Dono de PTY/Git/arquivos | servidor (`apps/server`) | Electron main + `pty-host` utilityProcess |
| Renderer | cliente RPC fino | React + xterm com push IPC direto |
| Módulo nativo no main | **nunca** (filhos com deadline) | PTY supervisor, analysis Worker, etc. |
| Intent × efeito | event log + `EventSink` + `EffectWorker` | outbox de handoff (ORC-01/02/06 parcial) |
| Cultura de perf | `test:perf:v2-wire`, auditam WS/GPU/listas | `test:perf` + `docs/perf-budgets.md` |

T3 `docs/internals/overview.md`: *“Native modules never load in the Electron
main process on the startup path”* e *“a client viewing one thread does not
pay for every thread's history”*.

## Tetos do T3 (os números que importam)

| O quê | Teto T3 | Onde |
|---|---|---|
| Histórico de terminal | 5.000 linhas / 8 MiB UTF-8 | `terminal/Manager.ts` (`BoundedTerminalHistory`) |
| Buffer do cliente | 512 KiB | `docs/internals/terminal-runtime.md` |
| Janela de output pendente | **8 chunks / 64 KiB** sem ACK | `terminal/OutputProtocol.ts` |
| Live stream por assinatura | 1.000 itens / 8 MiB serializados | `LiveStreamBudget.ts` |
| Cold open da timeline | 75 linhas / ~1 MiB | `docs/internals/performance-regressions.md` |
| Resume catch-up | 128 eventos / 1 MiB antes de snapshot | idem |

`withTerminalOutputWindow` (T3): enquanto houver ≥8 chunks ou ≥64 KiB
não-ACKed, **para de empurrar**. O ACK tira da janela e o fluxo volta.
Estouro de live stream **falha a assinatura** (fail-closed), não enche memória.

## Onde o Nexus já está em paridade (ou melhor)

- Scrollback padrão **5.000 linhas** (`shared/terminal-scrollback-policy.ts`).
- Janela de replay do Main **1 MiB** (`MAX_REPLAY_WINDOW_CHARS`) — mais apertado
  que o histórico de 8 MiB do T3.
- Push pausado em **512 KiB** sem ack (`MAX_UNACKED_OUTPUT_CHARS`).
- Análise de tela/limit em **Worker** (`pty-analysis-runtime`), com
  `pty-analysis-production-wiring.test.ts` garantindo que Main não chama
  `detectLimit`/`stripAnsi` no caminho quente (F-764).
- Taps de dados em lote (F-764 C.1, `pty-tap-dispatcher`).
- Orçamentos no CI (`npm run test:perf`).

## Gap fechado neste trabalho

**Janela de ACK por mensagens (T3 `OutputProtocol`).** O Nexus só pausava o
push pelo total de caracteres sem ack (512 KiB). Rajada de chunks minúsculos
(400×80 chars = 32 KiB) ficava **abaixo** do teto de caracteres e enchia o
IPC do Electron com centenas de mensagens. Agora o push também pausa em
**8 chunks / 64 KiB em voo**, com os mesmos números do T3.

Implementação: `pendingPushChunks` / `pendingPushChars` / `lastPushedSequence`
em `src/main/pty/pty-manager.ts`. ACK e evicção da janela de replay
decrementam a janela; o recuperador do preload já semeia a lacuna
(`requestPtyRecover`) quando a sequência pula.

Teste: `pty-output-wire.budget.test.ts` (“janela T3 de ACK”).

## Gaps restantes (não fechados aqui)

| Item | Estado | Por que não veio neste PR |
|---|---|---|
| F-764 carga completa + binário assinado | aberto | exige prova de carga e release |
| F-851 regex adversariais | aberto | já tem auditoria; precisa de typecheck do coordenador |
| F-852/F-856 fila de comandos pesados | abertos em limites | marcos por CLI com prova física nativa |
| DSK-08 monitor nativo Rust | pendente | binário + consumidor |
| ORC-01/02/06 outbox completo | parcial | modelo de efeitos do T3 é Effect-TS; colhemos a ideia, não a stack |
| Perfil de carga canônico 12–15 panes | ausente | precisa de harness dedicado |

## O que um PR seguinte deve trazer

1. Perfil de carga canônico (12–15 panes + TUI ruidosa) com p99 < 100 ms no
   Main — o critério já está no F-764.
2. Fechar F-851 com typecheck da união e prova no empacotado.
3. Continuar F-856 pelos transportes restantes (`/bin/sh` absoluto, Windows).
4. Só então considerar o modelo de efeito/outbox mais próximo do `EventSink`.

## Referências

- `pingdotgg/t3code` `docs/internals/overview.md`
- `pingdotgg/t3code` `docs/internals/terminal-runtime.md`
- `pingdotgg/t3code` `docs/internals/performance-regressions.md`
- `pingdotgg/t3code` `apps/server/src/terminal/OutputProtocol.ts`
- `pingdotgg/t3code` `apps/server/src/terminal/Manager.ts` (`BoundedTerminalHistory`)
- `pingdotgg/t3code` `apps/server/src/orchestration-v2/LiveStreamBudget.ts`
- `docs/analysis/2026-10-03-main-thread-hang/HANDOFF.md` (F-764)
- `docs/perf-budgets.md` (QLT-01)
