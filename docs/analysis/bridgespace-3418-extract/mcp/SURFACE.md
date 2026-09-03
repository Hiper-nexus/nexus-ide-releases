# Superfície MCP — BridgeSpace 3.4.18

Fonte: `~/.bridgespace/bridgememory-mcp/server.cjs` (22.013 linhas, bundle CJS com
node_modules inline: ajv, @modelcontextprotocol/sdk, zod-compat, etc.) + `SKILL.md`.

## Servidor

| Item | Valor |
|------|-------|
| Runtime | Node (processo `node ~/.bridgespace/bridgememory-mcp/server.cjs`) |
| Transporte | stdio (MCP SDK) |
| Bundle | esbuild-style `__commonJS` — SDK MCP + ajv + zod embutidos |
| Hub | `.bridgememory/` descoberto subindo a partir do `cwd` (aceita override `cwd`) |
| Formato das notas | Markdown conectado por `[[Wikilink]]` |
| Experimental | usa `@modelcontextprotocol/sdk/dist/esm/experimental/tasks` (`createTask`) |

## Ferramentas expostas

| Tool | Acesso | Descrição |
|------|--------|-----------|
| `hub_status` | readonly | Estado do hub BridgeMemory (cheap, chamar primeiro) |
| `list_memories` | readonly | Lista notas do hub |
| `read_memory` | readonly | Corpo completo por título/filename/path |
| `search_memories` | readonly | Substring em títulos + corpos |
| `find_backlinks` | readonly | Quem aponta para uma nota |
| `suggest_connections` | readonly | Notas candidatas a wikilink por keywords |
| `list_orphans` | readonly | Notas sem links de entrada/saída |
| `create_memory` | writeOnly | Cria nota durável nova |
| `append_to_memory` | writeOnly | Adiciona parágrafo (preferido a update) |
| `update_memory` | writeOnly | Substitui corpo inteiro |
| `init_hub` | writeOnly | Cria `.bridgememory/` |
| `delete_memory` | writeOnly | Remove permanentemente |

Modos de acesso detectados no bundle: `readonly`, `readOnly`, `writeOnly`.

## Heurísticas de escrita (do SKILL.md)

- Escrever: decisões + motivo, estado de projetos, referências cross-system,
  receitas de fix não capturadas em commits, preferências do usuário.
- NÃO escrever: o que já está no código/README/git log, estado efêmero,
  resumos da conversa atual, best practices genéricas.
- Fluxo: search → título estável → corpo self-contained → wikilinks →
  `suggest_connections`.

## Outros hooks MCP/agente no harness

| Arquivo | Linhas | Papel |
|---------|--------|-------|
| `bin/bs-claude-hook.cjs` | 312 | Hook do Claude Code |
| `bin/bs-agent-notify.cjs` | 545 | Notificação de eventos do agente |
| `claude-hooks/` | — | Hooks globais/scopes |
| `agent-hooks/` | — | Hooks de agentes |
| `shell-integration/` (zsh/bash/pwsh) | — | Integração de shell |

## Configs MCP (superfície Tauri `mcp_*`)

Comandos Tauri que gerenciam MCPs no app:

```
mcp_import_to_source, mcp_open_source_file, mcp_read_all, mcp_save_source,
mcp_set_source_server_enabled, mcp_sync_all, mcp_upsert_source_server,
mcp_verify_connection
```

## Sessão viva (runtime)

- Processo ativo: `node ~/.bridgespace/bridgememory-mcp/server.cjs` (PID varia)
- Sessão: `~/.bridgespace/runtime.session` + `bridgememory.active`
- Estado: `history.db` (SQLite: commands, agent_sessions, denylist_patterns, meta,
  refinery_schema_history) — schemas em `../schemas/history.db.schema.sql`
