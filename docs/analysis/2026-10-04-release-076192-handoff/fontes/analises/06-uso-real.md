# handoff-25d3dcd7-b19f-4c93-96c8-36f2e3016a1f (GLM (z.ai))

# Relatório: o Nexus está usando de verdade o que tem?

Fontes: decisions.jsonl do Jev (`~/Library/Application Support/NexusIDE/jev/decisions.jsonl`, 760 decisões, 19/09–03/10, 132 sessões, 7 missões), transcripts dos panes (provider-state/*/claude/projects, 119 arquivos .jsonl), nexus.db e agent-memory (sqlite modo ro), ~/.nexus/settings.json, código em src/main. Pane somente leitura: nenhum teste foi rodado.

## 1) Resumo executivo
O Jev é usado de verdade nas superfícies operacionais (delegation, paneState, taskRouting, terminalTriage, dispatchGuard), com custo irrisório (US$ 0,043 / 1,03M tokens em 14 dias) e latência ~300 ms. Metade do catálogo de superfícies ligadas nunca dispara e o loop de feedback Certo/Errado nunca foi usado — não há como julgar qualidade das decisões, só volume. O Clef está configurado e credenciado, mas a política 'auto' (jev-clef-v1, ativada hoje ~10:45) só encaminha toolPick e visão: 2 chamadas em 14 dias. A regra "agentes usam nexus_browser_*" não tem enforcement: WebFetch (43) + curl em Bash (96) superam as 64 chamadas nexus_browser_*, porque o settings.json efêmero do pane não nega WebFetch e nada no bootstrap instrui o contrário. E a auditoria de uso quase não foi possível pela fonte canônica: os events.jsonl das missões gravam observer.tool_call SEM o nome da tool.

## 2) Métricas

### Jev — decisões por superfície (decisions.jsonl)
| superficie | n | decisões dominantes | confiança média |
|---|---|---|---|
| delegation | 252+ | solo 92% (233); delegate 17 | parts 0,55 / writers 0,67 |
| paneState | 180+ | working 111, waiting_for_human 46, idle 17 | 0,76 (35 decisões <0,5) |
| taskRouting | 102+ | tier:hard/feature 14, skill:oc-scout 12 | tier 0,73 / effort 0,60 |
| terminalTriage | 81 | usage 55 (68%), environment 19, config 4 | 0,67 |
| dispatchGuard | 69 | pass 69, block 0 | n/d (não loga) |
| handoffReview | 21 | retry 10, weak 7, ok 4 (81% rejeição) | n/d |
| businessModel | ~26 (hoje) | select:* | — |
| browserTool | 4 | login/extract/article | 0,98–1,0 |
| judgeTool / intake / toolPick / memoryDistill | 2 / 1 / 2 / 1 | — | — |

Falhas: 2 registros no-answer/aborted (26/09, modelo jev-latest) caíram para regra. Latência: só passou a ser logada hoje — 27 amostras, mediana 300 ms, máx 442 ms, sem timeout. Feedback right/wrong: 0 registros (campo existe em jev-decision-log.ts:61).

### Clef
Configurado: mode 'auto', clefModel 'clef', accountId e visionEnabled true (~/.nexus/settings.json → orch.decisionModels); token presente no vault (só presença verificada, valor não lido). Chamadas: 0 até 02/10; 2 hoje (toolPick → provider clef, reason tool-selection). Motivo: decision-routing.ts:74–78 — em 'auto' tudo que não é pinnado prefere jev; clef só recebe toolPick e visão não-pinnada.

### Navegador (transcripts dos panes)
| canal | chamadas |
|---|---|
| nexus_browser_* (read 11, click 11, navigate 9, open 7, find 7, wait 6, fill 5, screenshot 3, press 2, extract 2, responsive 1) | 64 |
| WebFetch | 43 |
| WebSearch | 36 |
| curl dentro de Bash | 96 |
| Playwright/Firecrawl MCP | 0 |

Janela: todo o histórico de transcripts encontrados (não só 14 dias).

### Skills / tools / CLIs
Skills sugeridas pelo Jev × carregadas (tool Skill): oc-scout 12×3, systematic-debugging 11×0, oc-conveyor 6×1, TDD 2×0, archify 1×0, verification-before-completion 1×0; mais carregadas sem sugestão: code-review 6, ponytail 5, impeccable 4, transcribe 3. Catálogo do Nexus MCP: ~170 tools registradas (src/main/orch/tools-*.ts); ~45 distintas apareceram nos panes. Nunca chamadas nos transcripts: nexus_skills_inventory, nexus_plugin_inventory, nexus_mcp_servers, nexus_judge, nexus_rank, nexus_pr_inspect, nexus_worker_heartbeat, nexus_computer_do, entre outras. CLIs: 11 rastreados (cli-auto-update.json); uso em panes (nexus.db provider_pane_sessions): claude 176 (95%), codex 4, mimo-code 2; kimi, grok, aider, agy, opencode, openclaude, minimax, devin, gemini, qwen instalados com 0 sessões.

## 3) Lacunas por gravidade

**L1 (alta) — Telemetria de tool não persiste o nome.** Evidência: events.jsonl das missões grava observer.tool_call sem payload (linhas só com sequence/type/runId), embora o frame tenha toolName (shared/observer-frame.ts:113) e o projetor o inclua (orch/observer-mission-event-projector.ts:60–67); o drop-box ~/.nexus/agent-hooks/global está vazio (hook entrega por HTTP, hooks/claude-hook.sh). Causa: a projeção persistida (mission-disk-projection.ts / journal) descarta o payload. Correção mínima: persistir ao menos {toolName, toolKind} no evento; teste que falharia hoje: emitir frame tool_call com toolName 'WebFetch' e afirmar que events.jsonl da missão contém "toolName":"WebFetch".

**L2 (alta) — Regra do navegador sem enforcement.** Evidência: 43 WebFetch + 96 curl vs 64 nexus_browser_*; o settings.json efêmero do pane é gerado sem permissions (orch/hooks-gen.ts:655–675 escreve hooks e zero-click settings; checado no próprio overlay: permissions = {}). Causa: WebFetch é tool nativa sempre disponível; a regra vive só no prompt do operador. Correção mínima: nas missões com política de navegador, acrescentar permissions.deny ['WebFetch'] (opcionalmente 'WebSearch') no objeto settings de hooks-gen.ts:655; testes: (1) unitário gerando settings com a flag e esperando o deny; (2) e2e — pane chamando WebFetch recebe PermissionDenied com dica de usar nexus_browser_read.

**L3 (média) — Feedback Certo/Errado nunca usado.** Evidência: 0 registros com feedback em 760 decisões; API pronta (jev-decision-log.ts:250). Sem labels, handoffReview rejeitando 81% (retry 10 / weak 7 / ok 4) não dá para classificar entre limiar rígido x handoffs ruins. Correção mínima: ligar setDecisionFeedback a um gesto existente (ex.: aceite/refazer do handoff que gerou a revisão) + teste: revisar handoff e rejeitar deve gravar feedback='wrong' na decisão correspondente.

**L4 (média) — Clef configurado e sem tráfego em 'auto'.** Evidência: 2 chamadas em 14 dias (hoje, toolPick); roteamento decision-routing.ts:74–78 só dá clef a toolPick/visão. Se o objetivo é comparar Jev×Clef (docs/analysis/2026-10-02-jev-clef-vs-overclock.md), a amostra nunca se formará. Correção mínima (política, não código): encaminhar mais uma superfície barata e não-pinnada (ex.: researchTriage ou rank) ao clef em 'auto', ou expor contadores por provider na UI de modelos de decisão; teste: com modo auto e credencial clef presente, resolveDecisionRoute({surface:'researchTriage'}) deve retornar provider clef.

**L5 (baixa) — Superfícies ligadas que nunca disparam.** rank/rankTool, researchTriage, helperReuse, missionPick, catalogPick: 0 decisões em 14 dias com as 16 ligadas em jevSurfaces (toolPick e memoryDistill só dispararam hoje). Não rastreei gatilho por gatilho. Correção: ou desligar do painel até ter tráfego, ou garantir que os fluxos correspondentes (nexus_rank, missões research, idle helper) efetivamente consultem a superfície.

**L6 (baixa) — Paralelismo e frota subutilizados.** delegation solo 92% (adaptiveWaveLadder startCap 2) e 8–10 CLIs instalados com 0 sessões. Não é bug; é capacidade ociosa declarada.

## 4) O que não foi verificado
- Precisão das decisões do Jev (sem labels/feedback não há ground truth; não auditei exemplos contra o PTY).
- Se as 2 decisões toolPick de hoje vieram do orquestrador — a contagem "0 chamadas nexus_tool_pick" vale para os 119 transcripts de panes encontrados.
- Gatilhos exatos de helperReuse/missionPick/catalogPick/researchTriage no código (por que zero disparos).
- Valor do token Clef (só presença no vault) e se a chamada clef de hoje teve sucesso HTTP.
- A janela de WebFetch/curl cobre todo o histórico de transcripts, não só os 14 dias do log de decisões.
- Nenhum teste foi executado (pane somente leitura); correções propostas não foram aplicadas.
