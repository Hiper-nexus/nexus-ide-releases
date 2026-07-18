/**
 * Diff hunk attribution MCP tools.
 */
import type { McpToolDef } from './mcp-protocol';
import { str } from './tool-util';
import {
  attributeHunks,
  parseUnifiedDiff,
  summarizeAttribution,
  type AgentTouch,
} from './hunk-tracker';
import { getProjectDomainStores } from './project-domain-store-registry';

const hunksAnalyze: McpToolDef = {
  name: 'nexus_hunks_analyze',
  description:
    'Parse a unified git diff and attribute hunks to mission agents (by pane ' +
    'paths) vs user/external. Pass `diff` from git diff output. Optional ' +
    'missionId uses mission pane composition for agent claims.',
  inputSchema: {
    type: 'object',
    properties: {
      diff: { type: 'string' },
      missionId: { type: 'string' },
    },
    required: ['diff'],
  },
  handler: async (args, ctx) => {
    const diff = str(args, 'diff') ?? '';
    if (diff.length > 2_000_000) {
      throw new Error('diff too large');
    }
    const hunks = parseUnifiedDiff(diff);
    const agents: AgentTouch[] = [];
    const missionId = str(args, 'missionId') ?? ctx.missionId;
    if (missionId) {
      try {
        const panes = getProjectDomainStores(ctx.scope).missionPanes.list(
          missionId,
        );
        for (const pane of panes) {
          if (pane.role === 'orchestrator') continue;
          agents.push({
            agentId: pane.agentName ?? pane.adapterId,
            adapterId: pane.adapterId,
            // Without fine-grained path logs, claim whole adapter as soft signal
            // using title as path hint if it looks like a path.
            paths: pane.title?.includes('/') ? [pane.title] : [],
            at: pane.createdAt ?? Date.now(),
          });
        }
      } catch {
        // no mission panes
      }
    }
    const attributed = attributeHunks(hunks, agents);
    return {
      hunkCount: attributed.length,
      summary: summarizeAttribution(attributed),
      hunks: attributed.map((h) => ({
        file: h.file,
        source: h.source,
        agentId: h.agentId,
        confidence: h.confidence,
        header: h.header,
      })),
    };
  },
};

export function buildHunkTools(): McpToolDef[] {
  return [hunksAnalyze];
}
