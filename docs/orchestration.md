# Orquestração + MCP embutido (Fase 2d)

Orquestração completa (ver `ARCHITECTURE.md` §E): squads,
missões, handoffs, todos e um servidor MCP embutido com **24 tools** no
namespace `nexus_*`.

## Servidor MCP

O main process sobe um servidor HTTP MCP em `127.0.0.1:<porta aleatória>/mcp`.
Cada pane de agente recebe no spawn:

- `NEXUS_MCP_URL` / `NEXUS_MCP_TOKEN` — endpoint + bearer token individual;
- `--mcp-config <arquivo>` quando o adapter tem `quirks.mcpAutoload` (Claude);
- `NEXUS_GATE_URL` / `NEXUS_GATE_TOKEN` — endpoints do skill-gate client.

Aliases aceitos em `tools/call`: `nexus_pane_spawn` ≡ `pane_spawn` (o
`tools/list` expõe apenas os canônicos `nexus_*`).

Tools de bootstrap do orquestrador são serializadas pela prompt queue da
missão. Panes filhos com autoridade `readOnly`, como reviewers de contexto e
merge, não reservam essa fila: eles precisam inspecionar e votar enquanto o
orquestrador mantém a operação pai aguardando.

## As 24 tools

| Grupo | Tools |
|---|---|
| Panes (10) | `nexus_pane_spawn`, `nexus_pane_list`, `nexus_pane_list_providers`, `nexus_pane_read`, `nexus_pane_read_many`, `nexus_pane_write`, `nexus_pane_write_many`, `nexus_pane_close`, `nexus_pane_wait_idle`, `nexus_pane_wait_many` |
| Handoffs (2) | `nexus_handoff_submit`, `nexus_handoff_list` |
| Agentes (3) | `nexus_agent_invoke`, `nexus_agent_list`, `nexus_agent_get` |
| Missões (5) | `nexus_mission_create`, `nexus_mission_get`, `nexus_mission_list`, `nexus_mission_set_status`, `nexus_mission_spawn_pane` |
| Squad/Catálogo/Task (3) | `nexus_squad_save`, `nexus_catalog_install`, `nexus_task` |
| Todos (1) | `nexus_todo_manager` |
| Roteamento (2) | `nexus_route_task` (decide adapter/model/effort por tier+catálogo), `nexus_route_log` (auditoria read-only das últimas decisões com o motivo — "ver para crer") |
| Clarify (1) | `nexus_clarify` (pergunta única com 2-6 chips de sugestão + roteamento determinístico da resposta por id/label/número) |

## Handoffs (SQLite + IPC — melhoria sobre marker files)

Worker chama `nexus_handoff_submit({status, summary, artifacts})` → linha
durável na tabela `handoffs` → entrega automática no PTY do orquestrador da
missão **quando ele fica idle** (nunca no meio de uma resposta). O formato
legado `### NEXUS_HANDOFF v1` + JSON impresso no terminal também é
reconhecido (parser de stream com ANSI-strip).

## Skill-gate (enforcement duplo)

Agentes de squad com `allowedTools`/`allowedSkills` (null = irrestrito):

1. **Server-side (autoridade):** o servidor MCP recusa `tools/call` fora da
   allowlist do token. Sempre permitidos: `handoff_submit`, `handoff_list`,
   `ToolSearch`.
2. **Client-side (feedback):** workers gated recebem `$HOME` efêmero em
   `~/.nexus/ephemeral/<token>/` com hooks Claude (PreToolUse/PostToolUse/
   Stop) que consultam `POST /gate/*`. O Stop-gate bloqueia a saída sem
   handoff (máx. 3 tentativas).

## Squads

Schema do `squads.json` (`id`, `name`, `createdAt`,
`builtin`, `orchestratorInstructions`, `agents[]` com `category` incluindo
`orchestrator`, `effort`, allowlists). Export/import nativo de JSON no painel
de orquestração (⛭ Orch na barra).

## UI

Botão **⛭ Orch** na barra abre o painel com abas Missions / Handoffs / Todos /
Squads (timeline ao vivo, trilha de auditoria de handoffs, milestones do
`nexus_todo_manager`, export/import de squads). A tarefa em andamento aparece
como chip na barra.
