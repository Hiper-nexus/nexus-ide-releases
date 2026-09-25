# Delegação automática nos panes do operador — design (25/09)

## Problema

O operador pede: "o sistema (ou o primeiro pane aberto) distribui as tarefas
abrindo mais panes, mesmo sem estar marcado como orquestrador — não executa
tudo sozinho", para otimizar tokens entre LLMs e acelerar a execução.

Hoje um pane aberto pelo operador, sem missão, não recebe doutrina nenhuma
sobre delegar:
- O MCP da Nexus não devolve `instructions` no `initialize`
  (`src/main/orch/mcp-protocol.ts:185`).
- A doutrina de delegação (`orchestrator-doctrine.ts`) e a skill `oc-pilot`
  só entram em orquestrador de missão.
- A fila de writers (`decideSameCheckoutSpawn`, `tools-panes.ts:1051`) só
  vale dentro de missão: dois helpers do operador escrevem no mesmo checkout
  ao mesmo tempo sem trava.
- Helper aberto por agente nasce fora da aba do pai: `spawnOrchPane`
  (`src/renderer/state/layout-store.ts:899`) não recebe `spaceId`.

Pré-requisito: `docs/superpowers/specs/2026-09-25-jev-roteia-spawn-design.md`
(sub-projeto A). Sem o Jev roteando, os panes delegados nasceriam todos na
CLI de quem delegou. A e C entram num plano único, A primeiro.

## Decisões do operador (25/09)

- **Todos delegam, sem limite de profundidade**: panes abertos na mão e os
  helpers que eles abrem.
- **O Jev julga cada mensagem** se ela se divide; doutrina curta no
  nascimento como base.
- **Leitura em paralelo, escrita em fila**: helpers `readOnly` rodam juntos;
  helpers que escrevem, um por vez no mesmo checkout.
- **Helper fecha sozinho no sucesso**; falha fica aberta.
- **Freio contra cascata** (aprovado): o teto de panes recusa spawn feito por
  agente; o "+" manual continua só avisando.

## Escopo

**Dentro:** panes CLI da mão do operador sem missão
(`ctx.role === 'user' && !ctx.missionId`), abertos no "+" ou por outro
agente.

**Fora:**
- Missões (orquestrador, workers, roster, worktree por task): sem mudança.
- Panes shell e browser.
- Isolamento entre abas feitas à mão, writers de abas diferentes e worktree
  por aba: sub-projeto B.
- Delegar tarefa de uma parte só para economizar modelo (YAGNI).

## Design

### C1. Doutrina no nascimento (`src/main/orch/mcp-protocol.ts`)

O `initialize` passa a devolver `instructions` quando o chamador é a mão do
operador sem missão (o `ctx` já está disponível no handler). O texto mora num
módulo novo, `src/main/orch/operator-delegation-doctrine.ts`, com teto de
1,5 KB verificado em teste, e diz:

1. Trabalho divisível, pesado ou paralelizável vai para
   `nexus_pane_spawn({ task, prompt })`. O Nexus (Jev) escolhe CLI, modelo e
   esforço. Não passe `adapterId`.
2. Pesquisa, revisão, análise e leitura de testes usam `readOnly: true` e
   rodam em paralelo (uma chamada por helper: o `nexus_pane_spawn` não tem
   spawn em lote).
3. Quem altera código: um helper por vez. Enquanto um helper writer roda,
   você não edita arquivos.
4. Depois de delegar, encerre o turno: a entrega chega no seu input sozinha.
   Não fique lendo panes em loop.
5. Receba cada entrega, integre, verifique e reporte ao operador.
6. Tarefa pequena ou conversa: faça você mesmo.
7. Se você foi aberto por outro pane (é helper), termine com
   `nexus_handoff_submit` uma vez, com o que fez, o que validou e o que
   bloqueou. É isso que leva a entrega ao pane pai e fecha o seu pane no
   sucesso.
8. Se o spawn for recusado (writer ativo, teto de panes), não insista: faça a
   parte você mesmo ou espere a entrega que está em curso.

Orquestrador e worker de missão continuam sem esse `instructions`: eles têm a
doutrina deles. CLIs que ignoram `instructions` ficam com a descrição da
tool.

### C2. O Jev julga cada mensagem

**Hook.** `mergeClaudeStatusHooks` (`src/main/orch/hook-status-config.ts:52`)
ganha uma entrada `UserPromptSubmit` com um comando novo,
`makeClaudeDelegateHookCommand()`, no molde de `makeClaudeTriageHookCommand`:
a resposta do endpoint vira a saída do hook, e o comando termina em
`|| true`. Vale para a família Claude (claude, glm, glm-flash, longcat).

**Codex** entra só se o plano confirmar, num teste com a CLI real, que o
`UserPromptSubmit` do Codex injeta `additionalContext`. Sem essa prova, o
Codex fica só com a doutrina (C1). Kimi, Grok e demais CLIs ficam só com a
doutrina.

**Endpoint.** `POST /hook/delegate`, módulo novo
`src/main/orch/hook-delegate-endpoint.ts`, mesmo servidor loopback e bearer
do `/hook/triage` (`src/main/orch/hook-triage-endpoint.ts`). Ele:
- aceita só sessão da mão do operador sem missão; qualquer outra responde
  `{}`;
- extrai o `prompt` do payload `UserPromptSubmit`;
- com menos de `DELEGATE_MIN_PROMPT_CHARS` (40) caracteres responde `{}` sem
  chamar o Jev ("siga", "ok", "c");
- chama a superfície Jev nova e devolve
  `hookSpecificOutput.additionalContext` quando aconselha delegar, `{}` caso
  contrário;
- nunca responde erro: entrada inválida, superfície desligada, Jev sem chave,
  timeout ou exceção → `{}` (200).

**Superfície Jev `delegation`.** Módulo novo
`src/main/jev/jev-delegation.ts`. `JevSurface` e `JEV_SURFACES`
(`src/main/jev/jev-autopilot.ts`) ganham `'delegation'`, com toggle
`orch.jevSurfaces.delegation` e `NEXUS_JEV_SURFACE_DELEGATION=0`. Perguntas
ao `judge`:
- `divisible` (noul 0..1): a mensagem pede trabalho que se divide em partes
  independentes?
- `parts` (choice `1`, `2`, `3`, `4`, `5+`): em quantas?
- `writers` (choice `0`, `1`, `2+`): quantas partes alteram código?

Aconselha quando `divisible ≥ DELEGATE_MIN_CONFIDENCE` (0,6) **e** `parts ≥
2`. Timeout `DELEGATE_TIMEOUT_MS` (2 500 ms). Decisão e no-answer vão para o
log do Jev como nas outras superfícies (sem o texto do prompt).

Texto injetado (≤ 400 caracteres, pt-BR), por exemplo:

> [Nexus · Jev] Esta tarefa se divide em ~3 partes (2 de leitura em paralelo,
> 1 de escrita). Delegue com nexus_pane_spawn({task, prompt}) — readOnly para
> as de leitura — e encerre o turno; não execute tudo sozinho.

**Custo.** O hook segura o envio da mensagem até o Jev responder: até 2,5 s
por mensagem longa. O texto da mensagem vai à API do TypeSafe passando pelo
`redactState` do `judge`, como já acontece com a tarefa no roteamento.

### C3. Trilhos no Main

**Writers em fila** (`src/main/orch/tools-panes.ts`, caminho `operatorHand`).
Antes do spawn, se o helper novo **escreve** (sem `readOnly`) e já existe
outro pane vivo que:
- tem `operatorParentSessionId` (é helper delegado),
- não é `readOnly`,
- está no mesmo checkout (`scope.checkoutId`) e não está `exited`,

o spawn é recusado com: "writer pane N ainda ativo — espere a entrega dele ou
abra este como readOnly". Helpers de leitura nunca são barrados. Panes que o
operador abriu na mão não contam. A decisão é uma função pura nova
(`decideDelegatedWriterSpawn`), vizinha de `decideSameCheckoutSpawn`, com
teste próprio.

**Fecha no sucesso.** No caminho `operatorHand`, `autoCloseOnHandoff`
passa a valer `true` quando o agente não passa o campo; `false` explícito é
respeitado. Handoff de falha mantém o pane aberto (comportamento atual do
campo). O guardião de ociosos (`pane-non-worker-auto-close.ts`) continua
como rede para quem nunca entrega.

**Helper nasce na aba do pai** (correção B1 antecipada).
- `OrchPaneSpawnRequest` (`src/shared/orch-types.ts:753`) ganha
  `parentPaneId?: string`, preenchido pelo Main a partir do
  `operatorParentSessionId` (sessão → pane).
- `spawnOrchPane` (`layout-store.ts:899`) recebe o `parentPaneId`; quando o
  pai existe no layout e não é de missão, o helper herda `spaceId` e
  `spaceTitle` dele, a mesma regra do `split` (F-560).
- Pai sem espaço → helper sem espaço (mesma aba "Terminais"). Pai que sumiu →
  comportamento atual.

**Freio contra cascata** (`src/main/pty/pty-manager.ts:1362`,
`src/main/orch/pane-admission.ts`). `admitAgentSpawnSync` recebe se o spawn
foi pedido por um agente do operador (tem `operatorParentSessionId`). Nesse
caso o teto de panes e a pressão de memória **recusam** (como `hardBlocks`),
com a mensagem atual que lista os ociosos para fechar. Spawns de missão não
mudam. Spawn
feito pelo operador no renderer continua só avisando (doutrina "menos
travas", 0.76.47). `NEXUS_PANE_GUARD=off` continua desligando tudo. O agente
recebe o erro e executa ele mesmo; a doutrina (C1) diz isso.

## Tratamento de erro

| Situação | Resultado |
|---|---|
| Jev fora, timeout, sem chave | Hook devolve `{}`; pane segue com a doutrina |
| Payload de hook inválido | `{}` (200), nunca 500 |
| Writer delegado já ativo | Spawn recusado com o pane que bloqueia |
| Teto/pressão atingidos em spawn de agente | Spawn recusado com ociosos a fechar |
| Pai sumiu antes do helper nascer | Helper nasce onde nasce hoje |
| CLI sem hook / sem `instructions` | Sem nudge; descrição da tool continua |

## Fronteira de segurança

Toca `src/main/orch/` e `src/main/pty/` (fronteira sensível, `AGENTS.md`).
- `instructions` e `additionalContext` são texto fixo da Nexus mais números
  do Jev; nada vindo do prompt é ecoado de volta.
- O endpoint reusa bearer e servidor do `/hook/triage` e responde só à sessão
  dona do token.
- Nenhuma autoridade nova: o helper continua `role user`, com o allowlist de
  hoje; a fila de writers e o freio só **recusam**.

## Testes (TDD)

- `mcp-protocol`: `initialize` com `instructions` para a mão do operador sem
  missão; sem `instructions` para orquestrador, worker e missão; texto
  ≤ 1,5 KB.
- `hook-delegate-endpoint`: aconselha (divisível, 2+ partes); silêncio (1
  parte, baixa confiança); mensagem curta sem chamar o Jev; Jev `null` →
  `{}`; payload inválido → `{}`; sessão de missão → `{}`.
- `jev-delegation`: montagem das perguntas, limiares, superfície desligada,
  sem chave.
- `hook-status-config`: `UserPromptSubmit` ganha a entrada de delegação sem
  perder a de status; reescrita idempotente.
- `decideDelegatedWriterSpawn`: writer × writer recusa; reader × writer
  passa; writer × pane manual passa; outro checkout passa; writer `exited`
  não conta.
- `tools-panes`: `autoCloseOnHandoff` padrão `true` na mão do operador,
  `false` explícito respeitado, missão intacta.
- `pane-admission`: teto e memória recusam spawn de agente do operador;
  spawn do renderer e de missão só avisam, como hoje;
  `NEXUS_PANE_GUARD=off` desliga.
- Renderer (`layout-store.test.ts`): helper herda `spaceId` do pai; pai de
  missão não passa espaço; pai ausente mantém o comportamento atual.
- Verificação: `npx tsc --noEmit`, vitest dos arquivos tocados,
  `npm run security:renderer-sinks`.
