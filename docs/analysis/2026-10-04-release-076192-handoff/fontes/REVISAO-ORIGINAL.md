# Revisão adversarial — integração `ec8524a8` (base `32230db8`, 0.76.190)

Revisor: Claude (modo somente leitura no worktree `~/.nexus-worktrees/review-ec8524a8`).
Data: 03/10/2026.
Escopo: `git diff 32230db8 ec8524a8 -- . ':!docs/analysis'` (88 arquivos, +4716/−331), frentes F-766/767, F-769, F-770/771/772, F-774, F-775, F-776, F-777, F-778, F-779, F-785/786/787.

## Como foi verificado

- Li o diff inteiro e os 15 `docs/qa/items/F-*.md` da integração, além das seções de invariantes do `AGENTS.md`.
- Escrevi testes de reprodução **fora do worktree** (no scratchpad da sessão), apontando para os fontes do worktree por caminho absoluto. Nada foi editado nem commitado no repositório, e não usei `git stash`.
- Para o A/B contra a base, extraí `32230db8` com `git archive` para o scratchpad e rodei os mesmos testes lá.
- Rodei, com `--maxWorkers=2`, os **184 arquivos de teste que importam módulos alterados**. Não rodei a suíte inteira nem o typecheck.
- Medi as regexes novas com entradas adversariais de 16 a 64 KB e medi o custo de I/O do vault de memória.

## Resumo

| Gravidade | Quantidade |
|---|---|
| Crítico | 1 |
| Alto | 5 |
| Médio | 7 |
| Baixo | 7 |

**VEREDITO: reject.** Há um crítico e cinco altos sem correção. A integração também está vermelha: 12 testes falham em 4 arquivos, e os mesmos arquivos passam na base.

---

## CRÍTICO

### C1 — F-785: a missão criada pela mão do operador nasce com `maxWorkers: 0` e o helper da aba é recusado

**Onde**
- `src/main/orch/operator-hand-mission.ts:30-34`: agora passa `lane: suggestMissionLaneFromGoal(goal)`, usando o classificador **inteiro**. Ele devolve consult, plan e ops, não só o caso estreito de sincronizar o git.
- `src/shared/mission-intent.ts:808-822`: consult, plan e ops viram `maxWorkers: 0`.
- `src/shared/mission-intent.ts:1299-1306`: `assertWorkerBudget` lança `budget_exhausted: maxWorkers is 0 — no workers may spawn`.

**Quem chama** (todos derivam a lane de texto livre)
- Missão sob demanda do "+ Pane": `renderer-mission-authority.ts:902` monta o título `Missão · <60 chars da task do 1º helper>`, que vai para `operatorHandMissionContract` em `:834`.
- Auto-orquestração do `/hook/delegate` (F-200/F-708): `hook-delegate-endpoint.ts:437` usa o resumo do prompt do operador como título.
- "Tornar orquestrador" / "Criar missão desta aba": `renderer/lib/pane-mission-promote.ts:137` usa `Missão · <nome da aba>`.
- `nexus_mission_create` em Autopilot: `tools-domain.ts:364`.

**Evidência (A/B ponta a ponta, com gate, ficha PTY e stores SQLite reais)**
- Usei o teste existente `renderer-mission-authority-adoption.test.ts:713` ("missão sob demanda…") e troquei só o prompt da linha 729, de `"Revise o fluxo de login"` para `"Analise o fluxo de login e liste os riscos"`.
- Em `ec8524a8`: `Error: budget_exhausted: maxWorkers is 0 — no workers may spawn`, lançado em `src/main/orch/tools-panes.ts:1706`.
- Na base `32230db8`: o mesmo teste **passa**. O helper nasce como worker da missão da aba.

**Classificação real de títulos típicos** (`operatorHandMissionContract`)

| Título | lane | maxWorkers |
|---|---|---|
| `Missão · Analise o módulo de pagamentos…` | consult | 0 |
| `Missão · Investigue por que o build falha…` | consult | 0 |
| `Missão · Audite as dependências…` | consult | 0 |
| `Missão · Mapeie os endpoints…` | consult | 0 |
| `Missão · Entender como funciona…` | consult | 0 |
| `Missão · Planejar a arquitetura…` | plan | 0 |
| Abas `Deploy`, `Backups`, `Servidor`, `Publicar site`, `Migrar banco`, `Atualizar repo` | ops | 0 |
| Abas `Auditoria`, `Análise de logs`, `Diagnóstico do app` | consult | 0 |
| Aba `Planejamento` | plan | 0 |
| Título `Missão · Revise o diff…` | standard | 64 |
| Abas `Login`, `Terminais` | standard | 64 |

**Impacto**
- A delegação para de funcionar justamente no caso mais comum do "+ Pane": o primeiro helper é um analista read-only.
- No caminho do `/hook/delegate`, o hook "nunca descarta" (`tools-panes.ts:593`). O pane do operador fica **promovido a orquestrador de uma missão que não pode abrir worker nenhum**, recebe a diretiva "abra N workers" e todo `nexus_pane_spawn` falha até a missão acabar.
- A doutrina também muda para "solo"/"CONSULTA: não crie arquivos" (`orchestrator-doctrine.ts:124-127`).
- Os testes do F-785 **consagram o bug**: `operator-hand-mission.test.ts:25` afirma consult como desejado e nunca verifica `maxWorkers` nem o spawn.

**Correção mínima**
1. Em `operatorHandMissionContract`, não usar o classificador geral. Aceitar só `'ops'` por um predicado estreito de sync (ver A5) e nunca consult ou plan.
2. Em `createPaneMissionFromRenderer` / `adoptOperatorHandForSpawn`, não derivar lane nenhuma. Essas missões existem para hospedar helpers.
3. Adicionar ao teste ponta a ponta de adoção um caso com prompt de análise e outro com nome de aba "Deploy".

---

## ALTO

### A1 — A integração quebra 12 testes existentes (a base passa)

**Como rodei:** os 184 arquivos de teste que importam módulos alterados, com `--maxWorkers=2`. Resultado: **4 arquivos e 12 testes vermelhos**. Na base, os mesmos 4 arquivos passam (23 + 21 testes).

1. **`src/main/orch/task-router-quality.test.ts:156` e `:175`**
   - O que travavam: "tier critical com diversidade instalada — sem empréstimo".
   - O que acontece agora: com kimi e agy instalados, "auditar a segurança da autenticação" vai para `agy:gemini-4-argon` com `critical (tier hard — melhor opção instalada)`.
   - Causa: F-779, que pôs o Argon em `JUDGE_FRONTIER_LANE` (`task-router.ts:550`), somado ao catálogo do F-774.
2. **`src/main/orch/task-router-review-floor.test.ts:237`**
   - O que travava: "sem modelo de topo roteável, o ranking não muda" (F-214).
   - O que acontece agora: vem `grok:grok-4.7` em vez de `mimo-code:xiaomi/mimo-v2.6-pro`.
   - Causa: F-779, que pôs o grok-4.7 na lane (`task-router.ts:551`).
3. **`src/main/search/search-mixer-bootstrap.test.ts:101`**
   - O que travava: "Projection lives outside Git", ou seja, `.nexus-memory` **não** pode existir no checkout depois de um retain.
   - Causa: F-769 (ver A3). O autor inverteu o invariante equivalente em `workspace-memory.test.ts`, mas não viu este.
4. **`src/main/orch/hook-integration-endpoint.test.ts`: 8 dos testes novos do F-778**
   - Os testes dependem do `init.defaultBranch` global do git. O `beforeEach` faz `git init -q` (linha 54) e os testes assumem `main` (linhas 164, 288, 307).
   - Nesta máquina o git cria `master`, e `git branch --set-upstream-to=origin/main main` falha.
   - Com `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=init.defaultBranch GIT_CONFIG_VALUE_0=main`, os 15 passam. O teste não é hermético e fica vermelho em CI ou em qualquer máquina sem essa configuração.

**Impacto:** gate de release vermelho. Os itens 1 e 2 mostram que o F-779 mudou uma política travada por teste (F-214/F-233) sem decisão explícita. O relatório de integração diz "cada lote passou nos testes focados", mas a união não foi validada.

**Correção mínima**
- Item 4: `git init -q -b main` (ou `-c init.defaultBranch=main`) no `beforeEach`.
- Itens 1 e 2: decidir com o operador se a política F-214/F-233 muda. Se mudar, atualizar os testes de forma consciente. Se não, tirar Argon e Grok do caminho critical/sem-topo.
- Item 3: ver A3.

### A2 — F-778: o hook passa a bloquear `git merge --abort/--continue`, `git merge-base`, `merge-tree` e `merge-file` em checkout no `main`, inclusive no meio de um conflito

**Onde**
- `src/main/orch/hook-integration-endpoint.ts:100`: `/^\s*git\s+merge\b/u.test(segment) && protectedCwd()`. O `\b` casa antes do `-`, então `merge-base`, `merge-tree` e `merge-file` entram. Qualquer `git merge …` no main vira integração, inclusive `--abort`.
- `src/main/orch/integration-review-gate.ts:100`: a recusa resultante.

**Evidência:** repositório real no main com conflito em andamento (`UU a.txt`). Os seis comandos abaixo dão `hit=true` e a resposta `{"decision":"block","reason":"review_required: árvore suja — commite e peça o veredito do HEAD"}`:
- `git merge --abort`
- `git merge --continue`
- `git merge-base HEAD feature`
- `git merge-base --is-ancestor HEAD feature`
- `git merge-tree --write-tree HEAD feature`
- `git merge-file a b c`

Na base nenhum deles era bloqueado, porque sem o token `main` o hook nem disparava.

**Impacto**
- Um `git pull` com conflito no main (o pull não passa pelo portão), ou um merge aprovado que conflitou, deixa o agente **sem o comando de recuperação**.
- A mensagem manda **commitar a árvore suja**, que no meio de um conflito são os marcadores de conflito. Um LLM obediente pode commitar conflito no main.
- `git merge-base --is-ancestor` é justamente o comando que as missões de sync do F-785 usam para checar o estado, e agora está bloqueado.

**Correção mínima**
- Direção do merge: usar `^\s*git\s+merge(?=\s|$)` e ignorar `--abort`/`--quit` (são só rollback).
- `INTEGRATION_SEGMENT` (linha 35): trocar `git\s+merge\b` por `git\s+merge(?=\s)`. Isso conserta também o falso positivo antigo de `git merge-base … main`.
- Com `MERGE_HEAD` presente, responder com uma mensagem própria ("merge em andamento: resolva ou rode `git merge --abort`"), nunca "commite".
- Testes: `--abort` com conflito e `merge-base` no main precisam passar.

### A3 — F-769: o vault `.nexus-memory/` é escrito no checkout do operador a cada retain ou forget, inclusive a partir de pane read-only e de missão consult

**Onde**
- `src/main/memory/workspace-memory.ts:805`, `:1005` e `:1038` chamam `#exportVaultBestEffort()` (`:523`).
- `nexus-memory.ts:500-559` (`exportMemoryVault`) escreve `.gitignore`, as notas e os `INDEX-*.md` em `<rootRealPath>/.nexus-memory/`.
- `workspace-memory.ts:1393` (`noteWorkspaceRoot`): a raiz do vault é a do último escopo que **acessou** o store.

**Contradições no mesmo commit**
- O `nexus_memory_retain` foi liberado para todo pane e para contexto read-only com a justificativa escrita "só escreve no banco de memória em userData, nunca no workspace" (`gate.ts:148-152` e `mcp-effect-policy.ts:205-207`). O comentário antigo de `mcp-effect-policy.ts:143-146` diz o mesmo ("não toca workspace"). O mesmo commit passou a escrever no workspace.
- A descrição da tool mostrada aos agentes (`tools-memory.ts:97-99`) diz "automatic prompt context does not" incluir a nota. O F-769 passou a injetá-la (ver M1).
- O invariante travado em `search-mixer-bootstrap.test.ts:101` ("Projection lives outside Git") quebrou (A1, item 3).

**Impacto (privacidade e integridade da promessa read-only)**
- Notas do operador e de agentes passam a viver dentro da árvore do projeto sem ninguém optar por isso.
- Ferramentas que não respeitam `.gitignore` aninhado podem levar o vault junto: rsync, contextos de Docker, deploys CLI de pasta, backup e sync em nuvem.
- Um pane read-only, ou uma missão consult ("sem alterar nada"), faz o Main criar arquivos no projeto do operador.

**Correção mínima**
- Tornar a exportação no workspace **opt-in** (configuração) e nunca dispará-la a partir de contexto read-only ou consult. Ou manter o vault em `userData` e oferecer "Abrir no Obsidian" apontando para lá.
- Corrigir os comentários do gate e do effect policy e a descrição da tool.

### A4 — F-769: exportação síncrona O(N) no Main a cada retain ou forget, com raiz que troca em leituras

**Onde**
- `workspace-memory.ts:523-536`: `#activeProjectionRecords()` lê **todas** as memórias ativas, sem limite.
- `nexus-memory.ts:500-559`: para cada nota faz `lstatSync` + `readFileSync` + comparação, e `writeFileAtomic` com fsync do arquivo e do diretório. Depois faz `readdirSync` + `lstatSync` de tudo.
- Os gatilhos automáticos (handoff aceito, saída de sessão, preferência do operador) também passam por `retain` e pagam o mesmo custo.

**Medição** (macOS, APFS, scratch)

| N notas | 1ª exportação (fria) | Sem mudança | +1 retain |
|---|---|---|---|
| 50 | 524 ms | 2 ms | 21 ms |
| 500 | 4,9 s | 22 ms | 37 ms |
| 2000 | 20,6 s | 161 ms | 129 ms |

**Quando a exportação fria acontece**
- No primeiro retain depois do upgrade.
- Sempre que a raiz muda de checkout. O `operator-workspace-memory.ts:27` usa `ctx.executionScope` (worktree da aba, F-162) para **ler** a memória, e isso basta para `noteWorkspaceRoot` mover o vault. O próximo retain reescreve as N notas no outro checkout.

**Contexto:** hoje o banco tem 14 memórias, mas a doutrina nova manda todo worker gravar "pegadinhas" antes de cada handoff. Não há limite de taxa. Um agente em loop de `nexus_memory_retain` produz custo quadrático no Main. É a mesma classe de risco do F-764 (Main congelado com 12 a 16 panes).

**Correção mínima**
- Exportação assíncrona (`fs.promises` ou fora do Main), com debounce (≥ 2 s) e incremental: escrever só a nota alterada e o INDEX dela, e apagar só o arquivo esquecido.
- Fixar a raiz na criação do store, sem trocar em leituras.
- Limite de taxa por autoridade no retain de agente.

### A5 — F-785: o classificador "só sincronização" é largo e transforma tarefas de escrita em `ops`

**Onde:** `src/shared/mission-intent.ts:1049-1060`. Basta `atualiz*`, `pux*`, `pull` ou `fetch` junto de `git`, `github`, `repo`, `repositório`, `origin` ou `upstream`, sem os verbos de escrita listados.

**Evidência** (`suggestMissionLaneFromGoal`)
- Escritas classificadas como `ops`:
  - "atualize as dependências do repositório para a versão mais nova"
  - "atualizar o workflow do GitHub Actions"
  - "atualize o README do repositório"
  - "fetch os dados da API do GitHub e mostre no dashboard"
  - "puxe as issues do github e gere um relatório em docs/"
- Investigação que era consult e virou `ops`: "investigue por que o git pull falha".

**Impacto**
- Em lane ops, o done é aceito sem arquivo (`mission-delivery-artifact-gate.ts:162`, só nota de 40 caracteres). O portão "missão não pode ficar Concluída sem entrega real" enfraquece para tarefas que mudam código. A lane também zera `maxWorkers` (somado ao C1).
- `allowsTextDelivery` (`mission-delivery-artifact-gate.ts:164`) compara com `'consult'`. Missões standard com objetivo de investigação que cite git/pull/fetch **perdem** a entrega por texto que tinham.
- A sugestão do wizard (`MissionSetup.tsx:922`) também muda.

**Correção mínima:** exigir forma explícita de sincronização, por exemplo:
- comando git literal (`git pull`, `git fetch`, `--ff-only`, `fast-forward`), ou
- verbo de sync com objeto igual a repositório, branch, origin ou upstream, sem outros objetos como dependências, pacotes, README, docs, workflow, actions, issues, dados ou API.

Adicionar testes negativos com os exemplos acima.

---

## MÉDIO

### M1 — F-769: a "camada não verificada" cria um canal persistente de prompt injection entre agentes

**Onde:** `workspace-memory-context.ts:100` e `:291-295`. Notas `agent-authored:*` e `operator:*` entram no brief de spawn de todo worker (`tool-util.ts:1277`, `:1304`) e no hook do operador Codex (`operator-workspace-memory.ts`).

**Por que importa:** desde este commit, qualquer agente grava memória, inclusive panes read-only expostos a web, MCP e arquivos de terceiros (`mcp-effect-policy.ts:208`). Antes, a exclusão era decisão de design: a descrição da tool diz que "automatic prompt context … is reserved for Nexus-verified events". Há mitigação (rótulo "Unverified", teto de 1 KB, `sanitizeMemoryLine`), mas o texto que um scout lê numa página pode virar "pegadinha" injetada em todos os workers futuros.

**Correção:** limitar a camada às notas do operador e às notas de agentes da mesma missão. Ou exigir promoção pelo operador e excluir retains de sessões read-only ou com busca web. Atualizar a descrição da tool.

### M2 — F-766: a distância de 1 edição faz palavras comuns "provarem" que o operador nomeou uma CLI

**Onde:** `operator-cli-mentions.ts:151-198` (`withinOneEdit` e `aliasMatches`). A prova é usada em `tools-panes.ts:981-1000`. O pin explícito do Maestro deixa de ser redistribuído, e `operatorChoice:true` passa a valer.

**Evidência** (todos `true`):

| Texto digitado | CLI "provada" |
|---|---|
| "mude o botão de lugar" | muse |
| "passa o mouse em cima do card" | muse |
| "isso devia funcionar já" | devin |
| "deixa a tela minimal" | minimax-code |
| "cria um memo" | mimo-code |
| "isso é um mito" | mimo-code |
| "uma table nova" | claude (fable) |
| "a clause do contrato" | claude |
| "os cursos de inglês" | cursor |

**Impacto:** enfraquece o F-195/F-682, guarda criada porque o Maestro pinava sozinho 4 de 4 helpers. "devia" e "mude" são palavras de todo dia em português.

**Correção:** trocar a edição genérica por erros de digitação explícitos por alias (ex.: `qwen: ['qwhen','quen']`) e manter o padrão de espaço/hífen flexível. Alternativa: exigir uma deixa de seleção colada ("cadê/usa/abre/no/com o …") para casamentos fuzzy. Adicionar testes negativos.

### M3 — F-771: `WEB_SEARCH_NEED` dispara em texto comum de código

**Onde:** `task-router.ts:1071` e o filtro em `:1105-1113`.

**Evidência**
- `taskNeedsWebSearch` dá `true` para:
  - "a versão atual do app trava ao abrir o login"
  - "compare a versão atual com a anterior e corrija a regressão"
  - "confira se a versão atual do schema bate com a migração"
  - "refatore usando o estado da arte em hooks do React"
- Pool {codex, glm, claude*, kimi*} (asterisco = declara webSearch) com o bug acima: rota `kimi:kimi-code/k3`, só com claude como alternativa. Sem a frase "versão atual", a rota é `glm:glm-5.3`.

**Impacto:** concentra trabalho comum nas CLIs de ponta e caras (claude, agy, kimi, grok), o contrário do objetivo de diversidade do F-770.

**Correção:** exigir verbo explícito de busca (busque, pesquise, procure ou consulte na web/internet/online; search the web). Tirar "versão atual" e "estado da arte" soltos.

### M4 — F-775: o planejador "puro" do failover roda 3 processos git síncronos no Main, com git cru

**Onde:** `failover-mission-respawn.ts:67-108`. `planMainOwnedFailoverRespawn`, documentado como "Planeamento puro", chama:
- `collectFilesModified`: `execFileSync git rev-parse` (timeout 3 s) e `git status --porcelain` (timeout 5 s);
- `execFileSync('git', ['-C', cwd, 'diff', '--stat'])` (timeout 3 s).

Pior caso: 11 s por pane, em série quando a cota de uma conta acaba para N panes de uma vez.

**Riscos adicionais**
- Esses `execFileSync` usam o ambiente e a config local do repositório. Não passam pelo `safeGitArgv` (`-c core.fsmonitor=false`, …) nem pelo `assertSafeLocalGitConfig`, que o próprio `git-command.ts` exige em checkouts que agentes podem escrever. Um `core.fsmonitor` ou `diff.*.textconv` plantado executa fora do sandbox.
- Em checkout compartilhado da missão, "Touched files" lista o trabalho de outros workers.

**Correção:** coletar de forma assíncrona com `AsyncGitRunner` + `assertSafeLocalGitConfigAsync`, com timeout curto (≤ 1 s) e fora do planejador, restrito ao worktree do próprio pane.

### M5 — F-776: o brief canônico mudou sem trocar o marcador, e briefs gravados pela 0.76.190 deixam de valer

**Onde:**
- `guided-greenfield-brief.ts:85`: a seção nova.
- `guided-greenfield-brief.ts:146`: aceita só igualdade byte a byte com a renderização atual. O marcador continua `…:v1` (linha 3).

**Evidência:** `parseGuidedGreenfieldBrief(renderAntigo(intent))` devolve `null`. O brief novo faz round-trip normalmente.

**Impacto:** projetos greenfield criados antes do upgrade caem para `repository-product-doc` (`orientation-bootstrap-context.ts:193-205`) e perdem a revisão mecânica do bootstrap (`:286-299`). O teste do F-776 (`guided-greenfield-brief.test.ts:35`) só testa novo→novo.

**Correção:** marcador `v2` com aceitação do template `v1` legado, ou levar a instrução do stack-advisor para fora do brief canônico (a carta já tem). Adicionar um fixture v1.

### M6 — F-779: a lane de julgamento prioriza modelos de acesso incerto

**Onde:** `task-router.ts:550-551`.

**Como acontece**
- Com Claude e Codex já usados na missão, a revisão vai para `agy:gemini-4-argon`.
- O próprio catálogo avisa "acesso restrito (Fairwind → Ultra → API paga)". Sem acesso, entram a quarentena (F-683) e o F-520, que troca para modelo não-frontier.
- O veredito desse pane não conta no F-234. O F-234 continua íntegro, porque a identidade é o modelo da sessão. O que se perde é um ciclo de revisão inteiro e tempo do Maestro.

Também causa 3 dos 12 testes vermelhos (A1).

**Correção:** só sentar o Argon com prova de acesso (conta/catálogo/sonda, fora da quarentena) e manter Claude e Codex à frente em auditoria de segurança critical.

### M7 — F-786: a regex de admissão rebaixa entrega boa e cria assimetria com o MCP

**Onde:** `turn-end-handoff.ts:288` (`ADMITS_INCOMPLETE_RE`) e `jev-handoff-review.ts:443` (`weak` vira `partial`).

**Evidência:** "Não foi possível reproduzir o bug antes do fix; agora os 12 testes passam (npx vitest run)." vira `partial`.

**Assimetria:**
- No MCP, `weak` vira success marcado.
- No PTY, qualquer sinal (até os que o MCP nem devolveria) vira `partial`.
- `partial` sai do portão de regressão e do done (`mission-delivery-artifact-gate.ts` só conta success). CLIs sem MCP podem entrar em loop de redespacho.

**Correção:** aplicar a regex só ao fechamento ("não consegui <verbo> <objeto da tarefa>" no último parágrafo) ou só quando o Jev estiver indisponível. Para `weak` sem sinal de devolução, espelhar o MCP.

---

## BAIXO

- **B1 — F-787**
  - Onde: `tools-panes.ts:1908-1909`.
  - O quê: `resolveCodexCliVersion()` faz probe síncrono de `codex --version` (`execFileSync`, até 3 tentativas de 5 s, inclusive com o PATH do login shell) quando o cache está frio, antes das validações. O F-787.md promete "nunca probar --version".
  - Correção: usar só uma leitura de cache (`peek`).
- **B2 — F-778**
  - Onde: `hook-integration-endpoint.ts:113-243`.
  - Custo: a isenção roda até cerca de 9 `spawnSync` git no Main por `git merge … main`. O handler é async e já existe `AsyncGitRunner`.
  - Limite: a isenção confia em refs remote-tracking, que podem ser gravadas localmente (`git update-ref`). É heurística, não prova. O push continua barrado.
- **B3 — F-774**
  - Onde: `pricing.ts:228`.
  - O quê: `opencode/deepseek-v4-flash` a $0. Antes saía $0,27/$1,10 pelo prefixo `deepseek`. O próprio F-683 (`model-access-quarantine.ts:5-8`) registra "Model access is disabled" nesse id. O router o vê como grátis, e a quarentena some no reinício.
- **B4 — F-772**
  - Onde: `mission-work-kind.ts:168`, `:274`.
  - O quê: o `AUDIT_SCOPE` suprime bug para substantivos de domínio. "o inventário do estoque trava ao abrir" vira `unknown`.
- **B5 — F-770**
  - O quê: correções de segurança e bug no tier medium agora rodam pelo CLI menos usado. A política é intencional, mas tira o assento do líder do multi-score em correção de segurança. Vale manter `security` fora da rotação.
- **B6 — Testes que não testam o que dizem**
  - `operator-hand-mission.test.ts:25`: consagra consult sem olhar `maxWorkers` (C1).
  - `guided-greenfield-brief.test.ts:35`: só round-trip novo→novo (M5).
  - `failover-mission-respawn.test.ts:157`: o nome diz "recibo pinned", mas o recibo não é verificado. O teste também roda `git` real contra `/workspace/mission-checkout`, que não existe (não hermético).
  - `hook-integration-endpoint.test.ts`: sem caso de `--abort`/`merge-base` e dependente de `init.defaultBranch` (A1, A2).
  - F-766 e F-771: nenhum caso negativo com palavras comuns.
- **B7 — Processo (AGENTS.md: "1 bug = 1 F-XXX.md")**
  - O F-769.md agrega pelo menos quatro defeitos distintos e uma UI: tools fora do allowlist, bloco vazio, contador inflado, projeção invisível e alerta.
  - O F-778.md agrega falso positivo e falso negativo.
  - Os commits estão por frente, com `git add` por arquivo.

---

## O que conferi e está OK

- **Regexes novas são lineares.** Testei com 16 a 64 KB adversariais `linkifyFilePaths`, `WEB_SEARCH_NEED`, `ADMITS_INCOMPLETE_RE`, `AUDIT_SCOPE`, os padrões do F-785, `stripNestedHandoffPacks` e o padrão flexível do F-766. Nenhuma passou de 6 ms. Não há regex nova em tap de chunk de PTY. O tap do F-766 é de **input humano** e custa O(n ≤ 4000) por tecla.
- **O `/hook/integration` só chama git em segmento `git merge`.** O ajuste do Maestro no F-778 está correto. `executionScopeFor` e `isInsidePath` são puros.
- **O evento do F-787 não carrega dado sensível.** Sem prompt, argv, ambiente, conta, fingerprint nem token; `classifySpawnErrorCode` nunca devolve a mensagem crua.
- **O F-775 melhora a privacidade.** Antes, o religamento main-owned escrevia o rótulo da conta em texto cru no PTY; agora tudo sai por `maskAccountLabel`. O pacote não casa `detectLimit`.
- **Os panes sintéticos do F-777 são só leitura.** Não persistem nem viram autoridade. Os tetos de 64 batem com o schema do snapshot.
- **Invariantes do AGENTS.md:**
  - Uma sessão por CLI, prova de login, fingerprint opaco, regra de folga e overlays por provider-state: nenhum foi tocado.
  - F-234: continua fail-closed no push. Os riscos estão em A2 (falso positivo), B2 e M6.
  - F-233/F-214: a política mudou sem decisão registrada (A1, itens 1 e 2).

## Reprodução (resumo)

- **C1:** no teste `renderer-mission-authority-adoption.test.ts:713`, trocar o prompt da linha 729 para "Analise o fluxo de login e liste os riscos". Em `ec8524a8` falha com `budget_exhausted: maxWorkers is 0`; na base (`git archive 32230db8`), passa.
- **A1:** `npx vitest run --maxWorkers=2 src/main/orch/task-router-quality.test.ts src/main/orch/task-router-review-floor.test.ts src/main/search/search-mixer-bootstrap.test.ts src/main/orch/hook-integration-endpoint.test.ts` dá 12 falhas em `ec8524a8` e passa em `32230db8`.
- **A2:** repositório real no main com conflito, depois `handleHookIntegrationRequest(ctx, {tool_name:'Bash', tool_input:{command:'git merge --abort'}})` resulta em `block`.
- **A4:** `exportMemoryVault(root, N notas)`, cronometrando N = 50, 500 e 2000.
- **M2:** `type(sessão, 'mude o botão de lugar')` seguido de `operatorRecentlyNamedCli(sessão, 'muse')` dá `true`.
- **M3:** `routeTask('a versão atual do app trava ao abrir o login; corrija', …)` com glm, codex, claude e kimi resulta em kimi.
- **M5:** renderizar com o fonte da base e passar pelo `parseGuidedGreenfieldBrief` atual dá `null`.

VEREDITO: reject
