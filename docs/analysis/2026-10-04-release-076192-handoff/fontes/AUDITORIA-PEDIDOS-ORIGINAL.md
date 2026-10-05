# Auditoria de cobertura — Missão · Terminais (03/10/2026)

Conferência somente leitura: tudo o que o operador pediu e tudo o que as análises 02–07 apontaram foi tratado? Gerada em 03/10/2026 ~14:20 (BRT).

- Estado da integração no momento da conferência: branch `missao-terminais/integracao`, worktree `~/.nexus-worktrees/terminais-integracao`, código em **`0044a332` (14:18:37)**; o HEAD seguinte, `650c04f0` (14:20), é só documentação (handoff da integração). A branch avançou 6 vezes enquanto a auditoria rodava (be36c21b → d371b37b → 0044a332 → 650c04f0); os estados de código abaixo valem para `0044a332`.
- Fontes: `integration-report.md` (§1–3, §9), transcript do orquestrador `82e0190b…jsonl` (texto do operador/assistente, planos em thinking e tool calls, extraído com node), `briefs/01–32`, análises `docs/analysis/2026-10-03-missao-terminais/02…07`, `docs/qa/items/F-7xx.md` da integração, `git log 32230db8..HEAD`, worktrees em andamento (`git log`/`status` com `GIT_OPTIONAL_LOCKS=0`, sem tocar em nada), cópia do banco `dbs/mission-runtime.sqlite3` (copiada para o scratchpad e lida com `mode=ro`).
- Fora do escopo (já auditado por outro agente): `01-memoria.md` e seus 12 passos (F-768/F-769 + F-798..F-801).
- Legenda: **integrado** = commit na branch de integração; **em andamento** = worktree de outro agente com commits/alterações visíveis; **NÃO COBERTO** = nenhum item integrado nem em andamento trata; **decisão** = recomendação da análise que exige escolha do dono antes de virar código.

## 0. Resumo

- Dos 8 pedidos do operador, 7 estão cobertos (integrados ou em andamento). O #2 está parcial: os sub-pedidos de grafo/modelo de negócio dependem da fase 2 da memória (F-798..F-801, escopo não verificado), não existe plano consolidado, e **a release não foi feita** — suíte completa, revisão cruzada, merge no `main` e release continuam pendentes.
- Nas análises 02–07, toda lacuna numerada (G1–G9, itens do 03, A–D do 04, passos 1–4 do 05, L1–L6, P1/P2 do 07) tem dono, exceto **8 pontos NÃO COBERTOS** (N1, N2, N5, N7, N8, N9, N10, N11) e **2 decisões** do dono (D1, D2). O restante está integrado (maioria) ou em andamento (G4/G6 = F-773, L3 = F-782, item 2 do 03 e fiação do pack no renderer = F-775, F-795, F-797). Detalhe em §2.1–2.6.
- Do incidente e do próprio orquestrador saíram 4 itens que ninguém pegou (N3, N4, N12, N13). Os dois mais sérios do conjunto: a **lane governada que continua só Codex** (N1) e o **inventário que chama de "pronto" uma chave inválida** (N3). Dois itens que pareciam órfãos ganharam dono durante a conferência (N6 → F-822 no `f765-775b`; N14 → pesquisa externa no `memoria2`) e ficam marcados como em andamento.
- A revisão adversarial da integração **aconteceu** (`review-ec8524a8.md`, 14:13, veredito `reject`: 1 crítico, 5 altos, 7 médios, 7 baixos). Nenhum achado dela coincide com N1–N13 (cruzado por termos); os achados têm dono em `HANDOFF-INTEGRACAO.md` §4 (worktrees `fix-intent`, `fix-gate`, `fix-router`, `f765-775b`, `f782-773`, `memoria2`, `async-io`), exceto A1 (12 testes vermelhos), B6 e B7, sem dono nominal — ver §2.6a. A segunda revisão do diff final, a suíte completa, o merge no `main` e a release continuam pendentes.
- Ações só do operador: chave nova do Qwen, religar OpenCode/LongCat/Aider, `npm install` (electron 43.0.0 em disco × 43.7.4 no lockfile), decidir o destino da missão `809f0e49` (hoje `blocked`) e das 29 worktrees do runtime, logins de OpenClaude/Muse-via-Claude, teste de campo do failover com 2 contas.

## 1. Pedidos do operador → o que foi feito → estado → evidência

| # | Pedido (hora) | O que foi feito | Estado | Evidência |
|---|---|---|---|---|
| 1 | 10:46 "atualiza nosso repositório local com github" | `git pull --ff-only` 25527c54 → 32230db8; `main` hoje em 6050422d (0.76.191). O portão F-234 barrou o `merge --ff-only` → F-778. Pendência deixada ao operador: `node_modules` defasado (o handoff prevê `npm ci` no passo 5 da publicação) | **concluído** (residual: `npm ci`, ver §4) | transcript L193–L235; `node_modules/electron/package.json` = 43.0.0 × lockfile 43.7.4 |
| 2a | 10:56 análise refinada de toda a orquestração | `07-orquestracao.md` (Codex, *partial*: autoria do "siga" não comprovada) → F-765, F-778, F-785/786/787, F-792, F-793 | **integrado** | `11d49d24` (docs no main); commits 7bcafbe2, 4951f5ae, b0a7b5b8, 2b28332a, 52509b37, f4b8e96f, 92380755 |
| 2b | onde a memória realmente salva | `01-memoria.md` §2 (mapa de 8 depósitos) | **entregue** (auditado à parte) | `11d49d24` |
| 2c | memória de longa duração entre todas as LLMs | F-768 (escrita), F-769 (leitura, tools sempre permitidas, vault) + projeção fora do Main; fase 2 F-798..F-801 | **integrado + em andamento** | 9c2e4005, e52e7dee, 00ecf538; worktree `terminais-memoria2` (2 arquivos sem commit) |
| 2d | estudar ai-memory (Akita)/graphify/Obsidian e trazer a tecnologia de grafos | Pesquisa Muse chegou **só como resumo** (handoff-3ab1ed29: `artifacts_json` com 756 bytes; o corpo ficou no pane que fechou sozinho — ver N12). `01-memoria.md` §6 desenha "grafo ou texto" (não criar grafo novo; wikilinks + `nexus_code_map_blast_radius` + backlinks; graphify opcional). Implementado: vault markdown estilo Obsidian com wikilinks (F-769). Elo memória ↔ raio de impacto e **refazer a pesquisa externa** estão no escopo declarado do `memoria2` ("recall por raio de impacto", "pesquisa externa (ai-memory/graphify/Obsidian)", `HANDOFF-INTEGRACAO.md` §4) | **parcial / em andamento** (escopo declarado, não verificado no código) | `dbs/mission-runtime.sqlite3` handoffs; `01-memoria.md:157-159`; `docs/qa/items/F-769.md`; `HANDOFF-INTEGRACAO.md` §4 |
| 2e | saber a hora de usar grafo | Regra escrita em `01-memoria.md:159` (FTS para "o que sabemos sobre X"; grafo para relação: "o que quebra se mexer aqui", "quais regras governam este fluxo", "que decisões dependem desta"). Não está codificada como doutrina/skill nem no brief; o "recall por raio de impacto" do `memoria2` operacionaliza a metade "grafo para relação" | **parcial / em andamento** (a regra em si continua só documentada) | `01-memoria.md:159`; `HANDOFF-INTEGRACAO.md` §4 |
| 2f | mapear o modelo de negócio para não quebrar features | Já existe (`<business-model>` por HEAD injetado em todo brief; `.context/docs/business-model.md` de 18/07). `01-memoria.md` propõe tipo `architecture-rule` ligado ao modelo de negócio (hoje sem escritor); o `memoria2` declara "escritores de regra/preferência" (F-798..F-801). Nenhum F-item integrado mexeu em business-model | **parcial / em andamento** (não verificado no código) | `01-memoria.md:24-25,146`; `HANDOFF-INTEGRACAO.md` §4 |
| 2g | libs/tecnologias mais novas e linguagem certa por alvo (Ruby, Go, Rust, C++…) | F-776: skill `stack-advisor` (Windows → Rust+windows-rs, C++/WinUI 3 ou .NET; CLIs → Go/Rust; macOS → Swift; Ruby/Rails só legado), carta de engenharia endurecida, brief greenfield aponta para a skill. Passo 3 (registro em `.context/docs/stack-decision.md`) parcial; passo 4 (sensor de frescor) não feito — ver N8/N9 | **integrado** (passos 1–2), **NÃO COBERTO** (passos 3–4) | 374181ea; `assets/skills/stack-advisor/SKILL.md:24-33`; `engineering-charter.ts:22`; `guided-greenfield-brief.ts:87` |
| 2h | Nexus autônomo decide melhor e erra menos | F-770/771/772 (diversidade, capacidade, skill/especialidade), F-774 (tabelas), F-779 (lane de juízes), F-765 (recuperação de erro permanente), F-786 (handoff mecânico), F-791/F-792 (boot); F-773 (roteador aprende) e F-782 (Jev aprende) em andamento | **integrado + em andamento** | commits acima; worktree `terminais-f782-773` (5 commits à frente) |
| 2i | Jev e Clef usados de verdade | `06-uso-real.md`; F-783 (Clef recebe researchTriage/rank/rankTool), F-784 (delegação paralela com teto), F-796 (toggles valem); F-782 (feedback Certo/Errado) em andamento | **integrado + em andamento** | 0725aa57, 19a98860, 29328ae9; `terminais-f782-773` ca90602a |
| 2j | navegador interno usado como deveria | F-781 (WebFetch negado onde o navegador está ao alcance; regra no brief de toda CLI). Alcance limitado: worker ad hoc nasce com `allowedTools: []` e sem `nexus_browser_*` → F-797 em andamento | **integrado + em andamento** | dd4b07ca; `docs/qa/items/F-781.md` ("Fora do escopo: expor o navegador ao worker"); worktree `terminais-f780-781` (12 arquivos) |
| 2k | skills, tools e agentes do Nexus sendo usados | F-772 (skill por papel e por CLI), F-776 (skill nova), F-780 (nome/categoria da tool no journal); nome da skill em andamento (complemento F-780). Sem item: ~125 das ~170 tools MCP nunca chamadas; "agentes" (squads salvos com modelos antigos) — ver §3 | **parcial** | ee6c960e, dcecb185; `06-uso-real.md` §2 |
| 2l | plano de melhoria robusta | Planos distribuídos nas 7 análises + placar do orquestrador no chat; não existe documento único consolidado | **parcial** (menor) | `docs/analysis/2026-10-03-missao-terminais/` |
| 2m | soltar os panes e analisar como estão saindo | 8 analistas e 16 frentes de writers (mais reenvios) em 11 CLIs; bugs achados ao vivo viraram F-790, F-766/767, F-788/789, F-791, F-792, F-793, F-794 | **feito** | `integration-report.md` §3 |
| 2n | corrigir os erros já nesta missão | 30 F-items integrados na branch (agrupados em §2.9) | **integrado** | `git log 32230db8..0044a332` |
| 2o | lançar uma melhoria robusta e versão | **Não feito.** A tag local `v0.76.191` aponta para 6050422d (só o hotfix) e nunca foi enviada; o handoff prevê recriá-la no HEAD final. Revisão cruzada: a do orquestrador falhou (Fable vazio, Qwen 401); a adversarial de `ec8524a8` foi feita às 14:13 com `reject` e seus achados estão sendo corrigidos; **falta a segunda revisão do diff final**, a suíte completa, `npm ci`, merge no `main` (não é fast-forward), CHANGELOG/release-notes, `release:mac` e publicação (`HANDOFF-INTEGRACAO.md` §6, passos 3–9) | **NÃO FEITO** (pendência de fechamento, com plano) | `review-ec8524a8.md`; `HANDOFF-INTEGRACAO.md` §5–6; `review-fable.md` 0 bytes; `review-qwen.err` 401 |
| 3 | 11:01 print do Codex 400 (`gpt-6.1-sol` não suportado) | Destravado à mão (Codex do Homebrew → 0.160.0; hoje ambos em 0.160.0) + F-790 (CLI duplicada: escolhe a instalação mais nova; sonda `--version` fora do Main) + F-765 (recuperação automática) | **integrado** | 0fe816c9, 50403614, 7bcafbe2 |
| 4 | 11:02 saber qual modelo/quando/qual esforço; usar todas as LLMs, desde o Qwen | F-770/771/772, F-774, F-779, F-766/767 integrados; F-773 (laço de resultado) em andamento. Residual: lane governada só Codex (N1) | **integrado + em andamento**; residual N1 | 2fd9a60b, a3c34c03, ee6c960e, 5843c820, 63c2e513; `terminais-f782-773` b9a160d8 |
| 5 | 11:04 "cadê muse, qwen, grok, devin, agy"; multiconta troca inteligente no meio da tarefa | F-766 (pedido tecla a tecla prova a escolha); F-775 item 1 (pack estruturado); item 2 (trocar de CLI quando todas as contas esgotam) em andamento, junto com a fiação do pack no renderer | **integrado + em andamento** | 3d9466cd, 0c90641c; worktree `terminais-f765-775b` (`switchTaskToAnotherCli`, `event.continuity`) |
| 6 | 11:08 "por que não estava usando esses LLM? limitação do Nexus?" | Causas achadas e tratadas: pedido ignorado (F-766), "qwen3" não casava (F-767), Qwen morre no boot em cwd longo (F-788), MiniMax morre pelo Node errado (F-789), agy Argon + `--effort` (F-791), morte no boot sem aviso (F-792). Causas do operador: chave Qwen inválida (401), OpenCode/LongCat/Aider `enabled:false`. DeepSeek "falso negativo": não reproduzido; teste de regressão adicionado | **integrado**; parte é ação do operador (§4) | 38115c55, 66e39962, 106e98a3, f4b8e96f, c89e04cd; `~/.nexus/providers.json` |
| 7 | 11:13 "a animação visual não mostra o orquestrador e todos" + print | F-777 (projeção desenha orquestrador, helpers e cabos) + F-793 (raiz: helper com ACK pendente entra em `mission_panes`). Validação visual por harness (PNGs em `patches/2406a2522e26/ignored-output/f777/`); app real não verificado; cabos atrás dos cards com 20 helpers ficou como polimento | **integrado** (visual no app real: não verificado) | 60149efd, 92380755 |
| 8 | 11:20 "refazer mesmo sem pedir; usar tudo de forma inteligente; o multi-score favorece os mesmos CLIs" | F-779 (lane de juízes com Argon e Grok, veto a MiMo/GLM mantido), F-770 (fair-share em bug/security/visual), F-767 adendo Qwen; versão do Devin (`724a86ca`) descartada. A revisão adversarial (M6) pediu que o Argon só entre com prova de acesso → F-817 em andamento (`fix-router`, abb9b92d) | **integrado + ajuste em andamento** | 63c2e513, 2fd9a60b, b0a33d75; `terminais-fix-router` |

Pedido fora do orquestrador (sessão `8dd379fd`, 11:42): travamento do Main → F-764 no `main` (6882c3c5, 0.76.191) + blindagem: A.1 profile JS automático, A.3 métricas de event-loop e C.7 faixa "Nexus ocupado" **integrados** (20db9422, fb4e6b84, e756d8a9); C.1/C.2 chunks em lote e taps fora do Main, C.3 teto de tempo em toda regex do PTY, C.4 intervals com orçamento, C.5 lint contra `*Sync`, C.6 semáforo, tempo por tap **em andamento** (`terminais-f764-struct` 1 commit à frente; `terminais-async-io` 10 arquivos). Falta rodar o probe A.1 no binário assinado (`--verify-hang-probe`, `HANDOFF.md` §5).

## 2. Lacunas das análises 02–07 → cobertura

### 2.1 `02-roteamento-e-diversidade.md`

| Lacuna | Cobertura | Estado |
|---|---|---|
| G1 validação do modelo contra o binário errado | F-790 escolhe a instalação mais nova e faz auto-update/descoberta mirarem o mesmo binário; **não** compara a proveniência do `models_cache.json` com a versão do binário (`client_version` não é lido em lugar nenhum de `src/main`) | **parcial → N2** |
| G2 `bug/security/visual` desligava a diversidade | F-770: guards só com `policy.source === 'benchmark'` ou visual lane aplicado | integrado (2fd9a60b) |
| G3 eixo de capacidade | F-771: `AdapterRouteCapabilities`, `capabilities.webSearch` em claude/agy/kimi/grok, filtro antes do ranking. `maxContext` existe no tipo (`task-router.ts:622`) mas nenhum manifest o preenche e nenhum filtro o usa | integrado (a3c34c03); `maxContext` só declarado (menor) |
| G4 laço de sucesso por (CLI, modelo) | F-773: migração 041 (`adapter_id`, `model`, `ack_verdict`), termo ±(taxa−0,5)×10 com ≥5 amostras. Taxa por especialidade declarada fora do escopo (sem vínculo decisão↔sessão) | em andamento (`terminais-f782-773` b9a160d8, 429c45f8) |
| G5 catálogo defasado (ultraspeed) | F-774: linhas removidas, catálogo `api-only`, contrato reprova id fora do catálogo/deprecated/api-only | integrado (5843c820) |
| G6 route-log volátil | F-773: tabela `route_decisions` (migração 042, retenção 30 d/5.000 linhas) | em andamento (`route-decision-ledger.ts` sem commit no worktree) |
| G7 viés de skill + "auditoria" → bug | F-772: `skillCatalogForTaskRole`, `cliSupportsSkillSurface`, `AUDIT_SCOPE`; `stack-advisor` continua no catálogo para todo papel (conferido: não está em nenhum conjunto excluído) | integrado (ee6c960e) |
| G8 esforço | sem ação (a análise mesma conclui) | n/a |
| G9 (adendo) lane de juízes | F-779 | integrado (63c2e513) |
| §3 "lane governada é só Codex" (hipótese não provada) | **Confirmado no código, e ninguém tratou** | **NÃO COBERTO → N1** |
| §3 DeepSeek/OpenClaude/LongCat/Muse-Claude `login-needed` | DeepSeek: não reproduzido, teste adicionado (c89e04cd); os demais são login do operador | integrado / §4 |
| §3 OpenCode/LongCat/Aider `enabled:false` | configuração do operador | §4 |

### 2.2 `03-multiconta.md`

| Item | Cobertura | Estado |
|---|---|---|
| Menor primeiro passo: pack estruturado (motivo + janela, arquivos + diff, próximo passo, anti-loop, teto) | F-775 item 1 (`failover-handoff.ts`, `failover-mission-respawn.ts`) | integrado (0c90641c) |
| Lacuna declarada pelo writer: renderer `failover-controller.ts` não passa os campos novos | Hoje `failover-controller.ts:148-156` passa só labels/reason/role/missionId/openWorkHint/scrollback; o worktree `terminais-f765-775b` adiciona `event.continuity` (limitWindow, touchedFiles, diffStat, nextStep) | em andamento |
| Item 2 do brief: trocar de CLI quando todas as contas esgotam | `switchTaskToAnotherCli` + `fromAdapterLabel` no pack, só no worktree (`grep` na integração: 0) | em andamento |
| Teste (1) unidade anti-loop / (2) integração switched só após respawn | F-775 (anti-loop, teto, máscara) e F-765 (`switched` só após religamento comprovado, `failover-model-recovery.test.ts`) | integrado |
| Teste (3) de campo com 2 contas Claude | não feito; exige app real e contas | **ação de campo → §4** |
| Não transplantar transcript | decisão mantida | n/a |
| Risco §4 do relatório de integração: `execFileSync('git diff --stat')` no caminho do failover | continua em `failover-mission-respawn.ts:14,81` (timeout 3 s, Main) na integração; a revisão adversarial (M4) achou mais dois `execFileSync` em `collectFilesModified` e a falta de `safeGitArgv`; dono: **F-822** no `terminais-f765-775b` ("git assíncrono no planejador do failover") | em andamento (N6) |

### 2.3 `04-estudo-de-modelos.md`

| Item | Cobertura | Estado |
|---|---|---|
| A.1 preço `gemini-4-argon` | `pricing.ts:113` (estimado, comentado) | integrado |
| A.2 preços Qwen 3.x | `pricing.ts:214-218` | integrado |
| A.3 aliases Kimi K2.7 | `pricing.ts:140-141` | integrado |
| A.4 `grok-composer-2.5-fast` legado | `pricing.ts:184-186` (comentário LEGADO); catálogo `deprecated` (`model-catalog.json:158-159`) | integrado |
| B.1 `gemini-4-argon` no `model-catalog.json` | `model-catalog.json:240`, `updatedAt` 2026-10-03 | integrado |
| B.2 default do Claude → `claude-sonnet-5-5` | **não feito**: `model-catalog.json:6` continua `claude-sonnet-5`. F-774 recusou porque o binário em uso (2.1.283) não conhecia o 5.5; com o F-790 o pane passa a usar o 2.1.288 (`~/.local/bin/claude`), que traz `claude-sonnet-5-5` nas strings (36 ocorrências) | **NÃO COBERTO → N5** |
| B.3 `grok-composer-2.5-fast` deprecated | feito | integrado |
| C.1 trivial liderado por barato/rápido | `task-router.ts` trivial: `gpt-6-luna`, `gemini-3.8-flash-low`, `3.7-flash-low`, grok depois | integrado |
| C.2 rotas OpenCode legadas | mantidas de propósito nos ids que a CLI lista (`task-router.ts:191,224,267`; `F-774.md`) | decisão registrada |
| D ranking fixture de 13/09 | `resources/model-ranking.json` continua `suiteRevision: "fixture"`, `generatedAt` 2026-09-13; nenhum F-item | **decisão → D2** |
| §4.1 matriz modelo/esforço por tipo de tarefa | não codificada: `HEURISTIC_SPECIALTY_ADAPTERS` todo vazio (`mission-route-specialty.ts:106-116`), `mission-specialty-benchmark.json` vazio "de propósito"; qualidade publicada já entra no multi-score; esforço por especialidade existe (`HEURISTIC_EFFORT_FLOOR`) | **decisão → D1** |
| §4.2 agy exige esforço no sufixo | F-791 | integrado (106e98a3) |
| preço de `gpt-5.6-sol` divergente ($5/$30 × $1,20/$6) | não resolvido (a análise marcou "não verificado") | aberto, menor |

### 2.4 `05-stack-e-libs.md`

| Passo | Cobertura | Estado |
|---|---|---|
| 1 skill `stack-advisor` empacotada e registrada | `assets/skills/stack-advisor/SKILL.md`, `bundle-skills.mjs`, `skill-mirror.ts`, manifesto gerado | integrado (374181ea) |
| 2 carta de engenharia (registro na hora, recusa de deprecated, pin) | `engineering-charter.ts:22` | integrado |
| ligação greenfield | `guided-greenfield-brief.ts:87` | integrado |
| 3 `.context/docs/stack-decision.md` via `nexus_context_draft_propose` | o brief diz só "record the outcome as governed implementation evidence"; nenhuma referência a `stack-decision` ou `context_draft` em `src/` | **parcial → N8** |
| 4 sensor `stack-freshness` (fail-open) | não existe; e o próprio repo do Nexus segue sem dependabot/renovate/`npm outdated` (`.github/` só tem `workflows/`) | **NÃO COBERTO → N9** |
| não virar especialidade do Jev | respeitado | n/a |

### 2.5 `06-uso-real.md`

| Lacuna | Cobertura | Estado |
|---|---|---|
| L1 telemetria sem nome da tool | F-780: `toolName`/`toolKind` no evento, no `events.jsonl` e no BOARD | integrado (dcecb185) |
| L2 regra do navegador sem enforcement | F-781: hook PreToolUse nega WebFetch com dica; regra no brief das demais CLIs. Alcance: só panes que alcançam `nexus_browser_*` (orquestrador, 1ª onda, helper em operator-choice); worker ad hoc fica fora → F-797. Teste e2e em PTY real do Claude não rodado | integrado (dd4b07ca) + em andamento (F-797, `terminais-f780-781`) |
| L3 feedback Certo/Errado nunca usado | F-782: ACK do Maestro rotula (`verdict: accepted|rework`); `taskRouting` fora do escopo por falta de vínculo durável | em andamento (ca90602a no worktree) |
| L4 Clef sem tráfego em `auto` | F-783: `CLEF_PREFERRED_SURFACES` = toolPick, researchTriage, rank, rankTool | integrado (0725aa57) |
| L5 superfícies ligadas que nunca disparam | F-784 investigou uma a uma (rank sem leitor → F-796; rankTool/researchTriage/helperReuse/missionPick/catalogPick: gatilhos de produto, não bug) | integrado (19a98860, 29328ae9) |
| L6 delegação 92 % solo / startCap 2 | F-784: diagnóstico corrigido (`startCap` inerte; 26 % de delegação real), teto seguro por RAM, `heavyRead`, "uma por vez" removido, cascata de helpers cortada | integrado |
| métrica: skills sugeridas × carregadas (systematic-debugging 11×0) | F-772 melhora a sugestão; nada obriga o worker a carregar; a medição do nome da skill vem no complemento do F-780 (em andamento) | observação |
| métrica: ~125 de ~170 tools MCP nunca chamadas | sem item; F-796 (rank/tool_pick) e F-797 (navegador) tocam 2 famílias | observação (sem correção proposta na análise) |

### 2.6 `07-orquestracao.md`

| Achado | Cobertura | Estado |
|---|---|---|
| P1 erro permanente do Codex fora do detector | F-765: `limit-detector.ts` reconhece a frase real do Codex/ChatGPT só em linha/JSON de erro | integrado (7bcafbe2) |
| P1 watchdog toma turno aberto como início | F-765 (`pane-start-watchdog.ts`) + F-792 (one-shot que sai com código ≠ 0 vira `boot-exit`) | integrado (7bcafbe2, f4b8e96f, 0044a332) |
| P1 rotação anuncia `switched` antes do respawn; sem alternativa elegível; quarentena não separa conta × instalação | F-765: `failover.ts` (+539), `model-access-quarantine.ts`, `pane-task-reroute.ts`, `failover-model-recovery.test.ts` | integrado |
| P2 proveniência catálogo × CLI executada | F-790 reduz (binário mais novo); comparação de proveniência não existe | **parcial → N2** |
| P2 F-234 barra sync ff / omite destino implícito | F-778 (`isExemptFastForwardSync`, direção pelo branch do cwd) + ajuste de desempenho do orquestrador | integrado (4951f5ae, b81dd3d1) |
| P2 contrato standard impede entrega operacional | F-785 (passo 3.5 em `mission-intent.ts:1042-1052`; lane na criação) | integrado (b0a7b5b8) |
| P1 handoff mecânico `success` sem revisão | F-786 (admissão no texto → partial; mesma revisão do MCP com `maxBounces 0`). Residual: tarefa visual sem evidência estruturada continua sem trava mecânica (contrato só tem `evidenceIds`/`artifactRefs`, `mission-engine-contract.ts:284-285`; nenhum tratamento de "visual" em `turn-end-handoff.ts`/`pty-stream-handoff.ts`) | integrado; residual **N7** |
| P2 telemetria não sustenta saúde histórica | F-787 (modelo efetivo, sessionId, cliVersion, origem do spawn, errorCode, recovery). Residuais: origem da entrada que abre um turno não é gravada (N10); trace roda por tamanho (`main-trace.ts:13`, 4×5 MB) sem retenção de 14 dias (N11) | integrado; residuais N10/N11 |
| §4 quem mandou "siga" | não atribuível; F-787 cobre spawns, não escritas/turnos | **NÃO COBERTO → N10** |
| §6 experimento Nexus × CLI direto (orchestration-trace.md:3) | não executado | pendência (não é código) → §3 |
| §6 separação conclusão × validação visual (review-followups.md:231-246) | parcial (F-786) | N7 |
| B0 travamento | F-764 + blindagem | integrado + em andamento |
| B1 agy + Argon + `--effort` | F-791 | integrado |
| B2 supervisor cego à morte no boot | F-792 | integrado |
| B3 helper com ACK pendente fora de `mission_panes` | F-793 | integrado |
| B4 writer Codex não commita | F-794 (grant das tools git na própria worktree + salvaguarda `refs/nexus-salvage/`) | integrado (1347d71f) |
| B5 entrega de handoff sem resiliência ao Main travado | F-795 (spool assinado por sessão: `handoff-spool-entry.ts`, `handoff-submit-inflight.ts`) | em andamento (`terminais-resilience`, 14 arquivos) |

### 2.6a Achados da revisão adversarial (`review-ec8524a8.md`, 14:13, `reject`) × dono

Não re-auditei o conteúdo da revisão; só cruzei cada achado com os worktrees e com o `HANDOFF-INTEGRACAO.md` §4.

| Achado | Frente | Dono / estado |
|---|---|---|
| C1 missão da mão do operador nasce com `maxWorkers: 0` e recusa o helper da aba | F-785 | F-810 (`fix-intent`, 05e398d1) — em andamento |
| A1 integração com 12 testes vermelhos em 4 arquivos (a base passa) | várias | **sem dono nominal** no handoff; o `F-773.md` e o `F-782.md` registram 4 dessas falhas como "já na base" (`task-router-quality`, `task-router-review-floor`, `http-mcp-boundary.integration`). Precisa ficar verde antes da 2ª revisão |
| A2 portão bloqueia `git merge --abort/--continue`, `merge-base`, `merge-tree`, `merge-file` no `main` | F-778 | F-814 (`fix-gate`, c8ae8522) + F-816 testes herméticos (e292a3be) — em andamento; B2 (git assíncrono no portão) → F-815 |
| A3 vault `.nexus-memory/` escrito no checkout a cada retain, inclusive de pane read-only | F-769 | `memoria2` ("vault em disco opt-in, raiz fixa, limite de taxa") — em andamento |
| A4 exportação síncrona O(N) no Main | F-769 | **integrado** (00ecf538, projeção assíncrona em fila) |
| A5 classificador "só sincronização" largo demais | F-785 | F-811 (`fix-intent`, 99c512d5) — em andamento |
| M1 camada "não verificada" como canal de prompt injection | F-769 | `memoria2` ("restrição M1") — em andamento |
| M2 distância de edição 1 prova pedido de CLI com palavra comum | F-766 | `fix-router` (F-818..F-821) — em andamento |
| M3 `WEB_SEARCH_NEED` dispara em texto comum | F-771 | `fix-router` — em andamento |
| M4 três `git` síncronos no planejador do failover, sem `safeGitArgv` | F-775 | F-822 (`f765-775b`) — em andamento (= N6) |
| M5 brief greenfield mudou sem trocar o marcador; briefs da 0.76.190 deixam de valer | F-776 | `fix-intent` (F-812) — em andamento |
| M6 lane de julgamento prioriza modelo de acesso incerto (Argon) | F-779 | F-817 (`fix-router`, abb9b92d) — em andamento |
| M7 regex de admissão rebaixa entrega boa; assimetria PTY/MCP | F-786 | F-823 (`f782-773`) — em andamento |
| B1 `resolveCodexCliVersion()` síncrono no spawn | F-787/F-790 | `async-io` ("B1 codex --version síncrono no spawn") — em andamento |
| B2 git síncrono no portão | F-778 | `fix-gate` — em andamento |
| B3 (F-774), B4 (F-772), B5 (F-770) | dados/skill/rotação | `fix-router` (B3, B5) e `fix-intent` (B4) — em andamento |
| B6 testes que não testam o que dizem; B7 processo "1 bug = 1 F-XXX.md" | processo | **sem dono nominal** no handoff |

### 2.7 NÃO COBERTAS — o que falta, onde, esboço de correção e teste

**N1 — Lane governada (Hardened) continua só Codex.** A análise 02 §3 chamou de "hipótese forte"; está provado no código da integração: `squad-runtime-policy.ts:337-341` (fora de `operatorChoice`, exige `isReleaseQualifiedMissionWorkerCli` **e** `provider.autonomousWorkspaceWriteCapable === true`), `adapter-registry.ts:153-155` (`governedWriter = releaseOwnedBase && supportsEnforceableWorkspaceWriteNativeAuthority(adapter)`) e `src/main/pty/autonomous-cli-policy.ts:326-349` (`adapter.id === 'codex' && adapter.bin === 'codex' && …`, estruturalmente só Codex). O comentário F-525 (`squad-runtime-policy.ts:85-96`) e a doutrina do dono dizem que a lane multi-CLI vale "nos dois modos"; o filtro da linha 340 contradiz. Esta missão rodou em Autopilot e não bateu nisso; em Hardened, "usar todas as LLMs" fica em Codex. Correção: em modo governado, admitir CLI release-qualified que escreve pelo boundary já provado (worktree isolada + merge validado pelo Main) — p.ex. `routableWorkerCliIds` aceita `isReleaseQualified && (autonomousWorkspaceWriteCapable || isolatedWriterBoundary)`; manter o Codex no sandbox nativo. Teste (`squad-runtime-policy.test.ts`): política governada com codex/claude/agy/grok/glm/kimi todos `guidedHandoffCapable` → `routableWorkerCliIds` tem mais que `codex`; `mimo-code` (não release-qualified) continua fora. Exige confirmação do dono de que a abertura vale também para Hardened.

**N2 — Proveniência do catálogo × versão do binário (02 G1 / 07 P2).** `cli-model-discovery.ts:23-36` lê `~/.codex/models_cache.json` (e os demais) sem olhar `client_version`; nenhum arquivo de `src/main` menciona `client_version`. O F-790 fecha o caso "duas instalações" mas não o caso "cache escrito por um cliente mais novo que o binário resolvido" (conta gerenciada, Codex de outro app). Correção: ler `client_version` do cache, comparar com a versão sondada do binário resolvido (cache do F-790 em `codex-cli-version.ts`) e, se o cache for mais novo, excluir da rota automática os modelos que o binário não lista (ou marcar `provenanceMismatch` no `AdapterInfo` e avisar no inventário). Teste (`cli-model-discovery.test.ts`/`codex-cli-version.test.ts`): fixture com cache `client_version` 0.160.0 e binário 0.146.0 → `gpt-6.1-sol` fora dos roteáveis e a rota cai para `gpt-6-sol`; versões iguais → entra.

**N3 — Inventário chama de "pronto" uma chave inválida (prometido pelo orquestrador "junto com o F-788", transcript L2059).** `qwen-readiness.ts` já classifica 401 como `invalid-credential` com a mensagem certa, mas só é usado pelo botão Testar (`provider-test.ts:61`); o inventário (`tools-instruments.ts:815-921`) informa `api-key`/`authReadyModels` pela presença da chave. Resultado: o roteador mandou 3 writers para um Qwen com chave morta. Correção: sonda barata, assíncrona e com cache (TTL) na montagem do inventário para provedores por chave (qwen; deepseek/glm se tiverem sonda), expondo `invalid-credential` como "chave inválida — renove em…" e tratando como `login-needed` no `firstWaveCanSeat`/`buildAdapters`. Teste: sonda devolve 401 → inventário mostra não-pronto e `routeTaskForCaller` não escolhe `qwen`; 200 → pronto.

**N4 — `autoCloseOnHandoff` fecha o pane e leva o corpo do relatório (pesquisa da Muse perdida; transcript L766 "vou anotar como falha a corrigir").** O helper pôs só o resumo em `artifacts[].fullText` (756 bytes no banco) e o pane fechou (`tools-handoff.ts:738`, armado em `tools-panes.ts:2121,2162`); o reenvio pedido às 11:12 nunca chegou. Correção: no `nexus_handoff_submit` com auto-close armado, se não houver artifact mais longo que o `summary` (ou `fullText ≈ summary`), anexar a cauda sanitizada do scrollback (reaproveitar `pane-boot-output.ts` do F-788) como artifact `nexus.terminal-tail` antes de fechar e devolver aviso ao agente; opcionalmente adiar o fechamento até o ACK. Teste (`tools-handoff*.test.ts`): submit com `fullText == summary` e auto-close → handoff persistido traz `nexus.terminal-tail`; com `fullText` real → sem cauda.

**N5 — Default do Claude no catálogo (04 B.2).** `resources/model-catalog.json:6` `"default": "claude-sonnet-5"` enquanto a tabela de rotas já usa `claude-sonnet-5-5` (`task-router.ts:189,215,524,542`) e a instalação que o F-790 passa a escolher (2.1.288) conhece o 5.5. Correção: default `claude-sonnet-5-5` (e `model-catalog.ts:104-106` se houver default em TS), com fallback para `claude-sonnet-5` quando a versão sondada do `claude` for anterior à que introduziu o 5.5. Teste: contrato do catálogo (default pertence à lista) + rota "claude default" resolve 5.5 com binário novo e 5 com binário velho.

**N6 — Git síncrono no caminho do failover (risco §4.2 do relatório de integração) — EM ANDAMENTO (F-822).** Na integração continua: `failover-mission-respawn.ts:14,81` `execFileSync('git', ['diff','--stat'])` com timeout 3 s no Main a cada failover main-owned, mais os dois `execFileSync` de `collectFilesModified` apontados pela revisão (M4), sem `safeGitArgv`. Dono: F-822 ("git assíncrono no planejador do failover") no worktree `terminais-f765-775b`, declarado em `HANDOFF-INTEGRACAO.md` §4. Critério de aceite sugerido: espião em `child_process` prova zero chamadas `*Sync` ao montar o pack e os argv passam por `safeGitArgv`.

**N7 — Tarefa visual sem trava mecânica (07 P1 residual; `review-followups.md:231-246`).** F-786 marca `partial` por admissão no texto e pela revisão do Jev; a análise avisa que regex sobre prosa não é verificador universal. O contrato (`mission-engine-contract.ts:284-285`) não transporta evidência visual; `turn-end-handoff.ts` e `pty-stream-handoff.ts` não têm nenhum tratamento de "visual". Correção: quando a tarefa é visual (lane/especialidade `visual`) e o handoff não traz artifact de prova (`screenshot`/`dom-dump`/PNG), o fechamento mecânico nasce `partial` com marca `[sem evidência visual]`, independentemente do texto. Teste: tarefa visual + texto de sucesso + zero artifact visual → `partial`; com PNG referenciado → `success`.

**N8 — Registro da decisão de stack por projeto (05 passo 3).** `guided-greenfield-brief.ts:87` manda "record the outcome as governed implementation evidence" sem dizer onde nem como; não há `.context/docs/stack-decision.md` nem chamada a `nexus_context_draft_propose` em `src/` (`grep` vazio). Correção: o brief (e a skill) nomeiam o draft `.context/docs/stack-decision.md` via `nexus_context_draft_propose` (fluxo draft→review→apply já existente, `tools-context.ts:321-366`). Teste (`guided-greenfield-brief.test.ts`/`stack-advisor.test.ts`): brief e SKILL.md contêm `stack-decision.md` e `nexus_context_draft_propose`.

**N9 — Frescor de dependências é só regra de prompt (05 passo 4).** Não existe sensor `stack-freshness` em `mechanical-sensors.ts` (só `dependency-audit` por CVE), e o repo do Nexus não tem dependabot/renovate/`npm outdated` (`.github/` só `workflows/`). O pedido "usar sempre as libs mais novas" fica sem verificação mecânica. Correção: sensor fail-open que lê `npm outdated --json`/dist-tags das deps diretas e reporta `deprecated`/major atrasado sem bloquear; opcional `.github/dependabot.yml`. Teste (`mechanical-sensors.test.ts`): fixture com pacote `deprecated` → achado; rede indisponível → nenhum bloqueio.

**N10 — Origem da entrada que abre um turno ("siga") não é gravada (07 §4; brief do F-787 pedia origem classificada da injeção).** F-787 classifica só o spawn (`pane-spawn-lifecycle.ts:106`). `observer.turn_started` não carrega origem; `getLastSessionInputOrigin` (`pty-manager.ts:481`, `'human'|'system'`) só é lido por `turn-end-handoff.ts:551` e `worker-handoff-enforcement.ts:230`. Correção: no `observer-mission-event-projector.ts`, o `turn_started` leva `inputOrigin` (`human`/`system`) e, quando `system`, o escritor (`maestro`/`supervisor`/`failover`/`nexus`) — nunca o texto. Teste: `nexus_pane_write` do Maestro seguido de `turn_started` → payload `inputOrigin: 'system', writer: 'maestro'`; tecla do operador → `human`.

**N11 — Retenção do trace por tamanho (07 P2).** `main-trace.ts:13` `TRACE_ROTATION_BYTES = 5 MB` × 4 arquivos; sob carga, horas de histórico — as métricas de 14 dias que a análise pediu não se sustentam. Correção pequena: rotação diária com N dias, ou espelhar os eventos de ciclo de vida do F-787 no `runtime.sqlite3`. Teste: rotação mantém `N` dias ou os eventos aparecem na tabela. Severidade baixa.

**N12 — `resume` em missão exige `adapterId` (transcript L774: "a retomada falhou pedindo adapterId apesar da descrição dizer que mantém o CLI").** A descrição do parâmetro (`tools-panes.ts:829-836`) promete retomar o mesmo worker; a inferência do adapter a partir do pane retomado só existe na mão do operador (`tools-panes.ts:1205-1208`). No caminho de missão o orquestrador teve de repetir com `adapterId: "muse"` (L775). Correção: no caminho de missão, com `resume` e sem `adapterId`, inferir o adapter do registro/sessão do pane retomado antes da rota automática. Teste (`tools-panes-*.test.ts`): spawn em missão com `resume` de pane Muse fechado e sem `adapterId` → abre em `muse`. Linha exata do erro não verificada.

**N13 — Worktrees indexadas pelo Spotlight (transcript L1454: "o Nexus deveria criar a pasta de worktrees com `.noindex`; fica anotado").** Nenhuma referência a `noindex`/`metadata_never_index` em `src/main` ou `scripts`. Hipótese do orquestrador (mds em alta CPU) não verificada. Correção barata: gravar `.metadata_never_index` na raiz das worktrees do runtime ao materializar (`worktree-cow.ts`/`isolated-writer-worktree.ts`). Teste: materialização cria o marcador. Severidade baixa.

**N14 — Pesquisa externa de memória (Muse) incompleta — EM ANDAMENTO (`memoria2`).** Só o resumo sobreviveu (ver N4); o corpo não está em nenhum transcript do incidente (`provider-state/muse` só tem `history.jsonl`). O `HANDOFF-INTEGRACAO.md` §4 inclui "pesquisa externa (ai-memory/graphify/Obsidian)" no escopo do `terminais-memoria2`. Critério: a tabela comparativa e as regras "quando usar grafo × FTS × vetor × notas" entram em `docs/analysis/2026-10-03-missao-terminais/` (ex.: `08-pesquisa-memoria.md`) com `fullText` obrigatório no handoff; `01-memoria.md` §6 já cobre a decisão de desenho.

### 2.8 Decisões do dono (recomendações das análises que não viram código de propósito)

- **D1 — Matriz modelo/esforço por tipo de tarefa (04 §4.1).** `HEURISTIC_SPECIALTY_ADAPTERS` fica vazio por desenho até existir benchmark Nexus; a qualidade publicada já pesa no multi-score e o F-770 impede que a especialidade concentre. Opção sem código: o operador pode preencher o overlay `~/.nexus/mission-specialty-benchmark.json` com a matriz (o roteador já honra). Decidir se a matriz do estudo (ex.: segurança → Opus 5.5/Fable com MiMo Pro de alternativa; pesquisa web → Grok/Gemini/Kimi; triagem → Gemini 3.8 Flash/GPT-6 Luna) deve virar overlay ou ficar como está.
- **D2 — `resources/model-ranking.json` (04 D).** Fixture de 13/09 (`gpt-5.6-luna` #1), ignorada pelo roteador. Ou rodar uma rodada real (`npm run eval:export-ranking` depois do `nexus-eval`) ou deixar declarada como fixture, como já está.

### 2.9 Estado por F-item (HEAD `0044a332`)

- **Integrados (26):** F-764 (main 6882c3c5 + A.1/A.3/C.7: 20db9422, fb4e6b84, e756d8a9), F-765 (7bcafbe2, 0044a332), F-766/767 (3d9466cd, 63533e37, b0a33d75), F-768 (9c2e4005), F-769 (e52e7dee, 00ecf538), F-770/771/772 (2fd9a60b, a3c34c03, ee6c960e), F-774 (5843c820), F-775 item 1 (0c90641c), F-776 (374181ea), F-777 (60149efd), F-778 (4951f5ae, b81dd3d1), F-779 (63c2e513), F-780/781 (dcecb185, dd4b07ca), F-783 (0725aa57), F-784 (19a98860), F-785/786/787 (b0a7b5b8, 2b28332a, 52509b37), F-788 (38115c55, f23cf27e, 0d52864b), F-789 (66e39962), F-790 (0fe816c9, 50403614), F-791 (106e98a3), F-792 (f4b8e96f), F-793 (92380755), F-794 (1347d71f), F-796 (29328ae9), toolchain de segurança (6a02c92d, 29be0662), teste DeepSeek (c89e04cd).
- **Em andamento (worktrees, 14:20; escopos conforme `HANDOFF-INTEGRACAO.md` §3–4):** F-775 item 2 + fiação do pack no renderer + F-822/M4 (`terminais-f765-775b`, 12 arquivos sem commit); F-782 + F-773 + F-823/M7 (`terminais-f782-773`, 5 commits à frente + `route-decision-ledger.ts` sem commit); F-795 (`terminais-resilience`, 14 arquivos); F-797 + nome da skill, categoria shell-http, regra no brief de orquestrador não-Claude (`terminais-f780-781`, 12 arquivos); F-798..F-801 + correções A3/M1 da revisão + pesquisa externa (`terminais-memoria2`, 2 arquivos); blindagem F-764 C.1–C.6 e tempo por tap (`terminais-f764-struct`, 1 commit = C.3); janela do Codex sem `--dangerously-bypass-hook-trust` + B1 (`terminais-async-io`, 10 arquivos); F-802 "+ Pane" inteligente para todas as CLIs (`terminais-plus-pane`, 6 arquivos); F-810..F-813 (`terminais-fix-intent`, 2 commits: 05e398d1, 99c512d5); F-814..F-816 (`terminais-fix-gate`, 2 commits: c8ae8522, e292a3be); F-817..F-821 (`terminais-fix-router`, 1 commit: abb9b92d).
- **Descartado:** `724a86ca` (F-779 do Devin).

## 3. Itens que o orquestrador disse que faria e não aparecem em lugar nenhum

| Dito (transcript) | Situação |
|---|---|
| "Depois vêm a revisão cruzada por modelo de ponta, a suíte completa e a release" (L743, L1196, L1529, L2042) | A revisão do orquestrador falhou (Fable vazio, Qwen 401). A revisão adversarial foi refeita fora da missão (`review-ec8524a8.md`, 14:13, `reject`; cobre as 11 frentes de `ec8524a8`, não as ~15 integradas depois). **Pendentes:** 2ª revisão do diff final, suíte completa (logs do npm só mostram vitest focado), merge no `main`, tag, release e publicação (`HANDOFF-INTEGRACAO.md` §6) |
| "Correção: o Nexus validar a credencial e mostrar 'Qwen: chave inválida' em vez de 'pronto'. Vou incluir junto com o F-788" (L2059) | **Não feito** → N3 (o F-788 integrado corrige só o cwd longo) |
| "O relatório completo se perdeu porque … o pane fechou com `autoCloseOnHandoff` — vou anotar isso como falha a corrigir" (L766) | **Não anotado nem corrigido** → N4 |
| "A retomada falhou pedindo adapterId apesar da descrição dizer que mantém o CLI do pane" (L774) | **Não tratado** → N12 |
| "O Nexus deveria criar a pasta de worktrees com o sufixo `.noindex`. Fica anotado como melhoria" (L1454) | **Não tratado** → N13 |
| "OpenCode … a religar depois do reinício" (L1740) | Continua `enabled:false` em `~/.nexus/providers.json` (ação do operador, §4) |
| "`npm install` … posso rodar se você quiser" (L235) | Não rodado: `node_modules/electron` 43.0.0 em disco × 43.7.4 no lockfile; previsto como `npm ci` no passo 5 da publicação (§4) |
| "Os squads salvos usam modelos antigos" (L1119) | Sem item; não verificado |
| "Com muitos helpers os cabos passam por trás dos cards, polimento futuro" (L1695) | Não feito (F-777 fecha o bug; polimento aberto, baixa) |
| "Habilitar o `--search` do Codex" (L1761) | **Decidido não fazer** (perfil governado desliga `standalone_web_search` de propósito; registrado em `F-779.md`) |
| "Qwen como revisor extra na revisão cruzada" (L1128) | Tentado e falhou por 401 (chave do operador) |
| "DeepSeek falso negativo no inventário tirou o DeepSeek do roteamento" (L1454) | Não reproduzido no código; teste de regressão adicionado (c89e04cd) |
| "Vou passar o G9 ao writer do Devin" (L1080) | Feito pelo próprio orquestrador (F-779); a versão do Devin foi descartada |
| Experimento controlado Nexus × CLI direto (pendência herdada de `orchestration-trace.md:3`, citada em 07 §6) | Não executado; não é código — precisa de rodada com as mesmas credenciais/modelo/tarefa |

## 4. Ações que só o operador pode fazer

1. **Qwen:** gerar chave nova no Alibaba Model Studio (DashScope/Token Plan) e colar em Ajustes → Provedores → Qwen (ou `~/.qwen/settings.json`). Sem isso o Qwen continua morrendo com 401.
2. **OpenCode, LongCat, Aider:** estão `enabled:false` em `~/.nexus/providers.json` (conferido); ligar se quiser que entrem na rota.
3. **OpenClaude e Muse via Claude:** fazer login (inventário marca `login-needed`).
4. **`npm install` no checkout principal:** `node_modules/electron` está em 43.0.0 (03/08) e o lockfile pede 43.7.4; a integração usa esse `node_modules` por symlink. Obrigatório antes de `make:release` (Node 22/24 LTS, conforme memória do projeto).
5. **Missão `mission-809f0e49…`:** está `blocked` desde 12:42 no runtime vivo; decidir se encerra. As 29 worktrees em `project-runtime/…/worktrees/` podem ser limpas depois do merge (patches já salvos em `patches/`; F-794 passa a salvaguardar trabalho sem commit).
6. **Teste de campo do failover (03 §4, teste 3):** com 2 contas Claude, esgotar uma no meio de uma tarefa com arquivo e conferir que o pane novo retoma sem retrabalho.
7. **Decisões D1 e D2** (§2.8) e confirmação de que a lane governada deve abrir também em Hardened (N1).
8. **Release:** aprovar a ordem suíte completa → revisão cruzada (prompt atualizado para todas as frentes) → merge no `main` → versão → `make:release` (wrapper TSA no PATH, Mac desbloqueado para a notarização).

## 5. O que não foi verificado

- Nenhum teste, typecheck ou build foi executado nesta auditoria; os números vêm dos QA docs e commits. O `review-ec8524a8.md` não foi re-auditado: só cruzei seus achados com os worktrees e com o handoff (§2.6a).
- Escopo exato de F-798..F-801 (fase 2 da memória): o worktree `terminais-memoria2` só tem 2 arquivos sem commit — não dá para afirmar se cobre 2d/2e/2f.
- Se o worktree `terminais-f765-775b` já tornou assíncrono o `git diff --stat` (N6/F-822 está declarado no handoff, não conferido no código) e se o `terminais-f780-781` já contém o F-797.
- Linha exata do erro de `resume` sem `adapterId` em missão (N12) e a hipótese do Spotlight (N13).
- App real (Electron) para F-777, F-781, F-790 (aviso de duplicata) e F-793: todos declarados "não verificado no app" pelos próprios writers.
