# Paridade de superfície MCP — Overclock × Nexus

**Medido:** `grep` das definições em `src/main/orch/tools-*.ts`.
**Nexus expõe 146 tools `nexus_*`. Overclock expõe ~35** (inventário ATESTADO
pelo orquestrador da sua própria sessão).

> **Correção de premissa:** a rodada pediu para examinar 6 itens "que não
> examinamos" — **quatro dos seis já existem no Nexus**. O gap real é bem menor
> do que a lista sugeria, e em superfície o Nexus está muito à frente.

---

## Tool a tool

| Overclock | Nexus | Veredito |
|---|---|---|
| `pane_spawn` (agent, persona, providerId, model, effort, cwd, allowedSkills, autoCloseOnHandoff, resume, missionId, delegateOnly, squadRole, squadCallable, idle) | `nexus_pane_spawn` (adapterId, agentName, model, effort, cwd, title, missionId, routeReservationId, taskId, prompt) | **Parcial** — falta `autoCloseOnHandoff`, `resume`, `delegateOnly`, `squadRole/Callable`, `idle`, `allowedSkills` no spawn |
| `pane_write` **com `brief`** (ponteiro para arquivo; worker escreve o resultado de volta no mesmo arquivo) | `nexus_pane_write` sem `brief` | **GAP REAL** — ver (a) |
| `pane_write_many` | `nexus_pane_write_many` | **Paridade** |
| `pane_close` (escopos caller_mission / caller_workspace / all_workspaces) | `nexus_pane_close` sem escopos | **Gap menor** |
| `pane_whoami` | `nexus_pane_whoami` (tools-panes.ts:631) | **Paridade** — já existe |
| `pane_list_providers` | `nexus_pane_list_providers` | **Paridade** |
| `handoff_submit` / `handoff_list` | idem + `nexus_handoff_ack` | **Nexus à frente** (ack explícito) |
| `overclock_mission_*` (4) | `nexus_mission_*` (8: + freeze/refreeze contract, control, spawn_pane) | **Nexus à frente** |
| `overclock_catalog_*` (6) + marketplace | `nexus_catalog_install`, `_overlay`, `nexus_skills_inventory`, `nexus_cli_inventory` | **Parcial** — falta `_uncategorized`/`_stacks_write` (o fluxo de calibração) |
| `overclock_agent_list` (busca por NECESSIDADE, ranqueada) | `nexus_agent_list`, `_get`, `_spec_write`, **`_invoke`** | **Nexus à frente** (invoca), **atrás** no ranking por necessidade |
| `overclock_skill_list` (por necessidade, escopo de área) | `nexus_skills_inventory` | **Parcial** — inventário, não busca ranqueada |
| `overclock_squad_*`, `recipe_*`, `stack_get` | `nexus_squad_save`, `nexus_recipe_propose` | **Gap** — sem `recipe_list/get` nem `stack_get` |
| `overclock_model_list` (faixas + doutrina) | `nexus_model_ranking` | **Paridade** |
| `overclock_clarify` | `nexus_clarify` (tools-domain.ts:942) | **Paridade** — já existe |
| `overclock_media_providers` | `nexus_media_providers` | **Paridade** — já existe |
| `overclock_vault_list` | *(sem equivalente exposto)* | **Gap menor** |
| `overclock_navigate` / `open_browser` | `nexus_browser_*` (10 tools) | **Nexus MUITO à frente** |
| — | `nexus_code_map_*` (4), `nexus_lsp_*` (4), `nexus_git_*` (11), `nexus_editor_*` (5), `nexus_design_system_*` (8), `nexus_memory_*` (3), `nexus_context_*` (9), `nexus_worktree_*`, `nexus_merge_*`, `nexus_sensor_run`, `nexus_security_audit`, `nexus_validation_run`, `nexus_remote_*` (4) | **Nexus à frente — não há equivalente** |

---

## Os 6 itens sinalizados como "não examinados"

| | Item | Situação real |
|---|---|---|
| (a) | `pane_write` com **`brief`** — delegação por PONTEIRO | **GAP REAL, confirmado.** Nenhuma ocorrência de `brief` em `tools-panes.ts`. É o único dos seis com valor claro: corta tokens de boot e dá ao worker um lugar para escrever a resposta |
| (b) | `pane_whoami` | **JÁ EXISTE** — `tools-panes.ts:631` |
| (c) | `clarify` sem bloquear | **JÁ EXISTE** — `tools-domain.ts:942` |
| (d) | `media_providers` (gating por capacidade) | **JÁ EXISTE** — `nexus_media_providers`. O que falta não é a tool, é a **doutrina** de degradar (ver DEGRADAR-NUNCA-ERRAR.md) |
| (e) | `pane_close` com escopos + `autoCloseOnHandoff` | **GAP menor, confirmado** — nenhuma ocorrência |
| (f) | Busca de agente/skill **por necessidade, ranqueada** | **Parcial** — temos listagem e `nexus_model_ranking`, não ranking por necessidade |

---

## Ranqueado por impacto no dia dele

| # | Mudança | Por quê | Tamanho |
|---|---|---|---|
| 1 | **`brief` (ponteiro) no `pane_write`/`spawn`** | Todo worker hoje recebe o briefing inteiro no contexto; ponteiro corta tokens e latência de boot em TODA delegação | M |
| 2 | **`autoCloseOnHandoff` + escopos de close** | Libera vaga sozinho; hoje pane entregue segura slot da onda seguinte | P |
| 3 | **Busca por necessidade ranqueada** | Delegação escolhe agente sem despejar catálogo | M |
| 4 | `recipe_list/get` + `stack_get` | Só faz sentido depois que existirem recipes (F2) | P |
| 5 | `resume`/`delegateOnly`/`idle` no spawn | Conveniências | P |

---

## ONDE O NEXUS ESTÁ À FRENTE (para não regredir)

1. **146 × ~35 tools.** Não é volume vazio: são capacidades que o Overclock não tem.
2. **Navegação de código real**: `code_map_*` (blast radius!), `lsp_*` — o Overclock não tem nada disso.
3. **Git de primeira classe**: 11 tools. O Overclock delega para shell.
4. **Contexto governado**: `context_*` (9), draft/review/commit — máquina inteira ausente lá.
5. **Design system**: 8 tools de extração/import/publish.
6. **Memória**: `memory_recall/retain/stats`.
7. **Worktree + merge queue**: base do modo isolado, que eles não possuem.
8. **`handoff_ack`**: reconhecimento explícito, além de submit/list.
9. **`agent_invoke`**: invoca o agente; lá só lista.
10. **Sensores/segurança/validação**: `sensor_run`, `security_audit`, `validation_run`.
11. **Remoto**: `remote_spawn`, `remote_tmux_list`, bridge.

**Conclusão honesta:** o Overclock não vence em superfície — vence em **doutrina**
(degradar em vez de errar, hierarquia de tiers, paralelismo declarado) e em
**forma do hook**. Copiar as 5 tools que faltam é fácil; o que muda o produto é a
doutrina, que já está especificada nos outros documentos.
