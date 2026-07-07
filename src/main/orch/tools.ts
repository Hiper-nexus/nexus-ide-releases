import type { McpToolDef } from './mcp-protocol';
import { buildPaneTools } from './tools-panes';
import { buildDomainTools } from './tools-domain';
import { buildMediaTools } from './tools-media';
import { buildFileTools } from './tools-files';
import { buildTerminalTools } from './tools-terminal';
import { buildGitTools } from './tools-git';
import { buildEditorTools } from './tools-editor';

/**
 * The MCP toolset — the orchestration tools in the
 * nexus_* namespace (docs/ARCHITECTURE.md §E.2) plus nexus extensions
 * (nexus_route_task). Bare-name aliases resolve to these
 * canonical definitions in mcp-protocol.resolveTool.
 *
 * Groups: panes (10), routing, handoffs, agents, missions, squad/catalog/task,
 * todos, preview/browser, perf, media generation (image/video/audio),
 * files (4), terminal (2), git (10), editor (4).
 */
export function buildToolset(): McpToolDef[] {
  return [
    ...buildPaneTools(),
    ...buildDomainTools(),
    ...buildMediaTools(),
    ...buildFileTools(),
    ...buildTerminalTools(),
    ...buildGitTools(),
    ...buildEditorTools(),
  ];
}
