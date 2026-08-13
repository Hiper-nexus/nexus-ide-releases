import type { McpToolDef } from './mcp-protocol';
import { buildPaneTools } from './tools-panes';
import { buildDomainTools } from './tools-domain';
import { buildMediaTools } from './tools-media';
import { buildFileTools } from './tools-files';
import { buildTerminalTools } from './tools-terminal';
import { buildGitTools } from './tools-git';
import { buildPrTools } from './tools-pr';
import { buildEditorTools } from './tools-editor';
import { buildVisionTools } from './tools-vision';
import { buildContextTools } from './tools-context';
import { buildCodeMapTools } from './tools-code-map';
import { buildSyncTools } from './tools-sync';
import { buildDesignTools } from './tools-design';
import { buildDesignSystemTools } from './tools-design-system';
import { buildWorkspaceDependencyTools } from './tools-workspace-dependencies';
import { buildSecurityTools } from './tools-security';
import { buildMemoryTools } from './tools-memory';
import { buildBgTools } from './tools-bg';
import { buildPlanTools } from './tools-plan';
import { buildHunkTools } from './tools-hunks';
import { buildLspTools } from './tools-lsp';
import { buildInstrumentTools } from './tools-instruments';

/**
 * The MCP toolset — the orchestration tools in the
 * nexus_* namespace (docs/ARCHITECTURE.md §E.2) plus nexus extensions
 * (nexus_route_task). Bare-name aliases resolve to these
 * canonical definitions in mcp-protocol.resolveTool.
 *
 * Groups: panes (10), routing, handoffs, agents, missions, squad/catalog/task,
 * todos, preview/browser, perf, media generation (image/video/audio),
 * files (5), terminal (2), git (10), GitHub PR/queue (3), editor (4), design (1),
 * design systems (3), read-only security audits (2), bg tasks, plan lane, hunks.
 * LSP (4) is a bounded, no-watcher TypeScript sidecar owned by main.
 * Instruments (5) are the read-only gauges — quota, model ranking, MCP hub,
 * skills and CLI/auth inventory — a pilot consults before deciding.
 */
export function buildToolset(): McpToolDef[] {
  return [
    ...buildPaneTools(),
    ...buildDomainTools(),
    ...buildContextTools(),
    ...buildCodeMapTools(),
    ...buildSyncTools(),
    ...buildMediaTools(),
    ...buildFileTools(),
    ...buildTerminalTools(),
    ...buildBgTools(),
    ...buildPlanTools(),
    ...buildHunkTools(),
    ...buildLspTools(),
    ...buildGitTools(),
    ...buildPrTools(),
    ...buildEditorTools(),
    ...buildVisionTools(),
    ...buildDesignTools(),
    ...buildDesignSystemTools(),
    ...buildWorkspaceDependencyTools(),
    ...buildSecurityTools(),
    ...buildMemoryTools(),
    ...buildInstrumentTools(),
  ];
}
