# E2E de missão inteira (F-997)

O teste que impede o maior gargalo do Nexus de voltar: **abrir panes e terminar
uma missão inteira**. Cada correção de 07/10 (F-980…F-988) tinha só o teste da
própria peça; este E2E roda todas juntas, pelo caminho real do Main.

## Como rodar

```sh
npm run test:mission-e2e          # = node scripts/mission-e2e.mjs
```

- **Fora de um pane do Nexus** (terminal comum ou job launchd): no macOS o
  supervisor de PTY recusa a responsabilidade herdada de um pane (F-715) e o
  runner recusa com a saída em vez de dar um vermelho falso.
- Node 22 com `better-sqlite3` no ABI dele (`npm run rebuild:node` se o runner
  avisar). Leva 25–70 s (mais com a CPU saturada); nenhuma conta de IA é usada.
- Precisa das ferramentas de linha de comando do Xcode: o supervisor de PTY é
  compilado e assinado ad hoc numa pasta temporária a cada execução.
- `NEXUS_MISSION_E2E_KEEP=1` guarda a pasta temporária; o relatório de falha
  aponta o `evidence.json` (recibos de cada agente, log do comando pesado,
  respostas MCP, entregas).
- Fora do runner o arquivo `src/main/orch/mission-e2e.test.ts` é pulado
  (`NEXUS_MISSION_E2E=1` liga), então a suíte normal não paga o custo.

## O que roda de verdade

- **Main de orquestração**: `initOrchestration()` (servidor MCP HTTP, gancho de
  spawn com tokens, shims de missão, entrega ociosa, supervisor de delegação,
  coordenador), pty-manager, worktrees, git, SQLite, pasta isolada da aba.
- **PTY**: o host real `pty-host-entry.ts` num fork Node (no app é um
  utilityProcess) com o supervisor Darwin compilado e assinado ad hoc na hora.
- **Comando pesado**: o catálogo, os ganchos zsh/preload, a base de job
  nativa (`heavy-job`) e a admissão `/hook/heavy-command` do Main.
- **Agente**: `scripts/mission-e2e/fake-agent.cjs` é um lançador Node no
  formato do codex.js que repassa o próprio argv (brief de ~4 KB com caminho
  longo, crases e node/make/vitest/tsc/typecheck no texto) a um "binário
  nativo" (`fake-agent-native`, Perl). Ele escreve na worktree, roda comandos
  pelo shell como uma tool de CLI, faz commit e entrega pelo shim real
  `nexus_handoff_submit`. O orquestrador falso fala com o MCP HTTP real.

Falsos: a CLI de IA, o `vitest` do repositório de fixture (segura 4 s e sai 0,
mas o catálogo o classifica como `tests`) e a memória livre da máquina (fixa,
para a admissão não depender da carga do host).

## O que ele garante

Uma missão numa aba com pasta isolada em que o Maestro abre, **em paralelo**,
5 writers `isolatedWriter:true` + 1 writer com `cwd` numa worktree aninhada:

| Garantia | Pega a regressão de |
|---|---|
| todos os 6 nascem (spawn ok, worktree do HEAD da aba, cwd honrado) | F-980, F-981 |
| o brief chega íntegro e nenhum agente nasce dentro de um job pesado | F-984 |
| comando leve com node/make/vitest/tsc no texto não entra na fila | F-982 |
| comando pesado sai 0 (nunca 74/78) e writers de worktrees diferentes testam ao mesmo tempo | F-982, F-983 |
| handoff pelo shim chega ao Maestro (6 entregas, ACK) | F-988 |
| o quadro de entregas registra as 6 entregas (trace `worker-delivery-board` com o recibo de cada sessão) e a verificação de conclusão roda no idle/saída de cada writer sem erro | F-1006 |
| nenhuma "scope identity collision" no console do Main (writers isolados abrem os stores da missão pelo escopo de coordenação) | F-1006 |
| rajada de 6 entregas: nenhum "lost delivery-attempt CAS" e handoff → Maestro ≤ 6 s em cada uma (medido 0,77–2,1 s normal, até 4,1 s com a CPU saturada; as regressões dão 8–13 s; `NEXUS_MISSION_E2E_DELIVERY_CEILING_MS`) | F-1006 |
| vigia de zero entrega "9 min depois" não cutuca writer ocupado; nenhum aviso de sistema | F-986 |
| a missão chega a `done` por `nexus_mission_set_status` com as branches integradas | caminho normal |
| nenhum writer some antes do próprio handoff (só o `autoCloseOnHandoff` fecha, depois do sucesso) | mortes caladas |

Na primeira rodada ele achou quatro defeitos que os unitários deixavam passar
(F-997): a vaga pesada pelo checkout de coordenação (writers em fila), worker
sem janela sem `workerIncarnationId` (sem shim), o timer do shim herdando a
fronteira do orquestrador (todo handoff "nested") e o exit 74 na hora com a
máquina ocupada (prova de dono com prazo de 1–2 s). Toda recusa de comando
pesado agora vai para o trace do Main como `heavy-command-denied` com o motivo,
e o `evidence.json` do E2E a traz.

Depois ele passou a ler também o console do Main (avisos e erros) e o trace do
quadro: assim achou o F-1006 — o quadro de entregas e a conclusão automática
abriam os stores pela worktree do writer (colisão de identidade, 0 de 6
entregas no quadro) e a rajada de entregas ia uma por borda ociosa (até 9 s
para a 6ª; com o ACK do Maestro antes da borda busy, CAS perdido e ~13 s). O
`evidence.json` traz `deliveryLatency`, `boardEvents`, `completionChecks`,
`scopeCollisions`, `casLost` e o fim do console.

## Gate de release

`scripts/release-candidate-gate.mjs` roda `scripts/mission-e2e.mjs` no código
do tag, logo depois de provar tag = HEAD e antes de verificar ou selar
artefatos. Vermelho = `release:candidate` falha = `release:mac` não publica. O
recibo vai para `release-artifacts/mission-e2e.json` (fora de `security/`).

## O que ainda não cobre

- Renderer: os panes são main-owned (missão sem janela); o caminho em que o
  renderer monta o pane e devolve o ACK não roda aqui.
- CLIs reais (Claude, Codex, MiMo…): o modelo, o login e o protocolo de TUI de
  cada uma ficam com os smokes opt-in por provider.
- Missão com squad (revisão automática de conclusão, PREVC) e o app
  empacotado (assinatura, asar) — esse último segue no `smoke-packaged-app`.
