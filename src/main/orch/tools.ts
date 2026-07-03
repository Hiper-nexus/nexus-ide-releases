import type { McpToolDef } from './mcp-protocol';
import { buildPaneTools } from './tools-panes';
import { buildDomainTools } from './tools-domain';

/**
 * The 24 MCP tools — exact Overclock v0.7.5 parity, renamed to the nexus_*
 * namespace (docs/ARCHITECTURE.md §E.2). Aliases (overclock_* / bare names)
 * resolve to these canonical definitions in mcp-protocol.resolveTool.
 *
 * Groups: panes (10), handoffs (2), agents (3), missions (5),
 * squad/catalog/task (3), todos (1).
 */
export function buildToolset(): McpToolDef[] {
  return [...buildPaneTools(), ...buildDomainTools()];
}
