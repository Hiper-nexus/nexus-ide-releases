import type { McpToolDef } from './mcp-protocol';
import { buildPaneTools } from './tools-panes';
import { buildDomainTools } from './tools-domain';

/**
 * The MCP toolset — the 24 Overclock v0.7.5 parity tools renamed to the
 * nexus_* namespace (docs/ARCHITECTURE.md §E.2) plus nexus extensions
 * (nexus_route_task). Aliases (overclock_* / bare names) resolve to these
 * canonical definitions in mcp-protocol.resolveTool.
 *
 * Groups: panes (10), routing (1), handoffs (2), agents (3), missions (5),
 * squad/catalog/task (3), todos (1).
 */
export function buildToolset(): McpToolDef[] {
  return [...buildPaneTools(), ...buildDomainTools()];
}
