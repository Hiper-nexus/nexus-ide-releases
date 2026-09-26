# Abas de feature com branch + worktree própria — análise (23/09)

O operador pediu abas nos Terminais em que cada aba é uma feature: os panes
dela, a missão que um deles começou e, ao abrir uma aba nova, uma branch e
uma worktree próprias. A 0.76.94 entrega a aba como feature (agrupamento,
missão hospedada, lado a lado, visão geral). **Na versão de 23/09, branch + worktree por aba não
entrou**: exige autoridade nova no Main, fronteira de segurança
(`src/main/orch`, `src/main/pty`, `src/main/runtime`), e não se faz às
pressas antes de release. Este documento registra o que o código mostra e o
desenho proposto.

## Implementação de 26/09/2026 — F-162

As novas abas do +, Montar meus terminais e wizard de missão agora recebem uma
worktree durável fora do projeto, criada do HEAD sem copiar WIP. Abas e missões
anteriores permanecem onde estavam. Fechar uma aba não remove sua pasta/branch.

O Main guarda a referência opaca `workspaceBinding.spaceId` no contrato das
novas missões e no hash da review. A adoção de pane existente é resolvida antes
da revisão e conserva a pasta dele. `mission-execution-scope.ts` é o resolvedor
físico; o escopo original continua sendo a identidade do banco, dos eventos e
das permissões. Um registro ou diretório perdido/substituído recusa a operação,
sem fallback para main. O `.git` precisa apontar para um admin de worktree cujo
back-pointer corresponde à própria aba.

O fluxo normal usa essa raiz no spawn, primeira onda, retomada, revisão civil,
sensores mecânicos, fingerprint de candidato, gate de artefatos, abertura da
entrega e push. O baseline Git da aba evita que os mtimes do checkout inicial
sejam contados como entrega. A UI persiste o espaço da missão para que panes
manuais e splits compartilhem a mesma pasta. O serviço reaproveita os registros
`ownerKind: pane`/`taskId: tab`; o status `failed` de recovery libera apenas a
reserva e não invalida a pasta durável.

PREVC mutável, sensores do workflow congelado e sub-worktrees de tarefas ainda
assumem o checkout de coordenação; esses caminhos recebem recusa explícita nas
abas isoladas. A revisão automática do fluxo standard/free funciona na aba.
Não há merge automático nem alegação de sandbox das ferramentas nativas.

A análise abaixo descreve o estado de 23/09 e explica as fronteiras que levaram
a esse desenho. A publicação depende da validação do candidato.

## O que existia em 23/09

- **`WorktreeManager`** (`src/main/runtime/worktree-manager.ts`) cria
  worktree fora da árvore do projeto:
  `<userData>/project-runtime/projects/project-<key>/checkout-<key>/worktrees/.../task-<taskKey>`,
  com `git worktree add -b <branch> <path> <headSha>` a partir do HEAD do
  checkout principal. Registro em SQLite (`worktree_state`, CAS).
- `ownerKind` é fixo em `'pane'` em seis lugares
  (`worktree-contract.ts:33,78`, `worktree-state.ts:114`,
  `sqlite-workflow-state-stores.ts:164,182`, `worktree-manager.ts:244`).
- `purgeRecordsWithoutTask` apaga todo registro não-pane sem linha em
  `tasks`; no boot, registros de pane `ready`/`reserved` viram `failed`
  ("pane writer interrupted by application restart"). Uma aba persistente
  seria apagada ou marcada falha.
- Branch é hash (`refs/heads/nexus/<digest>/<digest>`), sem nome humano, e
  não há API de remover (o único `git worktree remove` é `archiveWorktree`,
  sem chamador em produção).

## O que bloqueia

1. **cwd do pane**: o renderer pede `cwd` e o Main valida com
   `resolveCwdForScope` (`workspace-path.ts:133`): fora da raiz do workspace
   → `cwd escapes workspace`. Toda worktree gerenciada mora fora da raiz.
2. **Escopo de execução**: só spawn do Main (isolatedWriter, contrato
   congelado) ganha `executionScope` com `rootRealPath = worktree`
   (`tools-panes.ts:1034`). No spawn direto do operador, `bindSpawnAuthority`
   usa o escopo do workspace (`spawn-authority.ts:481`); nada no pedido do
   renderer pode trocar isso — e não deve.
3. **Política F-563**: writer com `executionScope` distinto tem MCP restrito
   a git add/commit/status/diff/log; `nexus_terminal_run` não executa shell.
   A mão do operador numa aba-worktree não pode herdar essa trava.
4. **Missão**: `mission.start` aceita só `missionId`/`reviewSha256`/
   `adoptOrchestratorPaneId`; o fast lane abre orquestrador e roster em
   `scope.rootRealPath` (`mission-fast-lane.ts:1060`, `248`, `1903`, `2423`).
   Sensores, verificação, integração e push assumem o checkout principal.
5. **Worktree aninhada na raiz não é saída**: `<projeto>/.nexus/worktrees/x`
   passaria na validação de cwd, mas duplica a árvore para as ferramentas do
   projeto (vitest/jest acham os testes duas vezes, busca e tsc também).

## Desenho proposto (fase 2)

- **Registro de feature no Main** (`ownerKind: 'feature'`): nome humano
  (`feature/<slug>`), worktree sob o runtime do checkout, isento da purga
  por task e da falha no boot; remove só com branch integrada ou decisão
  explícita (nunca apaga commit não integrado).
- **IPC `feature:create|list|close`** — o renderer manda nome, nunca caminho;
  o Main deriva caminho e branch e devolve `featureId`.
- **Spawn por `featureId`**: o Main mapeia `featureId → executionScope`
  (`rootRealPath` = worktree, mesmo projeto/checkout) para shell (`pty-ipc`)
  e CLI (`bindSpawnAuthority`), e o sandbox recebe os caminhos git da
  worktree ligada (`linkedWorktreeGitPaths`, como no isolatedWriter).
- **Mão do operador**: `executionScope` distinto não pode acionar a trava
  F-563 quando o dono é uma feature do operador — a política distingue
  "writer isolado de missão" de "operador numa feature".
- **Missão na feature**: `mission.start` ganha `featureId`; o fast lane usa o
  `executionScope` da feature para orquestrador e roster; verificação, merge
  e push operam na branch da feature. É a parte mais cara e vem por último.
- **Renderer**: a aba guarda `featureId` + branch (`PaneModel.spaceId` já é
  a aba); o "+" ganha "Feature nova (branch + worktree)"; a aba mostra a
  branch em mono ao lado do título.

## Ordem sugerida

1. Registro `feature` + IPC + testes do contrato (sem UI).
2. Spawn de shell e CLI do operador na worktree (pty-ipc +
   spawn-authority), com teste de que o cwd fora da worktree continua
   recusado.
3. UI da aba com branch; fechar aba não apaga worktree.
4. Missão na feature (fast lane, sensores, integração).
