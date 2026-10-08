# E2E de missão inteira (F-971)

O teste que impede o maior gargalo do Nexus de voltar: **abrir panes e terminar
uma missão inteira**. Cada correção de 07/10 (F-954…F-962) tinha só o teste da
própria peça; este E2E roda todas juntas, pelo caminho real do Main.

## Como rodar

```sh
npm run test:mission-e2e          # = node scripts/mission-e2e.mjs
```

- **Fora de um pane do Nexus** (terminal comum ou job launchd): no macOS o
  supervisor de PTY recusa a responsabilidade herdada de um pane (F-715) e o
  runner recusa com a saída em vez de dar um vermelho falso.
- Node 22 com `better-sqlite3` no ABI dele (`npm run rebuild:node` se o runner
  avisar). Leva ~40 s; nenhuma conta de IA é usada.
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
| todos os 6 nascem (spawn ok, worktree do HEAD da aba, cwd honrado) | F-954, F-955 |
| o brief chega íntegro e nenhum agente nasce dentro de um job pesado | F-958 |
| comando leve com node/make/vitest/tsc no texto não entra na fila | F-956 |
| comando pesado sai 0 (nunca 74/78) e writers de worktrees diferentes testam ao mesmo tempo | F-956, F-957 |
| handoff pelo shim chega ao Maestro (6 entregas, ACK) | F-962 |
| vigia de zero entrega "9 min depois" não cutuca writer ocupado; nenhum aviso de sistema | F-960 |
| a missão chega a `done` por `nexus_mission_set_status` com as branches integradas | caminho normal |

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
