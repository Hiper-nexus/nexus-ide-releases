# handoff-4300fc36-aca0-486a-9172-b8957b968ce5 (Claude)

# Memória de longa duração do Nexus: inventário, causa raiz e desenho

Escopo: somente leitura. Repo em 32230db8 (0.76.190). Dados reais em `~/Library/Application Support/NexusIDE`. Datas em UTC salvo indicação.

## 1. Resumo executivo

- A memória compartilhada (SQLite FTS5 em `agent-memory/`) está tecnicamente viva: flag ligada, superfície Jev ligada, id de workspace estável, leitura rodando a cada spawn. O que morreu foi a ESCRITA.
- Causa raiz principal: os três gatilhos automáticos de gravação têm pré-condições que o fluxo real do operador nunca satisfaz. Plano selado: 0 despachos. ACK do Maestro: 0 depois do commit que o ligou à memória. Digest de fim de sessão: exige evidência `nexus-trusted` e 100% dos handoffs são `unverified`.
- Causa secundária: nenhum agente jamais chamou `nexus_memory_retain` (0 chamadas na auditoria), porque workers nascem com allowlist vazia e as tools de memória não estão na lista sempre permitida. Este próprio pane não enxerga `nexus_memory_*`.
- Causa terciária: mesmo o que existe não chega ao prompt. As 6 linhas são recibos sem conteúdo e o formatador as descarta; memória escrita por agente ou nota do operador é excluída da injeção (`trustedOnly`). Resultado: bloco `<workspace-memory>` sempre vazio. Meu brief chegou com `<business-model>` e sem `<workspace-memory>`.
- Tudo falha em silêncio: os motivos de descarte (`unverified`, `jev-skip`, `trivial`) são calculados e jogados fora, sem log nem contador.
- Hipótese "id de workspace mudando" REFUTADA. Hipótese "flag desligada" REFUTADA.
- O conhecimento real do projeto hoje vive em AGENTS.md (1666 linhas), no modelo de negócio extraído por HEAD e na auto-memória nativa do Claude (8 arquivos, invisível aos outros CLIs).

## 2. Mapa dos depósitos

| # | Depósito | Onde fica | Quem escreve / quando | Quem lê | Quais LLMs enxergam | Vida | Estado real |
|---|---|---|---|---|---|---|---|
| 1 | Memória de workspace (canônica) | `agent-memory/workspaces/workspace-<sha256(projectId)>/memory.sqlite3` (workspace-memory.ts:1275-1298) | `retainTrustedMemory*` (trusted-memory.ts), `nexus_memory_retain` (tools-memory.ts:83), tela Memória (product-wave-ipc.ts:482) | recall automático no brief (tool-util.ts:1272-1307), MCP instructions e hook (operator-workspace-memory.ts:20), `nexus_memory_recall` | Todos, mas só linhas `trusted:%` entram no prompt | Sem TTL; só supersede/forget | 4 bancos, 6 linhas no total, todas de 01-02/08 |
| 2 | Memória global | `agent-memory/memory-global.sqlite3` | Só `nexus_memory_retain scope=global`; trusted é sempre workspace (trusted-memory.ts:272) | recall com `includeGlobal` | Todos via tool | Sem TTL | 0 linhas |
| 3 | Projeção markdown | `agent-memory/projections/workspace-*/.nexus-memory/*.md` (nexus-memory.ts) | Gerada a cada retain; corpo editável reingere (nexus-memory-ingest.ts) | Tela Memória, tools backlinks/orphans/suggest (tools-memory.ts:230-331) | Nenhuma como arquivo: fica em userData. `exportProjectionsToWorkspace` (workspace-memory.ts:498) não tem chamador | Espelha o banco | 6 arquivos, todos recibos |
| 4 | Modelo de negócio extraído | `business-model/<hash>/<headSha>.json` (business-model-store.ts) | `ensureBusinessModel` no initialize MCP, hook e brief (business-model-ensure.ts) | Bloco `<business-model>` por tarefa | Todos: brief de spawn; hook para Claude-family e Codex; MCP instructions para Kimi/Grok/etc. (operator-business-model.ts:17-41) | 8 arquivos por projeto, por HEAD | 2 arquivos; o do HEAD atual foi extraído hoje 13:59 |
| 5 | Doc revisado do modelo de negócio | `.context/docs/business-model.md` (57 linhas, de 18/07) + attestations | Humano/fluxo de context draft | business-model-context-block.ts:60 | Todos via bloco; qualquer CLI lendo o repo | Git | Antigo (18/07) |
| 6 | Mapa de orientação / code map | `orientation-maps/project-*/checkout-*/current.json` + `structural-index.json` (orientation-cache.ts) | orientation-service a cada HEAD | Tools `nexus_code_map_get/query/blast_radius/refresh` (tools-code-map.ts) | Só quem tem a tool na allowlist; worker com `[]` não | Recriado por HEAD | Atual (HEAD 32230db8), status `partial` por limite de inventário |
| 7 | Truth graph / context knowledge | `runtime.sqlite3` por checkout (event_ledger, context_drafts) (context-knowledge-service.ts, truth-graph.ts) | Tools `nexus_context_*` | Tools de contexto | Orquestrador | Durável | Não medido em detalhe |
| 8 | Graphify | `.graphify/graph.json` no repo (graphify-enricher.ts:25) | CLI externo graphify | Enriquecedor do mapa | Indireto | Arquivo | Ausente neste repo |
| 9 | Fatos do Jarvis (voz) | tabela `memory_entries` do runtime (jarvis-memory.ts) | Jarvis `remember` | `factsBlock` no prompt de voz (700 chars) | Só o Jarvis | Durável, 200 fatos | 0 linhas |
| 10 | Decisões do Jev | `jev/decisions.jsonl` | Cada `judge()` | Avaliação/telemetria | Nenhuma LLM | Log | 705 linhas, 19/09 a 03/10 |
| 11 | AGENTS.md / DESIGN.md | Repo (113 KB / 22 KB) | Humanos e agentes via commit | Leitura nativa de cada CLI | Codex e os que leem AGENTS.md; Claude Code só se houver CLAUDE.md (não há no repo) | Git | Atual (03/10) |
| 12 | Auto-memória nativa do Claude | `provider-state/claude/<checkoutId>/claude/projects/<cwd>/memory/` (ligada por symlink no HOME efêmero) | O próprio Claude Code | Só Claude daquele adapter e checkout | Só Claude. O adapter `glm` tem overlay próprio, sem pasta memory | Durável por checkout | 8 arquivos, último 28/09. O `~/.claude/.../memory` nativo (24 arquivos, 19/09) ficou órfão após o overlay |
| 13 | Memórias nativas do Codex | `provider-state/codex/<checkoutId>/memories_1.sqlite` | Codex | Só Codex | Só Codex | Durável | Vazio (stage1_outputs=0, jobs=0) |
| 14 | MiMo / Kimi / Grok | `provider-state/<adapter>/<checkoutId>/` | Cada CLI | Só o próprio | Só o próprio | Durável | MiMo tem pasta `memory`; Kimi e Grok só sessões |

## 3. Causas raiz com evidência

### 3.1 Hipóteses refutadas

**Id de workspace mudando: NÃO.** A chave é `sha256('memory-workspace\0' + projectId)` (workspace-memory.ts:1267-1283).

```
node -e "...digest('memory-workspace','31781d36-3f22-41b8-ad9d-8690c85d3343')"
31781d36 -> 1f89a6de03fab81733e8221dc467be1c7744fdc62e4a447a162f17e904a3d14e
```

É exatamente o banco que guarda as 6 linhas de agosto. O `projectId` do runtime atual é o mesmo (`__nexus_runtime_scope`). Os outros 3 bancos são de outros projetos e estão vazios. O banco `workspace-a2fb…` abre com `?immutable=1` (journal `delete`, 0 linhas); o erro 14 é só do modo `?mode=ro`, não é corrupção.

**Flag ou superfície desligada: NÃO.** `feature.memory.workspaceMemory` tem `defaultEnabled: true` (feature-flags.ts:287-297). `~/.nexus/settings.json` tem `jevAutopilot=true`, `jevSurfaces.memoryDistill=true`, `workspaceMemoryInjection=true`. Prova viva: as 6 linhas têm `last_recalled_at = 2026-10-03 14:00:39`, o instante do spawn deste pane, e `recall_count` entre 41 e 50.

### 3.2 Causa A (principal): nenhum gatilho de escrita casa com o uso real

Existem só estes caminhos automáticos:

| Gatilho | Código | Pré-condição | Realidade |
|---|---|---|---|
| Aceite de tarefa do plano selado | handoff-store.ts:845-852 | `taskDispatch.handoffAcceptedAt` definido | `task_dispatch_queue` = 0 linhas; `mission_task_plans` = 0 |
| ACK físico do Maestro (F-703, commit baff4879 de 30/09) | handoff-store.ts:1921-1954, tools-handoff.ts:904 | Orquestrador de missão chama `nexus_handoff_ack` | 6 ACKs ok, todos em 19/09 e 28/09, antes do commit. Nenhum depois |
| Digest de fim de sessão | session-exit-memory.ts:113-119 | Handoff de sucesso com `evidenceTrust === 'nexus-trusted'` | `evidence_trusted=0` em 100% dos handoffs (22 e 5) |
| Preferência do operador | hook-delegate-endpoint.ts:499-505, operator-preference-memory.ts:76-98 | Pane da mão do operador, prompt ≤1500 chars, marcador, Jev aprova | 0 decisões `memoryDistill` |
| Merge aprovado | merge-queue.ts:138-152 | Uso da merge queue | Operador commita direto em main |
| Decisão do operador | product-wave-ipc.ts:480-486 | Operador cria nota tipo "decision" na tela Memória | Nunca usado |

Comando e saída no runtime do projeto atual:

```
handoffs|22|sum(evidence_trusted)=0|2026-09-19 .. 2026-10-03
acks(handoff_ack_receipts)|0
dispatch|0
delivery_state=submitted, mission_id NULL: 21 de 22
```

21 dos 22 handoffs não têm missão: são helpers do "+ Pane" entregando ao pane pai. Esse fluxo, que é o dia a dia do operador, não tem NENHUM gatilho de memória. As 6 linhas de 01-02/08 vieram do único período em que o plano selado foi usado.

No log do Jev, superfícies de 19/09 a 03/10:

```
delegation 252, paneState 180, taskRouting 102, terminalTriage 76, dispatchGuard 62,
handoffReview 21, businessModel 5, browserTool 4, judgeTool 2, intake 1
memoryDistill: 0
```

`dispatchGuard` e `handoffReview` são fixadas no Jev como `memoryDistill` (decision-routing.ts:16) e funcionam, então a credencial existe. A destilação simplesmente nunca é chamada.

### 3.3 Causa B: agentes não gravam porque não têm a ferramenta

- `ALWAYS_ALLOWED` (gate.ts:116-148) não inclui `memory_retain`, `memory_recall` nem `memory_stats`.
- Todo worker recebe `allowedTools: []` (builtin-squads.ts:77-78); helper do operador idem (tools-panes.ts:1362).
- `nexus_pane_whoami` deste pane: `"allowedTools": []`, `"readOnly": true`. A busca de tools por "memory" não devolve nenhuma `nexus_memory_*`. Por isso não pude rodar `nexus_memory_stats`/`recall` ao vivo; usei sqlite direto.
- Auditoria do projeto (774 eventos desde 19/09): `nexus_memory_recall|ok|2`, `nexus_memory_retain`: 0.
- O comentário de mcp-effect-policy.ts:143-147 diz que retain "precisa funcionar para TODAS as CLIs hospedadas", mas a allowlist vazia impede.

### 3.4 Causa C: o que é gravado não chega ao prompt

- workspace-memory-context.ts:93-97 remove todo `trusted:accepted-handoff` sem `Summary:` destilado (F-180, d3bec04e de 28/09). As 6 linhas são exatamente isso, então o bloco sai vazio (linha 98).
- workspace-memory-context.ts:186 e :201 usam `trustedOnly`. Memória `agent-authored:*` e nota do operador (`operatorMemorySource`) nunca são injetadas; só aparecem em recall explícito, que ninguém consegue chamar (causa B).
- O contador mente: `#recallFrom` soma `recall_count` em todo candidato (workspace-memory.ts:920-923), antes do filtro que descarta. Daí 41-50 "recalls" de linhas que nenhum agente viu.

### 3.5 Causa D: falha engolida em silêncio

- `.catch(() => {})` em handoff-store.ts:873 e :1954; `catch {}` em :1955; session-exit-memory.ts:184.
- `distillSessionExitMemory` devolve `reason` (session-exit-memory.ts:32-45) e o chamador descarta.
- `distillHandoffSummary` devolve `null` sem registrar quando falta rota, o texto casa com `AGENT_DIRECTIVE_RE` ou o judge dá timeout (jev-memory-distill.ts:160, :169). Só há log quando o Jev responde.
- Não existe nenhum indicador na UI de "última memória gravada há N dias".

## 4. O que cada CLI recebe ao nascer

Montagem central: `withProjectContextBlocksAsync` (tool-util.ts:1288-1307), chamada em todo spawn com prompt (tool-util.ts:1700) e na fast lane (mission-fast-lane.ts:1116, :2344). É independente de adapter.

| Situação | Claude / GLM / openclaude | Codex | Kimi, Grok, agy, DeepSeek, MiMo |
|---|---|---|---|
| Worker ou helper com brief | `<business-model>` por tarefa + `<workspace-memory>` no início do prompt | Igual | Igual |
| "+ Pane" sem brief: modelo de negócio | Hook UserPromptSubmit, por tarefa (operator-business-model.ts:17-25) | Hook | Bloco estático nas `instructions` do MCP (mcp-protocol.ts:201-206) |
| "+ Pane" sem brief: memória | `instructions` do MCP, top por importância, 2 KB (operator-workspace-memory.ts:26-31) | Hook, por relevância, 3 KB | `instructions` do MCP |
| Tools `nexus_memory_*` | Só se allowlist `null` (pane do operador, orquestrador) | Idem | Idem |
| Memória nativa | Auto-memória do Claude por adapter+checkout | `memories_1.sqlite` vazio | Própria de cada um |
| AGENTS.md | Não lê sozinho (sem CLAUDE.md no repo) | Lê | Depende do CLI |

Na prática hoje: todos recebem `<business-model>`; ninguém recebe `<workspace-memory>` porque o bloco sai vazio (3.4). Não verifiquei se cada CLI de fato exibe as `instructions` do MCP ao modelo.

## 5. Plano de correção em passos pequenos

Cada passo tem um teste que falha hoje. Faixas sem colisão: A = `src/main/memory/*`; B = `src/main/orch/gate.ts` + `mcp-effect-policy.ts`; C = `src/main/orch/handoff-store.ts`; D = `workspace-memory-context.ts`; E = brief/doutrina.

1. **Telemetria de descarte (faixa A).** Registrar o `reason` de cada tentativa (flag-off, unverified, jev-skip, sem rota, timeout) em contador exposto por `stats()` e em `recordJevDecision` com `decision: 'skip:<motivo>'`. Teste: `distillHandoffSummary` sem credencial deve gravar uma decisão `skip:no-route`; hoje não grava nada (jev-memory-distill.ts:160).
2. **Tools de memória sempre permitidas (faixa B).** Incluir `memory_recall`, `memory_stats`, `memory_retain` em `ALWAYS_ALLOWED` (gate.ts:116) e `memory_retain` no conjunto liberado para contexto read-only (mcp-effect-policy.ts:193). Teste: `isToolAllowed([], 'nexus_memory_retain')` deve ser `true`; hoje é `false`.
3. **Handoff de helper sem missão vira memória (faixa C).** No commit de um handoff `success` sem `taskDispatch` e sem missão, chamar a mesma destilação do F-703. Teste em handoff-store: submit de sucesso sem missão, com judge fake aprovando, deve criar 1 linha `trusted:accepted-handoff` com `Summary:`; hoje cria 0.
4. **Entrega ao Maestro não depende do ACK (faixa C).** Disparar a retenção quando o handoff de missão é marcado entregue, mantendo o dedupe por conteúdo já existente (trusted-memory.ts:397-400). Teste: handoff de missão entregue e nunca confirmado gera memória; hoje só em `outcome === 'created'` do ACK (handoff-store.ts:1920).
5. **Digest de sessão aceita resumo aprovado pelo Jev (faixa A).** Trocar o corte duro de session-exit-memory.ts:115-119 pela mesma barreira do F-703 (texto do agente só entra destilado). Teste: sessão com handoff `unverified` e judge aprovando deve devolver `reason: 'ok'`; hoje devolve `'unverified'`.
6. **Não gravar recibo sem conteúdo (faixa A).** Remover a linha-base só de identificadores (trusted-memory.ts:334) e esquecer as 6 existentes. Teste: aceite cujo resumo o Jev descarta não cria linha; hoje cria.
7. **Injeção em duas camadas (faixa D).** Manter `trusted` como hoje e acrescentar uma seção "notas de agentes, não verificadas" com teto menor para `agent-authored:*` e notas do operador. Teste: `workspaceMemoryContextBlock` com uma linha `agent-authored` relevante deve trazê-la marcada como não verificada; hoje devolve `null` (workspace-memory-context.ts:186).
8. **Contador honesto (faixa A/D).** Somar `recall_count` só do que foi efetivamente injetado. Teste: recibo filtrado pelo formatador mantém `recall_count` inalterado; hoje sobe.
9. **Doutrina no brief (faixa E).** Duas linhas no contrato de handoff: consultar `nexus_memory_recall` antes de mexer em área desconhecida e gravar pegadinhas com `nexus_memory_retain` antes do handoff. Teste: o brief montado contém as duas instruções.
10. **Retry em vez de perda (faixa A).** Quando o Jev está fora ou dá timeout, enfileirar o resumo e redestilar no próximo boot. Teste: judge devolvendo `null` deixa 1 item pendente; hoje o resumo some.
11. **Backfill único.** Passar pela destilação os 26 handoffs de sucesso com resumo que ainda estão nos runtimes, os 8 arquivos da auto-memória do Claude e os 24 de `~/.claude/projects/-Users-cleofaspereirarocha-nexus-ide/memory`. Teste: script idempotente, segunda execução grava 0 (dedupe por `content_hash`, índice `idx_memories_hash_active`).
12. **Alarme visível.** Tela Memória mostra "última memória há N dias" e fica em alerta acima de 3 dias com handoffs no período. Teste de componente com banco parado.

Ordem sugerida: 1, 2, 3, 6 e 7 primeiro; são os que fazem a memória voltar a andar e a aparecer.

## 6. Desenho da memória de longa duração entre LLMs

Princípio: um único banco canônico (o SQLite FTS5 que já existe), alimentado por eventos do Main e por agentes, entregue a todo CLI pelos dois canais que já existem (brief e MCP). Nada de memória por CLI.

**O que gravar automaticamente** (os tipos já existem em trusted-memory.ts:16-24):
- `resolved-problem`: resumo destilado de todo handoff de sucesso, com ou sem missão (passos 3-5).
- `architecture-rule`: invariantes do AGENTS.md e do modelo de negócio, uma por linha, com `[[arquivo]]` de origem. Hoje esse tipo não tem nenhum escritor.
- `operator-decision` e `operator-preference`: do hook de prompt, inclusive no pane do Maestro (hoje excluído em hook-delegate-endpoint.ts:499) e com teto de 1500 chars revisto para avaliar só a frase com marcador.
- Pegadinhas: `nexus_memory_retain kind=fact` pelo próprio agente antes do handoff (passos 2 e 9).
- Preferências que não citam caminho do repo vão para o banco global, hoje sem escritor automático (trusted-memory.ts:272).

**Deduplicar.** Já existe: hash exato com índice único, dedupe em voo e top-3 FTS (session-exit-memory.ts:127-141), supersede por linha-chave (`latestActiveWithLine`). Acrescentar: chave de assunto na primeira linha (`# Título`) para que uma nova versão do mesmo assunto substitua a anterior, em vez de empilhar.

**Expirar.** Hoje não há TTL. Proposta por tipo: `session-digest` expira em 30 dias se nunca foi injetado; `fact` ligado a arquivo é marcado "a reverificar" quando o arquivo some do mapa de orientação; `decision`, `architecture-rule` e `preference` não expiram, só são substituídas. Usar o tombstone `forgotten` que já existe (workspace-memory.ts:948).

**Injetar em todo CLI.** Manter os canais atuais e garantir conteúdo: brief de spawn para todos; hook para Claude-family e Codex; `instructions` do MCP para Kimi, Grok, agy, DeepSeek, MiMo. Complemento barato para CLIs que leem arquivo: ligar `exportProjectionsToWorkspace` (hoje sem chamador) para gerar `.nexus-memory/` no repo, fora do git, e citar a pasta no AGENTS.md.

**Markdown estilo Obsidian.** A projeção já existe com frontmatter, edição de corpo reingerida e wikilinks (`extractWikilinks`, backlinks, órfãos, sugestões). Falta: nome de arquivo legível (hoje `mem-<uuid>.md`), um `INDEX.md` por tipo, e wikilinks automáticos para `[[src/caminho.ts]]` e `[[missão]]` na hora do retain. Com a exportação, a pasta abre direto como vault.

**Grafo ou texto.** FTS para "o que já sabemos sobre X" (busca por substantivo; `buildRecallQuery` já prioriza identificadores). Grafo para perguntas de relação: "o que quebra se eu mexer aqui" usa `nexus_code_map_blast_radius` do mapa de orientação, que já existe e está atual; "quais regras governam este fluxo" usa o modelo de negócio por fluxo; "que decisões dependem desta" usa os backlinks da projeção. Não criar grafo novo: ligar memória a arquivo por wikilink e, no brief, somar ao recall lexical as memórias ligadas aos arquivos do raio de impacto da tarefa. Graphify fica opcional; não há `.graphify/` no repo.

## 7. O que não foi verificado

- Não rodei `nexus_memory_stats`/`nexus_memory_recall` ao vivo: as tools não são expostas a este pane (causa B). Substituí por sqlite somente leitura e pela auditoria.
- Período de 03/08 a 18/09: o runtime atual começa em 13/09 e missões antigas foram removidas (1 missão, 22 handoffs restantes, contra 31 `handoff_submit ok` na auditoria). Não há como provar por dados o que ocorreu nessas semanas; a conclusão vem do código e dos dados de 19/09 em diante.
- Por que 0 decisões `memoryDistill` de preferência: no histórico do Claude há 89 prompts desde 27/09, 12 com marcador e 5 com até 1500 chars. Causas possíveis não distinguidas: prompt digitado no pane do Maestro (excluído na linha 499), timeout do Jev de 6 s ou histórico truncado. O passo 1 resolve a dúvida.
- Versão exata do app em execução (`out/NexusIDE-darwin-arm64`) e se contém o commit baff4879.
- Se Kimi, Grok, agy, DeepSeek e MiMo realmente repassam as `instructions` do MCP ao modelo.
- Conteúdo do truth graph/event ledger e das memórias nativas do MiMo.
- Nenhum teste foi executado; nenhum arquivo foi alterado.
- Divergência com a evidência do Maestro: `business-model/` tem 2 arquivos, não 1; o do HEAD 32230db8 foi extraído hoje às 13:59.