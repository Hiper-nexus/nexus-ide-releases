# Jev roteia os panes que os agentes do operador abrem — design (25/09)

## Problema

O operador trabalha abrindo panes na mão ("+") e pede aos agentes desses
panes (ex.: um Claude marcado como orquestrador) que abram outros panes. Em
campo: "quando o orquestrador é Claude, ele só abre panes Claude; não vi em
nenhum momento o Jev ser usado".

## O que o código e a máquina mostraram

1. **O Nexus não tinha chave do Jev.** `classifyTaskWithJev`
   (`src/main/orch/jev-task-routing.ts:121`) devolve `null` sem chave, e o
   `judge()` nem é chamado. Nenhuma superfície do Jev (roteamento, revisão de
   handoff, triagem de terminal etc.) rodou: `userData/jev/decisions.jsonl`
   não existia, e esse arquivo registra até timeout e erro. A queda era calada
   (só `console.warn`). **Resolvido pelo operador em 25/09**: chave salva no
   Keychain, "Testar conexão" ok, e as primeiras decisões `terminalTriage`
   apareceram no log.
2. **O roteamento do spawn é opt-in.** `nexus_pane_spawn` só consulta o
   roteador quando o agente **omite** `adapterId`
   (`src/main/orch/tools-panes.ts:626-631`). O agente sempre preenche
   (`adapterId: "claude"`), então o Jev nunca decide. Com `agentName`, o
   modelo selado do roster vence (`honorSealedRosterRuntime`).
3. `nexus_route_log` estava vazio: nenhuma decisão de rota desde o boot do
   app.

Este design resolve o item 2 e torna visível o que o item 1 escondia.

## Decisões do operador (25/09)

- **Jev decide sempre** nos panes abertos pelos agentes do operador. O
  `adapterId`/`model`/`effort` do agente é ignorado. CLI específica, o
  operador abre na mão pelo "+".
- **Jev fora → heurística com aviso visível.** Nada trava.
- **Diversidade**: a melhor CLI para cada tarefa; no empate ou quase, vence a
  CLI que ainda não está aberta.
- Abordagem escolhida: forçar o roteamento no ponto do spawn, reaproveitando
  o roteador existente (tabela + cota + autenticação + custo). O Jev classifica
  tier/especialidade/escalada; a tabela escolhe CLI, modelo e esforço.

## Escopo

**Dentro:** `nexus_pane_spawn` chamado pela mão do operador sem missão
(`operatorHand = ctx.role === 'user' && !ctx.missionId`), com ou sem
`agentName`.

**Fora:**
- Spawns de missão (orquestrador/worker, roster selado, `routeReservationId`):
  sem mudança. O operador não usa missões.
- Panes que o operador abre na mão pelo "+" (renderer): sem mudança.
- Saber em que aba o pane nasce: é o sub-projeto B (abas isoladas).

## Design

### 1. Fluxo do spawn (`src/main/orch/tools-panes.ts`)

Quando `operatorHand` e **sem** `resume`:

- O handler sempre chama `operatorRouteResolver(task ?? prompt ?? title)`.
  Sem nenhum dos três, falha com a mensagem de hoje pedindo `task`.
- `adapterId`, `model` e `effort` recebidos nos args são **ignorados**. Se o
  agente mandou algum, o recibo traz `route.ignored: { adapterId?, model?,
  effort? }` com o que foi descartado, para o agente entender e não insistir.
- **Com `agentName`**: o agente do roster continua dando título, `agentName`,
  `allowedTools` e `allowedSkills`. CLI, modelo e esforço vêm da rota, não de
  `honorSealedRosterRuntime`.
- A autoridade do pane não muda: `role` continua omitido (o Main minta
  `user`), o allowlist segue `inheritOperatorFreedom` como hoje.
- `harness.source` passa a ser `'auto-route'` em todo spawn desse caminho.

Quando `operatorHand` e **com** `resume`:

- Não roteia. A CLI vem do registro de sessão do pane retomado, porque
  `copyProviderPaneSession` (`src/main/orch/pane-registry.ts:2262`) copia a
  conversa por CLI. Trocar a CLI faria o pane nascer sem contexto.
- Sem registro do pane antigo, usa o `adapterId` dos args (o comportamento de
  hoje) e o aviso de "nasce sem contexto" continua no log.

Descrição da tool: `adapterId`, `model` e `effort` passam a dizer "ignorados
quando chamado do pane do operador sem missão; descreva a tarefa em `task`".

### 2. Jev fora, visível

**Motivo em vez de `null`.** `classifyTaskWithJev` passa a devolver:

```ts
type JevTaskRoutingResult =
  | { readonly kind: 'classified'; readonly classification: JevTaskClassification }
  | { readonly kind: 'unavailable'; readonly reason: JevUnavailableReason };

type JevUnavailableReason =
  | 'disabled'        // jevAutopilot ou superfície taskRouting desligados
  | 'no-key'          // hasJevCredential() falso
  | 'invalid-answer'  // Jev respondeu fora do formato esperado
  | JevNoAnswerReason; // timeout | rate-limited | client-error | server-error | network | malformed | aborted
```

`judge()` (`src/main/jev/jev-client.ts:217`) já calcula `lastReason` e grava
`recordJevNoAnswer`. `JudgeInput` ganha `onNoAnswer?: (reason:
JevNoAnswerReason) => void`, chamado no mesmo ponto em que o `no-answer` é
gravado. O retorno continua `JevResult | null`, então as outras nove
superfícies não mudam. `classifyTaskWithJev` usa o callback para montar o
`unavailable`; `disabled` e `no-key` ele decide antes de chamar o `judge`.

Resposta com baixa confiança **não** é indisponibilidade: é o Jev
respondendo. `routingOverridesFrom` continua marcando `heuristic`/`mixed`.

**Recibo e log.**
- `nexus_route_task` devolve `jevUnavailable: <motivo>` quando a
  classificação caiu. O recibo do spawn repassa em `route.jevUnavailable`.
- `RouteLogEntry` (`src/main/orch/route-log.ts`) ganha `classifierSource` e
  `jevUnavailable?`, para `nexus_route_log` explicar a escolha.

**Pane.**
- `OrchPaneSpawnRequest` (`src/shared/orch-types.ts:753`) ganha
  `route?: { source: 'jev' | 'mixed' | 'heuristic'; jevUnavailable?: string }`,
  preenchido só em spawns roteados.
- O renderer guarda isso no `PaneModel` como campo de exibição **não
  persistido** (some no restart; é informação do nascimento).
- O cabeçalho do pane mostra um chip: "Jev" quando `source` é `jev`/`mixed`,
  "sem Jev" quando `jevUnavailable` existe, com o motivo em português no
  tooltip. `heuristic` sem indisponibilidade (Jev pouco confiante) não mostra
  chip. Tokens e estilo do `DESIGN.md`.

**Aviso único.** No renderer, ao materializar um spawn com
`route.jevUnavailable`, dispara um toast (`src/renderer/state/toast-store.ts`)
**uma vez por motivo por execução do app**: "Jev não respondeu (<motivo>) — o
pane foi aberto pela heurística". Com `no-key`/`disabled`, o toast aponta para
Configurações › Chaves de API. Não há canal IPC novo.

### 3. Diversidade no empate

**Conjunto de uso.** As CLIs dos panes vivos com
`operatorParentSessionId === ctx.sessionId` (os filhos que este agente já
abriu) mais a CLI do próprio agente pai (`ctx.providerId`). É "por agente
pai", não "por aba", porque o Main ainda não conhece abas. Quando o
sub-projeto B entregar abas no Main, o conjunto passa a ser a aba.

**Regra.**
1. O roteador ordena os candidatos exatamente como hoje. `ranked[0]` é o
   "melhor" (a escolha atual).
2. Cada candidato recebe o total de `scoreRouteCandidate` sem o termo de
   diversidade (sem `missionUseCounts`, ele já é 0).
3. Os candidatos com total ≥ `total(ranked[0]) − TIE_MARGIN` formam a faixa
   de empate.
4. Na faixa, vence o de menos usos no conjunto; empate persistente → mantém a
   ordem atual.
5. Fora da faixa ninguém sobe: o melhor vence mesmo repetindo CLI. Sem faixa
   (um candidato só) a escolha é a de hoje.

**Onde mora.** Função pura nova em `src/main/orch/route-pipeline.ts`
(`tieBreakByUse(ranked, useCounts, margin, scoreInput)`), aplicada em
`routeTask` (`src/main/orch/task-router.ts`, logo após o `multiScoreRerank`
e antes da escolha em `ranked[0]`) quando `RouteContext.tieBreakUseCounts`
vem preenchido. Só o caminho `operatorHand` preenche esse campo: o resolver
do spawn (`setOperatorRouteResolver`, `tools-domain.ts:1709`) passa o
conjunto por parâmetro interno, **nunca** por argumento MCP. Assim nenhum
agente injeta contagens chamando `nexus_route_task`. Chamadas diretas de
`nexus_route_task` e missões não mudam.

`TIE_MARGIN` é constante nomeada, começando em **8 pontos** (≈ 2 posições da
tabela, que desce 4 por posição em `scoreRouteCandidate`), calibrada por
teste. A atenuação de missão (−18 por uso, `route-pipeline.ts:99`) **não** é
reusada: ela troca vencedor claro, o que contraria "melhor por tarefa".
Missões continuam com a atenuação delas.

O motivo da decisão registra o desempate quando ele muda o vencedor
("empate com X; Y ainda não aberta").

### 4. Tratamento de erro

| Situação | Resultado |
|---|---|
| Sem `task`/`prompt`/`title` | Spawn falha pedindo `task` (hoje) |
| Jev indisponível | Heurística; recibo, log, chip e toast com o motivo |
| Roteador sem CLI elegível | Spawn falha com o erro atual do roteador |
| `resume` sem registro do pane antigo | Usa `adapterId` dos args; log avisa "sem contexto" |
| CLI roteada falha ao nascer | Caminho atual de falha/reroute (`spawn-fail-reroute.ts`), sem mudança |

### 5. Custo e latência

Cada spawn roteado faz uma chamada ao Jev com timeout de 5 s
(`TASK_ROUTING_TIMEOUT_MS`) e o `judge` tenta até 2 vezes. O pior caso soma
~10 s antes da heurística; hoje o mesmo custo já existe para quem omite
`adapterId`. O custo em USD entra no log de decisões do Jev como já acontece.

## Testes (TDD — teste antes do código)

- `src/main/orch/tools-panes-route-gate.test.ts`
  - mão do operador com `adapterId: "claude"` → spawn usa a CLI roteada;
    recibo traz `route.ignored.adapterId`.
  - mão do operador com `agentName` → CLI/modelo da rota; título e allowlist
    do roster.
  - `resume` → mesma CLI do pane retomado, sem chamar o roteador.
  - spawn de missão → comportamento atual intacto.
  - Jev indisponível → recibo com `route.jevUnavailable`.
- `src/main/orch/jev-task-routing.test.ts`: cada `JevUnavailableReason`
  (`disabled`, `no-key`, `timeout`, `invalid-answer`…).
- `src/main/jev/jev-client.test.ts`: o motivo chega ao chamador; as outras
  superfícies seguem recebendo `null`.
- `src/main/orch/route-pipeline.test.ts` (`tieBreakByUse`): empate dentro de
  `TIE_MARGIN` → CLI não usada; vencedor fora da margem → mantém, mesmo
  repetindo; sem `useCounts` → ordem intacta.
- `src/main/orch/task-router.test.ts`: `routeTask` sem `tieBreakUseCounts`
  devolve a mesma decisão de hoje (regressão das missões e do
  `nexus_route_task` direto).
- `src/main/orch/route-log.test.ts`: entrada com `classifierSource` e
  `jevUnavailable`.
- Renderer: chip "Jev"/"sem Jev" no cabeçalho; toast uma vez por motivo;
  `route` não persiste no layout.
- Verificação: `npx tsc --noEmit`, vitest dos arquivos tocados,
  `npm run security:renderer-sinks` (muda payload de IPC).

## Fronteira de segurança

`src/main/orch/` é fronteira sensível (`AGENTS.md`). A mudança troca **qual
CLI** nasce, não **quanta autoridade** o pane tem: `role`, allowlists, escopo
e sandbox seguem os mesmos do caminho `operatorHand` atual. O texto da tarefa
já vai ao Jev hoje quando o agente omite `adapterId`; passa a ir em todo spawn
desse caminho, com o `redactState` do `judge`.

## Fora deste design (próximos)

- Sub-projeto B: abas isoladas (pane nasce na aba de quem pediu, organização
  visual, branch + worktree por aba).
- Sub-projeto C: delegação automática. O primeiro pane (ou o sistema)
  distribui o trabalho abrindo panes sem precisar ser marcado como
  orquestrador, em vez de executar tudo sozinho, para economizar tokens entre
  LLMs e ganhar velocidade. Depende deste design: sem o Jev roteando, os
  panes delegados nasceriam todos na CLI do agente que delegou. Design em
  `docs/superpowers/specs/2026-09-25-delegacao-automatica-design.md`.
