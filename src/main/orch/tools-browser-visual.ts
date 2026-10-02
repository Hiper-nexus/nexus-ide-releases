import { z } from 'zod';
import { canJudgeBrowserVisual, judgeBrowserVisual } from '../browser/browser-visual-judgment';
import { assertMcpInvocationCurrent, type McpToolDef } from './mcp-protocol';
import { authorizePaneRef } from './tool-util';
import { consumeJevRateSlot } from '../jev/jev-rate-limit';

const argsSchema = z.object({ paneId: z.string().min(1).max(200), goal: z.string().min(1).max(2_000) }).strict();
export function buildBrowserVisualTools(): McpToolDef[] {
  return [{ name: 'nexus_browser_judge_visual', requiresConfirm: false, available: canJudgeBrowserVisual,
    description: 'Read-only Clef visual signals for a scoped Nexus browser pane: visible error, goal achieved, loading, human blocker and layout problem. Requires opt-in vision and Cloudflare credentials. Panes using the personal profile (real logins of the operator) are refused: only isolated panes can be judged. Recognized fields/secrets, frames and canvas are masked locally before egress. Advisory probabilities never authorize actions; verify success with page evidence. Accepts no URLs, paths or uploaded images.',
    inputSchema: { type: 'object', properties: { paneId: { type: 'string' }, goal: { type: 'string' } }, required: ['paneId', 'goal'], additionalProperties: false },
    handler: async (raw, ctx, invocation) => {
      const args = argsSchema.parse(raw);
      assertMcpInvocationCurrent(invocation); authorizePaneRef(ctx, args.paneId, 'read');
      if (!consumeJevRateSlot(ctx.sessionId ?? ctx.token)) throw new Error('nexus_browser_judge_visual: limite de 30 consultas/min por sessão');
      return judgeBrowserVisual({ ...args, scope: ctx.scope, signal: invocation?.signal,
        sessionId: ctx.sessionId, missionId: ctx.missionId, assertCurrentAuthority: () => assertMcpInvocationCurrent(invocation) });
    },
  }];
}
