# Orçamentos de performance (QLT-01)

`npm run test:perf` roda os testes `*.budget.test.*` e o CI falha quando um
deles passa do teto (etapa **Perf budgets** em `.github/workflows/ci.yml`; os
mesmos arquivos também rodam no `npm test`). Método adaptado do T3 Code
(`commands.performance.test.ts`, `docs/internals/performance-regressions.md`):
teto numérico com o valor medido ao lado, e o CI quebra quando alguém o passa.

**Regra:** só contagem determinística — escritas, mensagens, bytes, renders,
assinaturas, linhas. Nunca tempo de relógio. Timers e `performance.now` são
falsos (`vi.useFakeTimers({ toFake: [..., 'performance'] })`), então o mesmo
código dá o mesmo número em qualquer máquina.

## Tetos

| Arquivo | Teto (medido) | Protege |
| --- | --- | --- |
| `src/renderer/components/PaneGrid.render.budget.test.tsx` | 0 render de toolbar/superfície/faixa e 0 commit da grade por broadcast de missão (8 agentes × 20 broadcasts) | 95a79996a: pane que assina `missions`/`squads` inteiros re-renderiza a grade a cada evento do motor |
| idem | 3 assinaturas vivas do orch-store por pane de agente | assinatura nova no store inteiro custa N listeners |
| idem | 0 notificação quando `bindPaneMission` repete o mesmo par | no-op do rebind que o orch-bridge chama em todo broadcast |
| `src/renderer/terminal/terminal-output-scheduler.budget.test.ts` | rajada: 1 escrita por pane (8 × 120 chunks), 5 drenos agendados | dreno que junta chunks até 16 KB; coalescer do quadro da TUI no pane focado; timer de dreno único |
| idem | fluxo 60 quadros/16 ms: ≤ 31 escritas no pane mais ativo, 242 na grade, 181 drenos | mesmo, em regime |
| `src/main/pty/pty-output-wire.budget.test.ts` | 1 mensagem de dados por chunk, 1 `stateChange` por rajada, ≤ 64 bytes de envelope por evento (53), 2 entregas aos taps por rajada de 400 chunks | evento magro `{ sessionId, data, sequence }`; virada para busy uma vez; F-764 C.1 (taps em lote) |
| idem | 524288 caracteres (512 KiB) empurrados a um renderer que nunca confirma | backpressure: a fila de IPC do Main não cresce sem limite |
| `src/main/orch/pane-output-digest.budget.test.ts` | 742 caracteres e 26 linhas para 12 passos × 15 quadros de TUI | dedupe de status/quadros/linha repetida do digest (F-961) — tokens do Maestro |

O DOM da timeline virtualizada já tem teto próprio em
`AgentActivityTimeline.test.tsx` (10 mil eventos, menos de 60 linhas montadas).

## Mudar um teto

1. Rode `npm run test:perf`; cada teste imprime a medição numa linha
   `[perf-budget] ...` (também no log do CI).
2. **Baixou** (otimização nova): abaixe o teto para o número novo e atualize o
   valor entre parênteses no comentário do arquivo e nesta tabela. Teto folgado
   deixa regressão passar.
3. **Subiu**: é regressão até prova em contrário. Só suba o teto se o custo
   novo for intencional, e diga por quê na mensagem do commit.
4. Orçamento novo: arquivo `*.budget.test.ts(x)` ao lado do código, constante
   `BUDGET` com o valor medido comentado, e o caminho no script `test:perf`.
   Prove que ele quebra ao reverter a otimização que protege.
