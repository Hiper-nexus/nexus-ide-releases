import type { McpToolDef } from './mcp-protocol';
import { buildPaneTools } from './tools-panes';
import { buildDomainTools } from './tools-domain';

/**
 * The MCP toolset — the orchestration tools in the
 * nexus_* namespace (docs/ARCHITECTURE.md §E.2) plus nexus extensions
 * (nexus_route_task). Bare-name aliases resolve to these
 * canonical definitions in mcp-protocol.resolveTool.
 *
 * Groups: panes (10), routing, handoffs, agents, missions, squad/catalog/task,
 * todos, preview/browser and perf.
 */
export function buildToolset(): McpToolDef[] {
  return [...buildPaneTools(), ...buildDomainTools()];
}
